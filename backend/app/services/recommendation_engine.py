# File: backend/app/services/recommendation_engine.py
# Purpose: Semantic Resource Recommendation System.
#          Calculates cosine similarity between a student's weak concepts
#          and a resource pool (Supabase `materials` + curated external
#          study resources) to deliver personalized interventions.
#
# Data source: Supabase `materials` table + static EXTERNAL_RESOURCES.
# Sentence-BERT (all-MiniLM-L6-v2) is used when available;
# falls back to TF-IDF keyword matching when sentence-transformers is absent.

import os
import math
import time
from collections import Counter

# ── Supabase client ───────────────────────────────────────────────────────────
from app.database import get_admin_client

# How long before the resource pool is refreshed from Supabase (seconds).
RESOURCE_TTL_SECONDS = 300

# ── Curated external study resources ──────────────────────────────────────────
# Each entry maps a topic keyword to a list of verified external resources.
# `source` is used for display and `type` for the UI badge.
EXTERNAL_RESOURCES = {
    "databases": [
        {
            "title": "SQL Tutorial - Full Database Course for Beginners",
            "description": "A comprehensive video covering relational databases, SQL basics, normalization and real-world examples.",
            "url": "https://www.youtube.com/watch?v=HXV3zeQKqGY",
            "source": "youtube",
            "type": "Video",
        },
        {
            "title": "SQLBolt - Interactive SQL Lessons",
            "description": "Hands-on, browser-based SQL exercises that teach queries step by step with instant feedback.",
            "url": "https://sqlbolt.com/",
            "source": "article",
            "type": "Interactive Course",
        },
        {
            "title": "W3Schools SQL Tutorial",
            "description": "Structured reference with examples covering joins, grouping, indexes and database basics.",
            "url": "https://www.w3schools.com/sql/",
            "source": "article",
            "type": "Article",
        },
    ],
    "programming": [
        {
            "title": "POINTERS in C++ - The Cherno",
            "description": "Clear walkthrough of pointers, references and memory addresses — a common stumbling block for beginners.",
            "url": "https://www.youtube.com/watch?v=DTxHyVn0ODg",
            "source": "youtube",
            "type": "Video",
        },
        {
            "title": "Pointers in C - GeeksforGeeks",
            "description": "Written guide explaining pointer arithmetic, pointer-to-pointer and common pitfalls in C/C++.",
            "url": "https://www.geeksforgeeks.org/c/c-pointers",
            "source": "article",
            "type": "Article",
        },
        {
            "title": "C++ Full Course for Beginners - freeCodeCamp",
            "description": "End-to-end C++ course covering syntax, OOP, data structures and memory management.",
            "url": "https://www.youtube.com/watch?v=vLnPwxZdW4Y",
            "source": "youtube",
            "type": "Video",
        },
        {
            "title": "Function Pointers in C / C++ - mycodeschool",
            "description": "Focused lesson on function pointers and callbacks with concrete C examples.",
            "url": "https://www.youtube.com/watch?v=ynYtgGUNelE",
            "source": "youtube",
            "type": "Video",
        },
    ],
    "machine_learning": [
        {
            "title": "But what is a neural network? - 3Blue1Brown",
            "description": "Intuitive visual explanation of how neural networks learn, perfect for grounding core ML intuition.",
            "url": "https://www.youtube.com/watch?v=aircAruvnKk",
            "source": "youtube",
            "type": "Video",
        },
        {
            "title": "Gradient Descent and How Neural Networks Learn - 3Blue1Brown",
            "description": "Visual deep-dive into gradient descent and the intuition behind weight updates.",
            "url": "https://www.youtube.com/watch?v=IHZwWFHWa-w",
            "source": "youtube",
            "type": "Video",
        },
        {
            "title": "Backpropagation calculus - 3Blue1Brown",
            "description": "Step-by-step derivation of the backpropagation algorithm used to train networks.",
            "url": "https://www.youtube.com/watch?v=Ilg3gGewQ5U",
            "source": "youtube",
            "type": "Video",
        },
        {
            "title": "MIT 6.S191: Introduction to Neural Networks and Deep Learning",
            "description": "Academic lecture covering the foundations of deep learning, activation functions and training.",
            "url": "https://www.youtube.com/watch?v=kyQ0CRkYhy4",
            "source": "youtube",
            "type": "Lecture",
        },
        {
            "title": "3Blue1Brown - Neural Networks (lesson hub)",
            "description": "Hub page for the full neural network series with chapters and key concepts explained.",
            "url": "https://www.3blue1brown.com/lessons/neural-networks",
            "source": "article",
            "type": "Article",
        },
    ],
    "software_engineering": [
        {
            "title": "Design Patterns - Refactoring Guru",
            "description": "Clear, example-driven catalogue of design patterns with real-world use cases and trade-offs.",
            "url": "https://refactoring.guru/design-patterns",
            "source": "article",
            "type": "Article",
        },
        {
            "title": "MDN - HTTP Overview",
            "description": "Official documentation covering HTTP messages, status codes, REST-style APIs and web architecture.",
            "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP",
            "source": "article",
            "type": "Reference",
        },
        {
            "title": "Atlassian - Git Tutorials",
            "description": "Step-by-step tutorials for version control: committing, branching, merging and resolving conflicts.",
            "url": "https://www.atlassian.com/git/tutorials",
            "source": "article",
            "type": "Tutorial",
        },
    ],
    "formal_methods": [
        {
            "title": "Formal Methods - Wikipedia",
            "description": "Overview of formal specification, verification and validation approaches used in safety-critical systems.",
            "url": "https://en.wikipedia.org/wiki/Formal_methods",
            "source": "article",
            "type": "Reference",
        },
    ],
    "general": [
        {
            "title": "Computer & Technology Basics Course - freeCodeCamp",
            "description": "Absolute-beginners introduction to hardware, software, operating systems and how computers work.",
            "url": "https://www.youtube.com/watch?v=y2kg3MOk1sY",
            "source": "youtube",
            "type": "Video",
        },
        {
            "title": "What is HTTPS? - Cloudflare Learning",
            "description": "Plain-English explanation of encryption, certificates and secure HTTP communication.",
            "url": "https://www.cloudflare.com/learning/ssl/what-is-https/",
            "source": "article",
            "type": "Article",
        },
    ],
}

