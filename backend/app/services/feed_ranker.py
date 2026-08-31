# File: backend/app/services/feed_ranker.py
# Purpose: TikTok-style personalized recommendation feed.
#          Given a student, produces a ranked, paginated feed of study items
#          (materials, AI study resources, curated/live YouTube + articles)
#          using a multi-stage pipeline:
#            1. candidate generation  (union of content, topical, fresh, trend)
#            2. ranking              (personalized hybrid score)
#            3. re-ranking           (diversity, exploration, seen-filter)
#          Behavioral signals come from engagement_logs, quiz_submissions,
#          micro_question_results, material_downloads and feed_interactions.
#
# Decomposition follows the standard production funnel (retrieve -> rank ->
# re-rank) used by YouTube/TikTok-style feeds. Everything runs on the existing
# Supabase data; no training required.

import math
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from app.database import get_admin_client, with_retry

# Feed sanity caps.
FEED_PAGE_DEFAULT = 10
FEED_PAGE_MAX = 20

# ── Rank weights (tunable constants) ───────────────────────────────────────
W_SEMANTIC = 0.42   # content similarity of the item to the student's topics
W_AFFINITY = 0.20   # the student's learned topic affinities / weak-spot boost
W_QUALITY  = 0.22   # item quality: engagement score, downloads, completion
W_RECENCY  = 0.10   # exponential time decay (half-life below)
W_EXPLORE  = 0.06   # exploration bonus for under-impressed items

RECENCY_HALF_LIFE_SECONDS = 7 * 24 * 3600   # ~7 days

# A quiz/micro-question average below this marks a topic as a weakness and
# gets a strong, non-linear boost in the feed.
WEAK_TOPIC_THRESHOLD = 60.0

# How long the per-student interest profile stays fresh before recompute.
PROFILE_TTL_SECONDS = 300

# Re-ranking constraints.
MMR_SOURCE_PENALTY = 0.30        # diversity discount per already-seen source type
EXPLORE_SLOT_EVERY = 8           # ~1 in 8 positions is an exploration slot
DISMISS_BLACKOUT_DAYS = 30       # suppress a dismissed item for this long


class FeedError(Exception):
    """Raised when the feed cannot be assembled."""


# ── Topic tooling (shared vocabulary with recommendation_engine) ────────────
def _tokens(text: str) -> list:
    """Lowercase, strip punctuation, split into meaningful tokens."""
    import re
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return [w for w in text.split() if len(w) > 2]


def _topic_key(title: str) -> str:
    """Map a course (or item) title to a topic bucket using the engine's rules."""
    from app.services.recommendation_engine import detect_topic
    return detect_topic(title)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Profile: what the student cares about right now ────────────────────────
class StudentProfile:
    def __init__(self, student_id: str):
        self.student_id = student_id
        self.topic_affinity = Counter()      # topic -> normalized affinity (>=0)
        self.weak_topics = []                # list of (topic, avg_score, attempts)
        self.engagement_topics = Counter()   # topic -> minutes engaged
        self.vocab = Counter()               # keyword emphasis from engaged items
        self.seen = set()                    # item keys the student already opened
        self.saved = set()                   # item keys explicitly saved
        self.dismissed = {}                  # item_key -> last dismissed timestamp (epoch s)
        self.impressions = Counter()         # item_key -> times surfaced
        self.enrolled_course_ids = set()     # courses the student is enrolled in
        self.course_titles = {}              # course_id -> title (for topic mapping)


def _aggregate_topic_affinity(admin, student_id: str) -> Counter:
    """Affinity = minutes engaged + highlight count, bucketed by topic."""
    affinities = Counter()
    lookback = (_now() - timedelta(days=30)).isoformat()
    try:
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select(
                "material_id, time_spent, idle_time, highlights"
            )
            .eq("student_id", student_id)
            .gte("created_at", lookback)
            .execute()
        )
    except Exception:
        return affinities

    material_ids = [r.get("material_id") for r in (getattr(resp, "data", []) or []) if r.get("material_id")]
    topics = _material_topics(admin, material_ids)
    for r in (getattr(resp, "data", []) or []):
        mid = r.get("material_id")
        topic = topics.get(mid, "general")
        spent = float(r.get("time_spent") or 0) - float(r.get("idle_time") or 0)
        highlights = int(r.get("highlights") or 0)
        affinities[topic] += max(0.0, spent) / 60.0 + highlights * 0.5
    return affinities


