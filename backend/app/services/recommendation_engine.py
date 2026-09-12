# File: backend/app/services/recommendation_engine.py
# Purpose: Semantic Resource Recommendation System.
#          Calculates cosine similarity between a student's weak concepts
#          and a resource pool (Supabase `materials` + curated external
#          study resources) to deliver personalized interventions.
#
# Data source: Supabase `materials` table + static EXTERNAL_RESOURCES.
# Sentence-BERT (all-MiniLM-L6-v2) is used when available;
# falls back to TF-IDF keyword matching when sentence-transformers is absent.

import math
import re
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

# ── Supabase client ───────────────────────────────────────────────────────────
from app.database import get_admin_client
from app.core.config import settings

# How long before the resource pool is refreshed from Supabase (seconds).
RESOURCE_TTL_SECONDS = 300

# Cap on how long the optional live web (YouTube) search may delay a response.
# The web call runs in a worker thread; after this many seconds the caller gets
# the pool results and the YouTube fetch keeps running in the background.
WEB_SEARCH_TIMEOUT_SECONDS = 3.0

# Small worker pool for the concurrent YouTube fetches.
_WEB_EXECUTOR = ThreadPoolExecutor(max_workers=2)

# Minimum cosine similarity a pool candidate must reach before it is surfaced.
# The two floors exist because the TF-IDF fallback and Sentence-BERT produce
# very different score ranges; the engine picks the right one for the active
# backend. Candidates below the floor are treated as irrelevant and never
# recommended (an empty surface is preferred over a mismatched one). The floor
# only ever applies to the local pool — live web results keep their rank-based
# scores.
RECOMMEND_MIN_SCORE_SEMANTIC = 0.25
RECOMMEND_MIN_SCORE_TFIDF = 0.05

# Connector/question words that pollute token-overlap checks (e.g. "the",
# "and", "from", "which"). Excluded from web relevance gating so a match must
# come from real content words, not incidental function words.
_STOPWORDS = frozenset({
    "the", "and", "for", "that", "with", "from", "what", "which", "this",
    "these", "those", "they", "them", "there", "their", "when", "where",
    "how", "why", "are", "was", "were", "has", "have", "had", "will",
    "would", "can", "could", "should", "must", "not", "but", "all", "any",
    "you", "your", "our", "its", "upon", "into", "them",
})

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
    "research": [
        {
            "title": "Research Ethics - Stanford Encyclopedia of Philosophy",
            "description": "Peer-reviewed overview of the values and requirements that govern ethical research with human participants, including informed consent.",
            "url": "https://plato.stanford.edu/entries/ethics-research/",
            "source": "article",
            "type": "Article",
        },
        {
            "title": "Informed Consent - Wikipedia",
            "description": "Explains the legal and ethical requirement that researchers obtain free and informed consent from participants before a study begins.",
            "url": "https://en.wikipedia.org/wiki/Informed_consent",
            "source": "article",
            "type": "Reference",
        },
        {
            "title": "Research Ethics - Wikipedia",
            "description": "Introduction to the principles, professional codes and standards for conducting ethical research, including participant protection.",
            "url": "https://en.wikipedia.org/wiki/Research_ethics",
            "source": "article",
            "type": "Reference",
        },
        {
            "title": "Conducting Research - Purdue OWL",
            "description": "University writing-lab guide covering research design, scholarly writing and responsible research conduct.",
            "url": "https://owl.purdue.edu/owl/research_and_citation/conducting_research.html",
            "source": "article",
            "type": "Guide",
        },
    ],
    "python": [
        {
            "title": "The Python Tutorial - docs.python.org",
            "description": "Official step-by-step Python tutorial covering core language features from first script to advanced topics.",
            "url": "https://docs.python.org/3/tutorial/",
            "source": "article",
            "type": "Reference",
        },
        {
            "title": "Learn Python - Full Course for Beginners - freeCodeCamp",
            "description": "Hands-on video course teaching Python fundamentals, functions, data structures and writing your first programs.",
            "url": "https://www.youtube.com/watch?v=rfscVS0vtbw",
            "source": "youtube",
            "type": "Video",
        },
        {
            "title": "Pygame Front Page - pygame.org",
            "description": "Official Pygame documentation, examples and API reference for building 2D games in Python.",
            "url": "https://www.pygame.org/docs/",
            "source": "article",
            "type": "Reference",
        },
        {
            "title": "Pygame: A Primer - Real Python",
            "description": "Hands-on tutorial that builds a working game with Pygame, covering sprites, input handling and the game loop.",
            "url": "https://realpython.com/pygame-a-primer/",
            "source": "article",
            "type": "Tutorial",
        },
    ],
}

