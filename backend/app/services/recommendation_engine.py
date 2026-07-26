# File: backend/app/services/recommendation_engine.py
# Purpose: Semantic Resource Recommendation System.
#          Calculates cosine similarity between a student's weak concepts
#          and course materials to deliver personalized interventions.
#
# Data source: Supabase `materials` table (not a local CSV).
# Sentence-BERT (all-MiniLM-L6-v2) is used when available;
# falls back to TF-IDF keyword matching when sentence-transformers is absent.

import os
import math
from collections import Counter

# ── Supabase client ───────────────────────────────────────────────────────────
from app.database import get_admin_client


class RecommendationEngine:
    def __init__(self):
        self.model = None
        self.resources = []
        self.resource_embeddings = None
        self._load_resources_from_supabase()
        self._load_sentence_transformer()

    def _load_resources_from_supabase(self):
        """Pull all published materials from Supabase as the recommendation pool."""
        try:
            admin = get_admin_client()
            resp = admin.table("materials").select("id, title, description, content_type, course_id").execute()
            rows = getattr(resp, "data", []) or []

            # Enrich with course titles
            course_ids = list({r["course_id"] for r in rows if r.get("course_id")})
            course_map = {}
            if course_ids:
                for cid in course_ids:
                    try:
                        cresp = admin.table("courses").select("id, title, department").eq("id", cid).limit(1).execute()
                        cdata = getattr(cresp, "data", []) or []
                        if cdata:
                            course_map[cid] = cdata[0]
                    except Exception:
                        pass

            self.resources = []
            for r in rows:
                course = course_map.get(r.get("course_id"), {})
                self.resources.append({
                    "id": r["id"],
                    "title": r.get("title", "Untitled"),
                    "description": r.get("description") or r.get("title") or "",
                    "topic": course.get("title", ""),
                    "type": r.get("content_type", ""),
                    "course_id": r.get("course_id", ""),
                    "difficulty": "intermediate",
                })

            print(f"[Recommendation] Loaded {len(self.resources)} materials from Supabase.")
        except Exception as e:
            print(f"[Recommendation] WARN: Could not load materials from Supabase: {e}")

    def _load_sentence_transformer(self):
        try:
            from sentence_transformers import SentenceTransformer
            self.model = SentenceTransformer("all-MiniLM-L6-v2")
            print("[Recommendation] Sentence-BERT model loaded successfully.")
            self._compute_embeddings()
        except ImportError:
            print("[Recommendation] sentence-transformers not installed. Using TF-IDF fallback.")
        except Exception as e:
            print(f"[Recommendation] WARN: Could not load Sentence-BERT ({e}). Using TF-IDF fallback.")

    def _compute_embeddings(self):
        if self.model is not None and self.resources:
            import numpy as np
            descriptions = [
                f"{r['title']} {r['description']} {r.get('topic', '')}"
                for r in self.resources
            ]
            self.resource_embeddings = self.model.encode(descriptions, convert_to_numpy=True)
            print(f"[Recommendation] Computed embeddings for {len(descriptions)} resources.")

    def get_recommendations(self, weak_concepts: str, top_n: int = 3) -> list:
        if not self.resources:
            return []

        if self.model is not None and self.resource_embeddings is not None:
            try:
                return self._semantic_search(weak_concepts, top_n)
            except Exception as e:
                print(f"[Recommendation] Semantic search error: {e}. Falling back to TF-IDF.")

        return self._tfidf_search(weak_concepts, top_n)

    def _semantic_search(self, query: str, top_n: int) -> list:
        import numpy as np
        query_embedding = self.model.encode(query, convert_to_numpy=True)

        norms_query = np.linalg.norm(query_embedding)
        norms_resources = np.linalg.norm(self.resource_embeddings, axis=1)

        norms_query = max(norms_query, 1e-9)
        norms_resources[norms_resources == 0] = 1e-9

        similarities = np.dot(self.resource_embeddings, query_embedding) / (norms_resources * norms_query)
        indices = np.argsort(similarities)[::-1][:top_n]

        results = []
        for idx in indices:
            r = self.resources[idx].copy()
            r["similarity_score"] = round(float(similarities[idx]), 4)
            results.append(r)
        return results

    def _tfidf_search(self, query: str, top_n: int) -> list:
        """Lightweight TF-IDF-like keyword matching (no external deps)."""
        query_tokens = self._tokenize(query)

        # Build corpus vocabulary
        corpus_tokens = [self._tokenize(f"{r['title']} {r['description']} {r.get('topic', '')}") for r in self.resources]
        doc_freq = Counter()
        for tokens in corpus_tokens:
            for t in set(tokens):
                doc_freq[t] += 1

        n_docs = max(len(corpus_tokens), 1)

        # Compute TF-IDF vectors
        def tfidf(tokens):
            tf = Counter(tokens)
            total = max(len(tokens), 1)
            vec = {}
            for t, count in tf.items():
                idf = math.log(n_docs / (1 + doc_freq.get(t, 0)))
                vec[t] = (count / total) * idf
            return vec

        query_vec = tfidf(query_tokens)
        if not query_vec:
            return []

        scored = []
        for i, tokens in enumerate(corpus_tokens):
            doc_vec = tfidf(tokens)
            # Cosine similarity
            dot = sum(query_vec.get(t, 0) * doc_vec.get(t, 0) for t in query_vec)
            q_norm = math.sqrt(sum(v * v for v in query_vec.values())) or 1e-9
            d_norm = math.sqrt(sum(v * v for v in doc_vec.values())) or 1e-9
            sim = dot / (q_norm * d_norm)
            scored.append((sim, i))

        scored.sort(key=lambda x: x[0], reverse=True)

        results = []
        for sim, idx in scored[:top_n]:
            r = self.resources[idx].copy()
            r["similarity_score"] = round(max(0.0, min(1.0, sim)), 4)
            results.append(r)
        return results

    @staticmethod
    def _tokenize(text: str) -> list:
        """Lowercase, strip punctuation, split on whitespace."""
        import re
        text = text.lower()
        text = re.sub(r"[^a-z0-9\s]", " ", text)
        return [w for w in text.split() if len(w) > 2]


engine = RecommendationEngine()