def _material_topics(admin, material_ids: list) -> dict:
    """material_id -> topic bucket, resolved through each material's course."""
    if not material_ids:
        return {}
    try:
        resp = with_retry(
            lambda c: c.table("materials")
            .select("id, course_id")
            .in_("id", list(material_ids))
            .execute()
        )
    except Exception:
        return {}
    rows = getattr(resp, "data", []) or []
    course_ids = list({r.get("course_id") for r in rows if r.get("course_id")})
    course_map = {}
    if course_ids:
        try:
            cresp = with_retry(
                lambda c: c.table("courses").select("id, title").in_("id", course_ids).execute()
            )
            course_map = {c["id"]: c.get("title", "") for c in (getattr(cresp, "data", []) or [])}
        except Exception:
            pass
    return {
        r["id"]: _topic_key(course_map.get(r.get("course_id"), ""))
        for r in rows
        if r.get("id")
    }


def _weak_topics_from_scores(admin, student_id: str) -> list:
    """Average % scored on quizzes and micro-questions, bucketed by topic."""
    bucket = defaultdict(list)
    # AI quiz submissions (course-based scores).
    try:
        resp = with_retry(
            lambda c: c.table("quiz_submissions")
            .select("score, generated_quizzes(course_id)")
            .eq("student_id", student_id)
            .execute()
        )
        course_ids = [r.get("generated_quizzes", {}).get("course_id")
                      for r in (getattr(resp, "data", []) or []) if r.get("generated_quizzes")]
        cid_set = {c for c in course_ids if c}
        titles = _course_titles(admin, cid_set)
        for r in (getattr(resp, "data", []) or []):
            cid = (r.get("generated_quizzes") or {}).get("course_id")
            title = titles.get(cid, "")
            if not title:
                continue
            bucket[_topic_key(title)].append(float(r.get("score") or 0))
    except Exception:
        pass

    # Micro-question results (material-scoped scores).
    try:
        resp = with_retry(
            lambda c: c.table("micro_question_results")
            .select("material_id, score")
            .eq("student_id", student_id)
            .execute()
        )
        mids = [r.get("material_id") for r in (getattr(resp, "data", []) or []) if r.get("material_id")]
        topics = _material_topics(admin, mids)
        for r in (getattr(resp, "data", []) or []):
            topic = topics.get(r.get("material_id"), "general")
            if float(r.get("score") or 0) > 0:
                bucket[topic].append(float(r.get("score") or 0))
    except Exception:
        pass

    weak = []
    for topic, scores in bucket.items():
        if not scores:
            continue
        avg = sum(scores) / len(scores)
        if avg < WEAK_TOPIC_THRESHOLD:
            weak.append((topic, round(avg, 1), len(scores)))
    weak.sort(key=lambda t: t[1])
    return weak


def _course_titles(admin, course_ids) -> dict:
    if not course_ids:
        return {}
    try:
        resp = with_retry(
            lambda c: c.table("courses").select("id, title").in_("id", list(course_ids)).execute()
        )
        return {c["id"]: c.get("title", "") for c in (getattr(resp, "data", []) or [])}
    except Exception:
        return {}


def _interaction_state(admin, student_id: str) -> dict:
    """Load seen/saved/dismissed/impression state from feed_interactions."""
    state = {
        "seen": set(),
        "saved": set(),
        "dismissed": {},
        "impressions": Counter(),
    }
    try:
        resp = with_retry(
            lambda c: c.table("feed_interactions")
            .select("item_type, item_key, action, created_at")
            .eq("student_id", student_id)
            .order("created_at", desc=False)
            .execute()
        )
    except Exception:
        return state

    for r in (getattr(resp, "data", []) or []):
        key = f"{r.get('item_type')}:{r.get('item_key')}"
        action = r.get("action")
        if action == "open":
            state["seen"].add(key)
        elif action == "save":
            state["saved"].add(key)
        elif action == "unsave":
            state["saved"].discard(key)
        elif action == "dismiss":
            ts = r.get("created_at")
            epoch = 0
            try:
                if hasattr(ts, "timestamp"):
                    epoch = ts.timestamp()
                elif isinstance(ts, str):
                    iso = (ts.rstrip("Z") if ts.endswith(("Z", "z")) else ts)
                    parsed = datetime.fromisoformat(iso)
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                    epoch = parsed.timestamp()
            except (TypeError, ValueError):
                epoch = 0
            state["dismissed"][key] = epoch
        elif action == "impression":
            state["impressions"][key] += 1
    return state