# Keyword rules used to detect which topic a piece of text refers to.
TOPIC_KEYWORDS = [
    ("research", ["research ethics", "informed consent", "research methods", "research methodology",
                  "ethical", "ethics", "professional issues", "institutional review", "hipaa",
                  "health information", "participant"],
     ),
    ("python", ["python", "pygame", "pip", "import statement", "syntax error", "variable scope"]),
    ("machine_learning", ["machine learning", "neural network", "deep learning", "gradient descent",
                          "backpropagation", "supervised", "unsupervised", "classification",
                          "regression", "artificial intelligence", "ai", "tensorflow", "pytorch", "ml"]),
    ("databases", ["database", "sql", "relational", "query", "normalization", "normalisation",
                   "schema", "joins", "index", "mysql", "postgres", "db"]),
    ("programming", ["c++", "c language", "pointers", "arrays", "functions", "recursion",
                     "oops", "oop", "data structures", "linked list", "stack", "queue",
                     "python", "java", "c programming", "sorting", "algorithm"]),
    ("software_engineering", ["software engineering", "design patterns", "uml", "rest", "http",
                              "git", "version control", "agile", "scrum", "software testing",
                              "requirements", "software design"]),
    ("formal_methods", ["formal methods", "formal specification", "verification", "validation",
                        "z notation", "b method", "temporal logic", "hoare", "model checking"]),
]


def detect_topic(text: str) -> str:
    """Best-effort mapping of arbitrary text to a topic key (or 'general')."""
    lowered = " " + text.lower() + " "
    for key, keywords in TOPIC_KEYWORDS:
        for kw in keywords:
            if " " in kw:
                if kw in lowered:
                    return key
            elif re.search(r"(?<![a-z0-9])" + re.escape(kw) + r"(?![a-z0-9])", lowered):
                return key
    return "general"