# Keyword rules used to detect which topic a piece of text refers to.
TOPIC_KEYWORDS = [
    ("machine_learning", ["machine learning", "neural network", "deep learning", "gradient descent",
                          "backpropagation", "supervised", "unsupervised", "classification",
                          "regression", "artificial intelligence", "ai", "tensorflow", "pytorch", "ml"]),
    ("databases", ["database", "sql", "relational", "query", "normalization", "normalisation",
                   "schema", "joins", "index", "mysql", "postgres", "db"]),
    ("programming", ["c++", "c language", "pointers", "arrays", "functions", "recursion",
                     "oops", "oop", "data structures", "linked list", "stack", "queue",
                     "python", "java", "c ", "sorting", "algorithm"]),
    ("software_engineering", ["software engineering", "design patterns", "uml", "rest", "http",
                              "git", "version control", "agile", "scrum", "software testing",
                              "requirements", "software design"]),
    ("formal_methods", ["formal methods", "formal specification", "verification", "validation",
                        "z notation", "b method", "temporal logic", "hoare", "model checking"]),
]


def detect_topic(text: str) -> str:
    """Best-effort mapping of arbitrary text to a topic key (or 'general')."""
    lowered = text.lower()
    for key, keywords in TOPIC_KEYWORDS:
        if any(kw in lowered for kw in keywords):
            return key
    return "general"


class RecommendationEngine:
    def __init__(self):
        self.model = None
        self._model_failed = False
        self.resources = []
        self.resource_embeddings = None
        self._last_refresh = 0.0
        self._load_resources()

    # ── Resource pool ─────────────────────────────────────────────────────────
    def _load_resources(self):
        """Pull published materials from Supabase and merge with external resources."""
        internal = self._load_materials_from_supabase()
        external = self._flatten_external_resources()
        self.resources = internal + external
        self._last_refresh = time.time()
        self._compute_embeddings()
        print(f"[Recommendation] Pool ready: {len(internal)} internal + {len(external)} external resources.")

    def _refresh_resources(self):
        """Reload the internal material pool if it is older than the TTL."""
        if time.time() - self._last_refresh < RESOURCE_TTL_SECONDS:
            return
        internal = self._load_materials_from_supabase()
        external = self._flatten_external_resources()
        self.resources = internal + external
        self._last_refresh = time.time()
        self._compute_embeddings()

    def _load_materials_from_supabase(self) -> list:
        try:
            admin = get_admin_client()
            resp = admin.table("materials").select("id, title, description, content_type, course_id").execute()
            rows = getattr(resp, "data", []) or []

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

            result = []
            for r in rows:
                course = course_map.get(r.get("course_id"), {})
                result.append({
                    "id": r["id"],
                    "material_id": r["id"],
                    "title": r.get("title", "Untitled"),
                    "description": r.get("description") or r.get("title") or "",
                    "topic": course.get("title", ""),
                    "course_id": r.get("course_id", ""),
                    "type": r.get("content_type") or "Material",
                    "source": "material",
                    "url": "",
                    "difficulty": "intermediate",
                })
            print(f"[Recommendation] Loaded {len(result)} materials from Supabase.")
            return result
        except Exception as e:
            print(f"[Recommendation] WARN: Could not load materials from Supabase: {e}")
            return []

    @staticmethod
    def _flatten_external_resources() -> list:
        flat = []
        for topic, items in EXTERNAL_RESOURCES.items():
            for item in items:
                entry = dict(item)
                entry["topic"] = topic
                entry["course_id"] = ""
                entry["material_id"] = ""
                entry["difficulty"] = "intermediate"
                flat.append(entry)
        return flat

    # ── Embedding model ───────────────────────────────────────────────────────
    def _ensure_model(self):
        """Lazily load the Sentence-BERT model on first use."""
        if self.model is not None or self._model_failed:
            return
        try:
            from sentence_transformers import SentenceTransformer
            self.model = SentenceTransformer("all-MiniLM-L6-v2")
            print("[Recommendation] Sentence-BERT model loaded successfully.")
            self._compute_embeddings()
        except ImportError:
            print("[Recommendation] sentence-transformers not installed. Using TF-IDF fallback.")
            self._model_failed = True
        except Exception as e:
            print(f"[Recommendation] WARN: Could not load Sentence-BERT ({e}). Using TF-IDF fallback.")
            self._model_failed = True

    def _compute_embeddings(self):
        if self.model is not None and self.resources:
            import numpy as np
            descriptions = [
                f"{r['title']} {r['description']} {r.get('topic', '')}"
                for r in self.resources
            ]
            try:
                self.resource_embeddings = self.model.encode(descriptions, convert_to_numpy=True)
                print(f"[Recommendation] Computed embeddings for {len(descriptions)} resources.")
            except Exception as e:
                print(f"[Recommendation] WARN: embedding computation failed ({e}).")
                self.resource_embeddings = None

    # ── Public API ────────────────────────────────────────────────────────────
    def get_recommendations(self, weak_concepts: str, top_n: int = 3) -> list:
        self._refresh_resources()
        if not self.resources:
            return []

        self._ensure_model()
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