def build_profile(admin, student_id: str) -> StudentProfile:
    """Assemble everything the ranker needs about this student."""
    profile = StudentProfile(student_id)

    # Enrolled courses scope the candidate pool to the student's own courses.
    try:
        eresp = with_retry(
            lambda c: c.table("enrollments")
            .select("course_id")
            .eq("student_id", student_id)
            .execute()
        )
        profile.enrolled_course_ids = {
            r.get("course_id") for r in (getattr(eresp, "data", []) or []) if r.get("course_id")
        }
    except Exception:
        profile.enrolled_course_ids = set()
    profile.course_titles = _course_titles(admin, profile.enrolled_course_ids)

    weak = _weak_topics_from_scores(admin, student_id)
    profile.weak_topics = weak

    # Weak topics dominate affinity: non-linear boost so the worst areas surface.
    for topic, avg, attempts in weak:
        gap = max(0.0, WEAK_TOPIC_THRESHOLD - avg)
        boost = (gap / WEAK_TOPIC_THRESHOLD) ** 2 * (1.0 + min(attempts, 5) / 5.0)
        profile.topic_affinity[topic] = max(profile.topic_affinity.get(topic, 0), boost)

    engaged = _aggregate_topic_affinity(admin, student_id)
    profile.engagement_topics = engaged

    max_engaged = max(engaged.values()) if engaged else 0.0
    for topic, minutes in engaged.items():
        if minutes <= 0:
            continue
        norm = minutes / max_engaged if max_engaged > 0 else 0.0
        profile.topic_affinity[topic] += 0.15 * norm

    inter = _interaction_state(admin, student_id)
    profile.seen = inter["seen"]
    profile.saved = inter["saved"]
    profile.dismissed = inter["dismissed"]
    profile.impressions = inter["impressions"]

    # Emphasized vocab: pull keywords from material titles the student engaged
    # with most, so semantic scoring matches the student's own vocabulary.
    try:
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("material_id, time_spent, idle_time")
            .eq("student_id", student_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        mids = [r.get("material_id") for r in (getattr(resp, "data", []) or [])
                if r.get("material_id")]
        titles = _material_titles(admin, list(set(mids)))
        for mid in mids:
            title = titles.get(mid, "")
            if title:
                for t in _tokens(title):
                    profile.vocab[t] += 1
    except Exception:
        pass

    return profile


def _material_titles(admin, material_ids) -> dict:
    if not material_ids:
        return {}
    try:
        resp = with_retry(
            lambda c: c.table("materials").select("id, title").in_("id", material_ids).execute()
        )
        return {r["id"]: r.get("title", "") for r in (getattr(resp, "data", []) or [])}
    except Exception:
        return {}


# ── Candidate generation ───────────────────────────────────────────────────
_CANDIDATE_CACHE = {}
_CANDIDATE_CACHE_LOCK = threading.Lock()
_CANDIDATE_TTL_SECONDS = 120

# Live web candidates (YouTube + Wikipedia) are expensive to fetch, so they are
# cached per interest-topic-set briefly. The cache keeps infinite scroll stable
# and stops the same searches hammering upstream APIs on every page.
_WEB_CANDIDATE_CACHE = {}
_WEB_CANDIDATE_CACHE_LOCK = threading.Lock()
_WEB_CANDIDATE_TTL_SECONDS = 300
_WEB_RESULTS_PER_TOPIC = 4


class _Candidate:
    """A normalized, rankable feed item."""
    __slots__ = ("key", "item_type", "item_key", "title", "description", "url",
                 "source", "course_id", "course_name", "topic", "created_at",
                 "engagement_score", "downloads", "thumbnails", "content_text",
                 "channel", "similarity_score")

    def __init__(self, key, item_type, item_key, title, description="", url="",
                 source="material", course_id="", course_name="", topic="general",
                 created_at=None, engagement_score=0.0, downloads=0,
                 thumbnails=None, content_text="", channel=""):
        self.key = key
        self.item_type = item_type
        self.item_key = item_key
        self.title = title
        self.description = description
        self.url = url
        self.source = source
        self.course_id = course_id
        self.course_name = course_name
        self.topic = topic
        self.created_at = created_at
        self.engagement_score = engagement_score
        self.downloads = downloads
        self.thumbnails = thumbnails or {}
        self.content_text = content_text
        self.channel = channel
        self.similarity_score = 0.0


def _material_quality_stats(admin) -> dict:
    """material_id -> (avg engagement_score, download count)."""
    stats = defaultdict(lambda: [0.0, 0])
    try:
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("material_id, engagement_score")
            .not_.is_("material_id", "null")
            .gte("created_at", (_now() - timedelta(days=60)).isoformat())
            .execute()
        )
        for r in (getattr(resp, "data", []) or []):
            mid = r.get("material_id")
            if not mid:
                continue
            try:
                stats[mid][0] += float(r.get("engagement_score") or 0)
                stats[mid][1] += 1
            except (TypeError, ValueError):
                pass
    except Exception:
        pass

    out = {}
    for mid, (total, count) in stats.items():
        out[mid] = (total / count if count else 0.0, count)
    try:
        dresp = with_retry(
            lambda c: c.table("material_downloads")
            .select("material_id")
            .execute()
        )
        dcounts = Counter(r.get("material_id") for r in (getattr(dresp, "data", []) or []))
    except Exception:
        dcounts = Counter()
    for mid in list(out.keys()):
        score, _n = out[mid]
        out[mid] = (score, dcounts.get(mid, 0))
    return out