class RecommendationEngine:
    def __init__(self):
        self.model = None
        self._model_failed = False
        self.resources = []
        self.resource_embeddings = None
        self._embeddings_by_id = {}
        self._last_refresh = 0.0
        self._refresh_lock = threading.Lock()
        # The resource pool and the Sentence-BERT model are loaded lazily on the
        # first request instead of at import time, keeping boot memory low on
        # small instances (Render 512 MB). A background refresh still runs.
        self._load_started = False
        self._load_lock = threading.Lock()

    # ── Resource pool ─────────────────────────────────────────────────────────
    def _load_resources(self):
        """Pull published materials from Supabase and merge with external resources."""
        internal = self._load_materials_from_supabase()
        external = self._flatten_external_resources()
        self.resources = internal + external
        self._last_refresh = time.time()
        self.resource_embeddings = self._compute_embeddings(self.resources)
        print(f"[Recommendation] Pool ready: {len(internal)} internal + {len(external)} external resources.")

    def _refresh_resources(self):
        """Reload the internal material pool. Runs in a background thread so a
        slow Supabase reload never blocks a student's quiz submission."""
        internal = self._load_materials_from_supabase()
        external = self._flatten_external_resources()
        new_resources = internal + external
        matrix = self._compute_embeddings(new_resources)
        self.resources = new_resources
        self.resource_embeddings = matrix
        self._last_refresh = time.time()
        print(f"[Recommendation] Pool refreshed: {len(internal)} internal + {len(external)} external resources.")

    def _trigger_refresh(self):
        """Kick off a pool refresh in the background without blocking the caller.
        At most one refresh runs at a time; requests keep using the last-known pool."""
        if time.time() - self._last_refresh < RESOURCE_TTL_SECONDS:
            return
        if not self._refresh_lock.acquire(blocking=False):
            return

        def _do():
            try:
                self._refresh_resources()
            except Exception as e:
                print(f"[Recommendation] Pool refresh failed: {e}")
            finally:
                self._refresh_lock.release()

        threading.Thread(target=_do, daemon=True).start()

    def _load_materials_from_supabase(self) -> list:
        try:
            admin = get_admin_client()
            resp = admin.table("materials").select("id, title, description, content_type, course_id").execute()
            rows = getattr(resp, "data", []) or []

            course_ids = list({r["course_id"] for r in rows if r.get("course_id")})
            course_map = {}
            if course_ids:
                try:
                    # Fetch all courses in a single query instead of one per material.
                    cresp = admin.table("courses").select("id, title, department").in_("id", course_ids).execute()
                    course_map = {c["id"]: c for c in (getattr(cresp, "data", []) or [])}
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
            for idx, item in enumerate(items):
                entry = dict(item)
                entry["id"] = f"ext:{topic}:{idx}"
                entry["topic"] = topic
                entry["course_id"] = ""
                entry["material_id"] = ""
                entry["difficulty"] = "intermediate"
                flat.append(entry)
        return flat

    # ── Embedding model ───────────────────────────────────────────────────────
    def _ensure_ready(self):
        """Load the resource pool (and the semantic model, if enabled) exactly
        once, lazily, on the first request. Safe for concurrent callers."""
        if self._load_started:
            return
        with self._load_lock:
            if self._load_started:
                return
            self._load_started = True
            try:
                self._load_resources()
            except Exception as e:
                print(f"[Recommendation] Pool load failed: {e}")
            self._ensure_model()

    def _ensure_model(self):
        """Lazily load the Sentence-BERT model on first use."""
        if self.model is not None or self._model_failed:
            return
        if not settings.SEMANTIC_SEARCH_ENABLED:
            print("[Recommendation] Semantic search disabled by config. Using TF-IDF.")
            self._model_failed = True
            return
        try:
            from sentence_transformers import SentenceTransformer
            self.model = SentenceTransformer("all-MiniLM-L6-v2")
            print("[Recommendation] Sentence-BERT model loaded successfully.")
            self.resource_embeddings = self._compute_embeddings(self.resources)
        except ImportError:
            print("[Recommendation] sentence-transformers not installed. Using TF-IDF fallback.")
            self._model_failed = True
        except Exception as e:
            print(f"[Recommendation] WARN: Could not load Sentence-BERT ({e}). Using TF-IDF fallback.")
            self._model_failed = True

    def _compute_embeddings(self, resources):
        """Embed only the resources not seen before and return a matrix aligned
        to `resources`. Previously-embedded resources are reused from cache, so a
        pool refresh only embeds newly uploaded materials instead of the whole pool."""
        if self.model is None or not resources:
            return None
        import numpy as np
        missing = [r for r in resources if r.get("id") not in self._embeddings_by_id]
        if missing:
            descriptions = [
                f"{r['title']} {r['description']} {r.get('topic', '')}"
                for r in missing
            ]
            try:
                new_emb = self.model.encode(descriptions, convert_to_numpy=True)
                for r, emb in zip(missing, new_emb):
                    self._embeddings_by_id[r["id"]] = emb
            except Exception as e:
                print(f"[Recommendation] WARN: embedding computation failed ({e}).")
                return None
        rows = [self._embeddings_by_id.get(r.get("id")) for r in resources]
        if rows and all(row is not None for row in rows):
            return np.stack(rows)
        return None

    # ── Public API ────────────────────────────────────────────────────────────
    def get_recommendations(self, weak_concepts: str, top_n: int = 3, include_web: bool = True,
                            enrolled_course_ids=None, exclude_materials: bool = False,
                            prefer_course_id: Optional[str] = None,
                            min_score: Optional[float] = None,
                            web_query: Optional[str] = None) -> list:
        # Lazy-load the pool + model on first use (idempotent afterwards).
        self._ensure_ready()
        # Pool refresh (if any) runs in the background — the student never waits on it.
        self._trigger_refresh()
        if not self.resources:
            return []

        # When the caller knows the student's enrollments, restrict the ranked
        # pool to their world: academic materials only from enrolled courses.
        # Curated external links are NOT topic-gated — a keyword misclassification
        # (e.g. "algorithm" appearing in a research-methods question) could
        # otherwise pin the pool to one wrong bucket and surface irrelevant
        # resources. Instead every external candidate is scored against the
        # query and the relevance floor decides what surfaces. Live web
        # (YouTube/article) results are guided by the query itself. When
        # `exclude_materials` is set, database course materials are dropped so
        # only external resources remain. When `prefer_course_id` is set, only
        # that course's materials are eligible — used by the auto-recommendation
        # path so a submission's recommendation never leaks another course's
        # material.
        allowed = None
        if enrolled_course_ids is not None:
            enrolled = set(enrolled_course_ids)
            allowed = [
                i for i, r in enumerate(self.resources)
                if (r.get("source") == "material"
                    and not exclude_materials
                    and r.get("course_id") in enrolled
                    and (prefer_course_id is None or r.get("course_id") == prefer_course_id))
            ]

        self._ensure_model()
        pool_results = []
        if self.model is not None and self.resource_embeddings is not None:
            try:
                pool_results = self._semantic_search(weak_concepts, top_n * 2, allowed=allowed)
            except Exception as e:
                print(f"[Recommendation] Semantic search error: {e}. Falling back to TF-IDF.")
        if not pool_results:
            pool_results = self._tfidf_search(weak_concepts, top_n * 2, allowed=allowed)

        # Drop near-zero-similarity candidates before anything is surfaced. The
        # floor is chosen per active backend unless the caller overrides it.
        raw_pool = pool_results
        if pool_results:
            floor = min_score
            if floor is None:
                floor = RECOMMEND_MIN_SCORE_SEMANTIC if self.model is not None else RECOMMEND_MIN_SCORE_TFIDF
            if floor:
                pool_results = [
                    r for r in pool_results
                    if float(r.get("similarity_score", 0)) >= float(floor)
                ]

        # With a course-scoped request, never leave the student empty-handed:
        # when nothing cleared the floor, fall back to the best candidate from
        # the submission's own course — it is by construction the right topic.
        if not pool_results and prefer_course_id is not None:
            fallback = [
                r for r in raw_pool
                if r.get("source") == "material"
                and r.get("course_id") == prefer_course_id
            ]
            if fallback:
                best = sorted(
                    fallback[:3],
                    key=lambda r: (float(r.get("similarity_score", 0)), r.get("title", "")),
                    reverse=True,
                )[0]
                pool_results = [best]

        # Live web (YouTube + Wikipedia) search is optional and network-bound.
        # It runs in a worker thread and is bounded by WEB_SEARCH_TIMEOUT_SECONDS
        # so a slow upstream call never stacks on top of the pool search latency.
        # The fast path (e.g. during quiz submission) can skip it entirely.
        results = pool_results
        if include_web:
            # A focused query searches the web far better than the full pool
            # text (merging many missed questions dilutes every engine and
            # invites storefront spam, e.g. Bing returning an online tool shop
            # for "tools free reference management application …"). The caller
            # picks the most topically informative missed question for this.
            web_text = (web_query or "").strip() or weak_concepts
            yt_future = _WEB_EXECUTOR.submit(self._youtube_recommendations, web_text, top_n)
            art_future = _WEB_EXECUTOR.submit(self._article_recommendations, web_text, top_n)
            try:
                youtube_results = yt_future.result(timeout=WEB_SEARCH_TIMEOUT_SECONDS)
            except Exception:
                youtube_results = []
            try:
                article_results = art_future.result(timeout=WEB_SEARCH_TIMEOUT_SECONDS)
            except Exception:
                article_results = []
            web_results = self._confirm_web_relevance(web_text, youtube_results + article_results)
            results = self._dedupe(pool_results + web_results)
        # Auto-recommendation path safety net: recommendations are always
        # EXTERNAL study resources, never the database course materials the
        # student already owns. When the live-web relevance gate empties the
        # results, the hand-verified curated externals ranked against the exact
        # missed content are surfaced (topical without leaking DB materials);
        # the detected-topic bucket is the final non-empty fallback.
        if not results and exclude_materials:
            fallback_query = (weak_concepts or "").strip() or (web_text if include_web else "")
            topic = detect_topic(web_text if include_web else weak_concepts)
            # External-only: rank the hand-verified curated externals against
            # the missed content so the fallback is topical without ever
            # leaking database course materials.
            ext_indices = [i for i, r in enumerate(self.resources) if r.get("source") != "material"]
            matched = []
            if fallback_query and ext_indices:
                if self.model is not None and self.resource_embeddings is not None:
                    candidates = self._semantic_search(fallback_query, top_n=max(top_n, 3), allowed=ext_indices)
                else:
                    candidates = self._tfidf_search(fallback_query, top_n=max(top_n, 3), allowed=ext_indices)
                floor = RECOMMEND_MIN_SCORE_SEMANTIC if self.model is not None else RECOMMEND_MIN_SCORE_TFIDF
                for r in candidates[:top_n]:
                    if r.get("similarity_score", 0.0) >= floor:
                        matched.append(r)
            results.extend(matched[:top_n])
            if not results:
                fallback_items = [
                    dict(r) for r in self.resources
                    if r.get("source") != "material" and r.get("topic") == topic
                ]
                if not fallback_items:
                    fallback_items = [
                        dict(r) for r in self.resources if r.get("source") != "material"
                    ]
                for r in fallback_items[:top_n]:
                    r["similarity_score"] = round(float(RECOMMEND_MIN_SCORE_TFIDF), 4)
                    results.append(r)

        results.sort(key=lambda r: r.get("similarity_score", 0), reverse=True)
        return results[:top_n]

    @staticmethod
    def _dedupe(items: list) -> list:
        seen = set()
        unique = []
        for r in items:
            key = " ".join((r.get("title") or "").lower().split())
            if not key or key in seen:
                continue
            seen.add(key)
            unique.append(r)
        return unique

    def _confirm_web_relevance(self, query: str, items: list) -> list:
        """Verify live web results actually relate to the query before they are
        surfaced. Search engines sometimes return junk (verified: a research-tools
        query returned "English-French Dictionary WordReference.com"), so every
        web item is re-scored against the query with the active backend and the
        fake rank-based score is replaced by the real similarity. Below-floor
        items are dropped."""
        if not items:
            return []
        retained = []
        if self.model is not None and self.resource_embeddings is not None:
            try:
                import numpy as np
                query_embedding = self.model.encode(query, convert_to_numpy=True)
                texts = [
                    "{} {}".format(it.get("title", ""), it.get("description", ""))
                    for it in items
                ]
                embs = self.model.encode(texts, convert_to_numpy=True)
                qn = max(np.linalg.norm(query_embedding), 1e-9)
                norms = np.linalg.norm(embs, axis=1)
                norms[norms == 0] = 1e-9
                sims = np.dot(embs, query_embedding) / (norms * qn)
                for it, sim in zip(items, sims):
                    sim = float(sim)
                    if sim >= RECOMMEND_MIN_SCORE_SEMANTIC:
                        it["similarity_score"] = round(sim, 4)
                        retained.append(it)
                return retained
            except Exception as e:
                print(f"[Recommendation] Web relevance check failed ({e}); keeping rank scores.")
                return items

        # TF-IDF backend: score against the same corpus vocabulary used for the pool.
        query_tokens = self._tokenize(query)
        if not query_tokens:
            return items
        meaningful_query = set(query_tokens) - _STOPWORDS
        if not meaningful_query:
            return items
        for it in items:
            tokens = self._tokenize(f"{it.get('title', '')} {it.get('description', '')}")
            if not tokens:
                continue
            meaningful_item = set(tokens) - _STOPWORDS
            overlap = sum(1 for t in meaningful_query if t in meaningful_item)
            score = overlap / max(len(meaningful_query), 1)
            # YouTube items already carry Google's own relevance ranking, so a
            # single content-word overlap (stopwords excluded) is enough for
            # them. Free-web article results keep the stricter two-token gate
            # that filters out verified storefront/dictionary spam.
            src = (it.get("source") or "").lower()
            min_overlap = 1 if src == "youtube" else 2
            if overlap >= min_overlap and score >= RECOMMEND_MIN_SCORE_TFIDF:
                it["similarity_score"] = round(max(0.0, min(1.0, score)), 4)
                retained.append(it)
        return retained

    def _youtube_recommendations(self, query: str, top_n: int) -> list:
        """Fetch live YouTube videos for the weak concept and map them into the
        shared resource format so they mix cleanly with pool results."""
        from app.services.youtube_service import search_youtube

        items = search_youtube(query, max_results=top_n)
        if not items:
            return []

        topic = detect_topic(query)
        results = []
        for i, item in enumerate(items):
            # Rank-based relevance score; Google's own ranking carries the signal.
            score = max(0.10, 0.95 - i * 0.06)
            results.append({
                "id": item["id"],
                "material_id": "",
                "course_id": "",
                "title": item["title"],
                "description": item["description"],
                "url": item["url"],
                "channel": item["channel"],
                "thumbnails": item["thumbnails"],
                "topic": topic,
                "source": "youtube",
                "type": "Video",
                "difficulty": "intermediate",
                "similarity_score": round(score, 4),
            })
        return results

    def _article_recommendations(self, query: str, top_n: int) -> list:
        """Fetch live web articles for the weak concept and map them into the
        shared resource format so they mix cleanly with pool + YouTube
        results."""
        from app.services.web_article_service import search_articles

        items = search_articles(query, max_results=top_n)
        if not items:
            return []

        topic = detect_topic(query)
        results = []
        for i, item in enumerate(items):
            # Rank-based relevance score; the search engine's ranking carries
            # the signal, weighted slightly below YouTube to keep video first.
            score = max(0.08, 0.88 - i * 0.06)
            results.append({
                "id": item["id"],
                "material_id": "",
                "course_id": "",
                "title": item["title"],
                "description": item["description"],
                "url": item["url"],
                "source": "article",
                "type": "Article",
                "difficulty": "intermediate",
                "topic": topic,
                "channel": item.get("channel") or "",
                "thumbnails": item["thumbnails"],
                "similarity_score": round(score, 4),
            })
        return results

    def _semantic_search(self, query: str, top_n: int, allowed=None) -> list:
        import numpy as np
        if allowed is not None and not allowed:
            return []
        query_embedding = self.model.encode(query, convert_to_numpy=True)

        if allowed is None:
            embed_rows = self.resource_embeddings
            indices = np.arange(len(self.resources))
        else:
            indices = np.array(allowed, dtype=int)
            embed_rows = self.resource_embeddings[indices]

        query_norm = np.linalg.norm(query_embedding)
        norms_resources = np.linalg.norm(embed_rows, axis=1)

        query_norm = max(query_norm, 1e-9)
        norms_resources[norms_resources == 0] = 1e-9

        similarities = np.dot(embed_rows, query_embedding) / (norms_resources * query_norm)
        order = np.argsort(similarities)[::-1][:top_n]

        results = []
        for j in order:
            r = self.resources[int(indices[j])].copy()
            r["similarity_score"] = round(float(similarities[j]), 4)
            results.append(r)
        return results

    def _tfidf_search(self, query: str, top_n: int, allowed=None) -> list:
        """Lightweight TF-IDF-like keyword matching (no external deps)."""
        if allowed is not None and not allowed:
            return []
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

        candidates = range(len(self.resources)) if allowed is None else allowed
        scored = []
        for i in candidates:
            tokens = corpus_tokens[i]
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