def _load_candidates(admin) -> list:
    """Materials + study resources + curated external pool (topic-tagged)."""
    now = time.time()
    with _CANDIDATE_CACHE_LOCK:
        cached = _CANDIDATE_CACHE.get("pool")
        if cached and now - cached[0] < _CANDIDATE_TTL_SECONDS:
            return cached[1]

    candidates = []

    # ── Internal materials ───────────────────────────────────────────────
    try:
        mresp = with_retry(
            lambda c: c.table("materials")
            .select("id, title, description, content_type, course_id, created_at")
            .execute()
        )
        mat_rows = getattr(mresp, "data", []) or []
    except Exception:
        mat_rows = []

    course_ids = {r.get("course_id") for r in mat_rows if r.get("course_id")}
    try:
        cresp = with_retry(
            lambda c: c.table("courses").select("id, title").in_("id", list(course_ids)).execute()
        )
        ctitle = {c["id"]: c.get("title", "") for c in (getattr(cresp, "data", []) or [])}
    except Exception:
        ctitle = {}

    qstats = _material_quality_stats(admin) if mat_rows else {}
    for r in mat_rows:
        mid = r.get("id")
        if not mid:
            continue
        course_name = ctitle.get(r.get("course_id"), "")
        score, downloads = qstats.get(mid, (0.0, 0))
        candidates.append(_Candidate(
            key=f"material:{mid}",
            item_type="material",
            item_key=mid,
            title=r.get("title") or "Untitled material",
            description=r.get("description") or "",
            source="material",
            course_id=r.get("course_id") or "",
            course_name=course_name,
            topic=_topic_key(course_name),
            created_at=r.get("created_at"),
            engagement_score=score,
            downloads=downloads,
        ))

    # ── Study resources (AI summaries / key points / practice questions) ──
    try:
        sresp = with_retry(
            lambda c: c.table("study_resources")
            .select("id, course_id, material_id, title, resource_type, content_text, created_at")
            .execute()
        )
        srows = getattr(sresp, "data", []) or []
    except Exception:
        srows = []

    scourse_ids = {r.get("course_id") for r in srows if r.get("course_id")}
    try:
        scresp = with_retry(
            lambda c: c.table("courses").select("id, title").in_("id", list(scourse_ids)).execute()
        )
        sc_title = {c["id"]: c.get("title", "") for c in (getattr(scresp, "data", []) or [])}
    except Exception:
        sc_title = {}

    type_sources = {
        "summary": "Summary",
        "key_points": "Key Points",
        "practice_questions": "Practice Questions",
    }
    for r in srows:
        rid = r.get("id")
        if not rid:
            continue
        rtype = r.get("resource_type") or "summary"
        cname = sc_title.get(r.get("course_id"), "")
        # Mirror the API's display titles for consistency.
        display = type_sources.get(rtype, "Study Resource")
        candidates.append(_Candidate(
            key=f"study_resource:{rid}",
            item_type="study_resource",
            item_key=rid,
            title=r.get("title") or f"{display} — {cname or 'Course'}",
            description=(r.get("content_text") or "")[:300],
            source="study_resource",
            course_id=r.get("course_id") or "",
            course_name=cname,
            topic=_topic_key(cname),
            created_at=r.get("created_at"),
            content_text=(r.get("content_text") or "")[:1500],
        ))

    # ── Curated external resources (topic-tagged YouTube + articles) ─────
    from app.services.recommendation_engine import EXTERNAL_RESOURCES
    for topic, items in EXTERNAL_RESOURCES.items():
        for idx, it in enumerate(items):
            candidates.append(_Candidate(
                key=f"external:{topic}:{idx}",
                item_type="external",
                item_key=f"{topic}:{idx}",
                title=it.get("title") or "",
                description=it.get("description") or "",
                url=it.get("url") or "",
                source=it.get("source") or "article",
                topic=topic,
                created_at=None,
                thumbnails=it.get("thumbnails") or {},
            ))

    with _CANDIDATE_CACHE_LOCK:
        _CANDIDATE_CACHE["pool"] = (now, candidates)
    return candidates


# ── Live web candidates (YouTube + Bing articles) ──────────────────────────
def _web_search_queries(profile: StudentProfile) -> list:
    """Concrete search phrases that match what the student actually studies.

    The coarse topic buckets (`_topic_key`/`detect_topic`) are too lossy to
    drive a web search — most real course titles (e.g. "Digital Electronics")
    collapse to "general", which returns junk. So we anchor the search on the
    student's enrolled course titles verbatim, plus their weak-topic phrases.
    Returns (query, topic, course_name) triples, deduplicated."""
    queries = []
    seen = set()
    for title in profile.course_titles.values():
        t = (title or "").strip()
        if not t:
            continue
        key = t.lower()
        if key in seen:
            continue
        seen.add(key)
        queries.append((t, _topic_key(t), t))
    for topic, _avg, _n in profile.weak_topics:
        human = topic.replace("_", " ")
        if human == "general" or not human:
            continue
        if human.lower() in seen:
            continue
        seen.add(human.lower())
        queries.append((human, topic, ""))
    return queries


def _load_live_web_candidates(admin, profile: StudentProfile) -> list:
    """Fetch fresh YouTube + article candidates for the student's interests so
    the For You feed is driven by the open web rather than the database.
    Queries are the student's actual enrolled course titles + weak-topic
    phrases (never the bare 'general' bucket). Returns `_Candidate` (stable
    keys per video/article), cached per query-set for TTL seconds.

    Every failure degrades gracefully: a live fetch that errors returns no
    candidates for that source, never raises. The curated EXTERNAL_RESOURCES
    pool still provides a floor when the live web is unreachable (rank_feed
    merges both)."""
    queries = _web_search_queries(profile)
    if not queries:
        return []

    cache_key = "web:" + ",".join(q for q, _t, _c in queries)
    now = time.time()
    with _WEB_CANDIDATE_CACHE_LOCK:
        cached = _WEB_CANDIDATE_CACHE.get(cache_key)
        if cached and now - cached[0] < _WEB_CANDIDATE_TTL_SECONDS:
            return cached[1]

    candidates = []

    # ── YouTube ────────────────────────────────────────────────────────────
    try:
        from app.services.youtube_service import search_youtube
    except Exception:
        search_youtube = None

    if search_youtube is not None:
        for query, topic, course_name in queries:
            try:
                items = search_youtube(query, max_results=_WEB_RESULTS_PER_TOPIC)
            except Exception:
                items = []
            for i, it in enumerate(items):
                raw_id = it["id"]
                vid = raw_id[3:] if raw_id.startswith("yt:") else raw_id
                candidates.append(_Candidate(
                    key=f"external:yt:{vid}",
                    item_type="external",
                    item_key=f"yt:{vid}",
                    title=it.get("title") or "Untitled video",
                    description=it.get("description") or "",
                    url=it.get("url") or "",
                    source="youtube",
                    topic=topic,
                    course_name=course_name,
                    created_at=it.get("published_at") or None,
                    thumbnails=it.get("thumbnails") or {},
                    channel=it.get("channel") or "",
                ))

    # ── Live web articles (Bing RSS; Wikipedia's API is IP-blocked from this
    #    deployment's network) ─────────────────────────────────────────────
    try:
        from app.services.web_article_service import search_articles
    except Exception:
        search_articles = None

    if search_articles is not None:
        for query, topic, course_name in queries:
            try:
                items = search_articles(query, max_results=_WEB_RESULTS_PER_TOPIC)
            except Exception:
                items = []
            for i, it in enumerate(items):
                raw_id = it["id"]
                web_id = raw_id[4:] if raw_id.startswith("web:") else raw_id
                candidates.append(_Candidate(
                    key=f"external:web:{web_id}",
                    item_type="external",
                    item_key=f"web:{web_id}",
                    title=it.get("title") or "Untitled article",
                    description=it.get("description") or "",
                    url=it.get("url") or "",
                    source="article",
                    topic=topic,
                    course_name=course_name,
                    created_at=it.get("published_at") or None,
                    thumbnails=it.get("thumbnails") or {},
                    channel=it.get("channel") or "",
                ))

    if candidates:
        with _WEB_CANDIDATE_CACHE_LOCK:
            _WEB_CANDIDATE_CACHE[cache_key] = (now, candidates)
        print(f"[Feed] Live web pool ready: {len(candidates)} YouTube+article candidates "
              f"for queries {[q for q, _t, _c in queries]}.")
    return candidates


def _dedupe_candidates(candidates: list) -> list:
    """Drop duplicate candidates by URL (live YouTube often matches the same
    video a curated entry already points at). Keeps the first occurrence."""
    seen_urls = set()
    unique = []
    for c in candidates:
        url = (c.url or "").strip().lower()
        if url:
            if url in seen_urls:
                continue
            seen_urls.add(url)
        unique.append(c)
    return unique


# ── Candidate scoping ──────────────────────────────────────────────────────
def _interest_topics(profile: StudentProfile) -> set:
    """Topic buckets the student actually cares about: every enrolled course's
    topic plus any weak-topic bucket from quiz/micro-question history (this
    tail covers zero-enrollment students who still have engagement data)."""
    topics = {_topic_key(title) for title in profile.course_titles.values() if title}
    topics |= {t for t, _avg, _n in profile.weak_topics}
    return topics


def _scope_pool(pool: list, profile: StudentProfile) -> list:
    """Restrict the global candidate pool to the student's own world:
    academic items (materials/study resources) only from their enrolled
    courses, external links only on interest topics. A student with no
    enrollments keeps weak-topic externals but sees no other course's items."""
    interest = _interest_topics(profile)
    enrolled = profile.enrolled_course_ids
    scoped = []
    for item in pool:
        if item.item_type in ("material", "study_resource"):
            if item.course_id in enrolled:
                scoped.append(item)
        elif item.item_type == "external":
            if item.topic in interest:
                scoped.append(item)
    return scoped


# ── Scoring ────────────────────────────────────────────────────────────────
def _parse_dt(value):
    """Normalize a Supabase timestamp (ISO string, datetime, or None) to an
    aware UTC datetime, or None if it can't be parsed (treated as timeless)."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        s = value.strip()
        if s.endswith("Z") or s.endswith("z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
        except (ValueError, TypeError):
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


def _time_decay(created_at, half_life=RECENCY_HALF_LIFE_SECONDS) -> float:
    """Exponential freshness boost; items with no parseable timestamp
    (curated/None) get 0 so the live recency signal only ever rewards genuinely
    new course content."""
    dt = _parse_dt(created_at)
    if dt is None:
        return 0.0
    age = max(0.0, (_now() - dt).total_seconds())
    return math.exp(-age / half_life)


def _semantic_similarity(profile: StudentProfile, item: _Candidate) -> float:
    """Content similarity between the item and the student's interest vector.
    Uses the engine's Sentence-BERT embeddings when available, otherwise a
    lightweight TF-IDF-ish lexical overlap over the profile vocabulary and
    weak-topic keywords."""
    from app.services.recommendation_engine import engine

    item_text = f"{item.title} {item.description} {item.course_name} {item.topic}".lower()
    query_tokens = set()
    for kw in profile.vocab:
        query_tokens.add(kw)
    for topic, _avg, _n in profile.weak_topics:
        query_tokens.add(topic.replace("_", " "))

    if engine.model is not None and engine.resource_embeddings is not None:
        try:
            # Query vector: mean of the profile's course titles + weak topics +
            # affinity buckets. Course titles are kept verbatim because they are
            # the most specific signal ("general" buckets lose the topic).
            queries = [title for title in profile.course_titles.values() if title]
            queries += [w.replace("_", " ") for w, _a, _n in profile.weak_topics]
            queries += [w.replace("_", " ") for w in profile.topic_affinity.keys()]
            if not queries:
                return _lexical_overlap(query_tokens, item_text)
            import numpy as np
            emb = engine.model.encode(queries, convert_to_numpy=True)
            qv = emb.mean(axis=0)
            qn = max(float(np.linalg.norm(qv)), 1e-9)
            iv = engine.model.encode([item_text], convert_to_numpy=True)[0]
            return max(0.0, min(1.0, float(np.dot(qv, iv) / (qn * np.linalg.norm(iv)))))

        except Exception:
            return _lexical_overlap(query_tokens, item_text)

    return _lexical_overlap(query_tokens, item_text)


def _lexical_overlap(query_tokens: set, item_text: str) -> float:
    if not query_tokens:
        return 0.0
    tokens = set(_tokens(item_text))
    if not tokens:
        return 0.0
    return len(query_tokens & tokens) / len(query_tokens)


def _quality_score(item: _Candidate) -> float:
    """0..1 item quality: engagement score, download popularity, and (for
    study resources) how complete the AI content is."""
    if item.item_type == "material":
        score, downloads = item.engagement_score, item.downloads
        return 0.55 * (min(score, 100) / 100.0) + 0.45 * min(1.0, downloads / 15.0)
    if item.item_type == "study_resource":
        return 0.35 if item.content_text else 0.15
    # external curated / youtube: pool entries are hand-picked, positionally good
    return 0.5


def _affinity_score(profile: StudentProfile, item: _Candidate) -> float:
    affinity = profile.topic_affinity.get(item.topic, 0.0)
    # Weak-topic items get the full non-linear boost (already folded in).
    return min(1.0, affinity)


def _explore_bonus(profile: StudentProfile, item: _Candidate) -> float:
    """UCB-flavored exploration: reward items the student has almost never seen.
    Log-count scales with the impression set size so the bonus stays small for
    items that have already spent their explore budget."""
    n = profile.impressions.get(item.key, 0)
    if n == 0:
        nc = max(1, len(profile.impressions))
        return min(1.0, 0.15 * math.sqrt(2 * math.log(nc + 1)))
    return 0.0


def rank_feed(admin, profile: StudentProfile, page_size: int = FEED_PAGE_DEFAULT,
              cursor: str = "") -> dict:
    """Assemble and rank one feed page. Returns {'items', 'next_cursor',
    'weak_topics'}. The cursor advances over stable key-ordered windows; each
    window is scored, filtered and re-ranked so later pages never re-shuffle
    the whole pool. Successive windows are consumed until the page fills or
    the pool is exhausted, so filtering (seen/saved/dismissed) can't cut the
    feed short."""
    # Web-first: live YouTube + Wikipedia results for the student's interest
    # topics form the heart of the feed. Curated EXTERNAL_RESOURCES (also open
    # web, not the database) act as a floor when the live web is unreachable or
    # empty. Database materials / AI study resources no longer clutter the feed.
    pool = _load_live_web_candidates(admin, profile)
    curated = [
        c for c in _scope_pool(_load_candidates(admin), profile)
        if c.item_type == "external"
    ]
    pool = _dedupe_candidates(pool + curated)
    if not pool:
        if not profile.enrolled_course_ids and not profile.weak_topics:
            raise FeedError("Enroll in a course to personalize your For You feed.")
        raise FeedError("No study items are available for this feed yet.")

    # Stable key ordering -> cursor == raw start offset into this list.
    ordered = sorted(pool, key=lambda c: c.key)

    start = 0
    if cursor:
        try:
            start = int(cursor)
        except (TypeError, ValueError):
            start = 0
    if start < 0 or start >= len(ordered):
        return {"items": [], "next_cursor": "", "weak_topics": profile.weak_topics}

    window_size = max(page_size * 4, 40)
    visited = set()
    scaled = []                 # (score, item) for all processable items
    offset = start
    now_epoch = time.time()

    while len(scaled) < page_size * 3 and offset < len(ordered):
        window = ordered[offset:offset + window_size]

        for item in window:
            if item.key in visited:
                continue
            visited.add(item.key)
            key = item.key

            if key in profile.saved:
                continue  # already saved -> lives on the Saved tab
            dismissed_at = profile.dismissed.get(key, 0)
            if dismissed_at and (now_epoch - dismissed_at) < DISMISS_BLACKOUT_DAYS * 86400:
                continue  # student said "not for me"
            if key in profile.seen and item.item_type != "external":
                continue  # skip opened items; still re-surface external links
                          # at a reduced rate for revisiting value

            semantic = _semantic_similarity(profile, item)
            affinity = _affinity_score(profile, item)
            quality = _quality_score(item)
            recency = _time_decay(item.created_at)
            explore = _explore_bonus(profile, item)

            score = (
                W_SEMANTIC * semantic
                + W_AFFINITY * affinity
                + W_QUALITY * quality
                + W_RECENCY * recency
                + W_EXPLORE * explore
            )
            item.similarity_score = round(score, 5)
            scaled.append((score, item))

        offset += window_size

    next_cursor = str(offset) if offset < len(ordered) else ""

    # Final re-ranking: sort, then apply diversity + exploration slots.
    scaled.sort(key=lambda s: s[0], reverse=True)

    # MMR-lite diversity re-rank: repeatedly pick the best remaining item,
    # applying a soft penalty to sources already represented so a single
    # course's materials can never crowd out study resources and external
    # links. Soft (not a hard block) so material-heavy pools still fill a page.
    picked = []
    picked_types = Counter()
    remaining = list(scaled)
    while remaining and len(picked) < page_size:
        best = None
        for i in range(len(remaining)):
            score, item = remaining[i]
            already = picked_types[item.item_type]
            penalty = MMR_SOURCE_PENALTY * (already / max(1, page_size)) * score
            adj = score - penalty + 1e-9 * (1 - already)  # stabilise type mixing
            if best is None or adj > best[0]:
                best = (adj, i)
        _adj, i = best
        item = remaining.pop(i)[1]
        picked.append(item)
        picked_types[item.item_type] += 1

    # Exploration slot: inject the best under-impressed item not yet shown.
    if picked and len(picked) < page_size:
        used_keys = {item.key for item in picked}
        under_impressed = [
            (expl, it) for expl, it in scaled
            if it.key not in used_keys
            and profile.impressions.get(it.key, 0) < EXPLORE_SLOT_EVERY
        ]
        if under_impressed:
            _exp, it = under_impressed[0]
            insert_at = min(EXPLORE_SLOT_EVERY - 1, len(picked))
            picked.insert(insert_at, it)

    items = [_serialize(item, profile) for item in picked]
    return {"items": items, "next_cursor": next_cursor,
            "weak_topics": profile.weak_topics}


def _serialize(item: _Candidate, profile: StudentProfile) -> dict:
    """Shape a ranked item for the frontend, including a human-readable
    'reason' explaining why it appeared (the For-You signature)."""
    saved = item.key in profile.saved
    reasons = []

    # Display label: prefer the student's own course title so weak-spot and
    # personalization copy survives the coarse topic bucketing. Only falls back
    # to a readable topic name when there's a real topic; the "general" bucket
    # (no course context) keeps a neutral phrase.
    raw_label = item.course_name or (item.topic or "").replace("_", " ").title()
    label = raw_label if (item.course_name or (item.topic and item.topic != "general")) else "this topic"

    # Weak-topic boost is the strongest personalised signal.
    for topic, avg, attempts in profile.weak_topics:
        if topic == item.topic:
            reasons.append(f"Weak spot · {label} — you scored {avg:.0f}%")
            break

    if not reasons:
        aff = profile.topic_affinity.get(item.topic, 0.0)
        if aff > 0.15:
            reasons.append(f"Because you've been studying {label}")
        elif item.item_type == "external":
            if item.source == "youtube":
                reasons.append(f"Video for your {label} course")
            elif item.source == "article":
                reasons.append(f"Reading for your {label} course")
            else:
                reasons.append("Popular pick around your topics")
        elif item.created_at and _time_decay(item.created_at) > 0.5:
            reasons.append("Freshly uploaded")
        elif item.downloads >= 10:
            reasons.append("Trending with your classmates")
        else:
            reasons.append("Matched to your courses & interests")

    source_labels = {
        "material": "Course Material",
        "study_resource": "Study Resource",
        "youtube": "YouTube",
        "article": "Article",
    }
    return {
        "key": item.key,
        "item_type": item.item_type,
        "item_key": item.item_key,
        "title": item.title,
        "description": item.description,
        "url": item.url,
        "source": item.source,
        "source_label": source_labels.get(item.source, item.source),
        "course_id": item.course_id,
        "course_name": item.course_name,
        "topic": item.topic,
        "channel": item.channel,
        "match_percent": round(min(100.0, max(0.0, item.similarity_score * 100)), 1),
        "saved": saved,
        "thumbnails": item.thumbnails or {},
        "reasons": reasons[:2],
    }


# ── Saved tab ---------------------------------------------------------------
def _saved_payloads(admin, student_id: str) -> dict:
    """item_key -> payload snapshot for the student's latest save of each item.
    The snapshot (title/url/thumbnails/reasons...) lets the Saved tab render
    live web items even after the feed moves on and the item leaves the pool."""
    payloads = {}
    try:
        resp = with_retry(
            lambda c: c.table("feed_interactions")
            .select("item_type, item_key, payload, created_at")
            .eq("student_id", student_id)
            .eq("action", "save")
            .order("created_at", desc=True)
            .execute()
        )
    except Exception:
        return payloads

    for r in (getattr(resp, "data", []) or []):
        key = f"{r.get('item_type')}:{r.get('item_key')}"
        if key not in payloads and r.get("payload"):
            payloads[key] = r["payload"]
    return payloads


def _serialize_payload(key: str, payload: dict) -> dict:
    """Rebuild a saved feed item from its persisted snapshot."""
    item_type, item_key = (key.split(":", 1) + [""])[:2]
    return {
        "key": key,
        "item_type": item_type,
        "item_key": item_key,
        "title": payload.get("title") or "Saved item",
        "description": payload.get("description") or "",
        "url": payload.get("url") or "",
        "source": payload.get("source") or "external",
        "source_label": payload.get("source_label") or "Resource",
        "course_id": payload.get("course_id") or "",
        "course_name": payload.get("course_name") or "",
        "topic": payload.get("topic") or "general",
        "channel": payload.get("channel") or "",
        "match_percent": float(payload.get("match_percent") or 0),
        "saved": True,
        "thumbnails": payload.get("thumbnails") or {},
        "reasons": payload.get("reasons") or ["Saved for later"],
    }


def saved_items(admin, profile: StudentProfile) -> list:
    """Return the student's saved feed items (most recently saved first). Live
    web items are restored from their persisted snapshot; database items fall
    back to pool resolution."""
    payloads = _saved_payloads(admin, profile.student_id)
    by_key = {c.key: c for c in _scope_pool(_load_candidates(admin), profile)}
    saved = []
    for key in profile.saved:
        payload = payloads.get(key)
        if payload:
            saved.append(_serialize_payload(key, payload))
            continue
        item = by_key.get(key)
        if item:
            saved.append(_serialize(item, profile))
    return saved