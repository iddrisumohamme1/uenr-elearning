# File: backend/app/routes/recommendations.py
# Purpose: Returns semantic resource recommendations for at-risk students.
#          Accepts a weak concept description and returns top-N matched learning
#          materials, OR auto-detects weak topics from the student's quiz history.

import re
import threading
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from app.core.security import require_role, get_current_user
from app.database import get_admin_client, with_retry
from app.services.material_content import material_text_from_url
from app.services.quiz_generator import quiz_ai
from app.services.recommendation_engine import engine, detect_topic
from app.services import feed_ranker

router = APIRouter(prefix="/api/recommendations", tags=["recommendations"])

# Score below this (as a percentage) marks a topic as a weakness.
WEAK_SCORE_THRESHOLD = 60.0

# A quiz score below this triggers an automatic resource recommendation that is
# surfaced to the student as a sidebar notification. Students scoring below
# 50% are clearly struggling and are redirected to supplementary external
# study resources (videos, articles, curated links) — not course materials
# they already have.
RECOMMEND_THRESHOLD = 50.0

# A theory question scored below this (on a 0..1 grading scale) counts as "could
# not answer" when auto-recommendations are built from a quiz/assignment.
THEORY_WEAK_SCORE = 0.7

TOPIC_LABELS = {
    "machine_learning": "Machine Learning",
    "databases": "Databases",
    "programming": "Programming & Data Structures",
    "software_engineering": "Software Engineering",
    "formal_methods": "Formal Methods",
    "general": "General Topics",
}


class RecommendationRequest(BaseModel):
    student_id: Optional[str] = None
    weak_concepts: str
    top_n: Optional[int] = 3


class RecommendationResponse(BaseModel):
    student_id: str
    weak_concepts: str
    recommendations: List[dict]


class WeakTopic(BaseModel):
    topic: str
    label: str
    avg_score: float
    attempts: int


class AutoRecommendationResponse(BaseModel):
    weak_topics: List[WeakTopic]
    recommendations: List[dict]


class AskTutorRequest(BaseModel):
    question: str
    course_id: Optional[str] = None


class FeedTrackRequest(BaseModel):
    item_type: str
    item_key: str
    action: str
    payload: Optional[dict] = None


def _decorate_recommendations(results: list, query: str) -> list:
    """Attach a human-readable reason + percentage to each recommendation."""
    short = " ".join(query.split())[:80] or query
    decorated = []
    for r in results:
        item = dict(r)
        item["reason"] = f"Recommended for: \u201c{short}\u201d"
        item["similarity_percent"] = round(float(item.get("similarity_score", 0)) * 100, 1)
        decorated.append(item)
    return decorated


def _enrolled_course_ids(admin, student_id: str) -> list:
    """Course ids the student is currently enrolled in — scopes every
    recommendation to the student's own courses. Never raises."""
    try:
        resp = with_retry(
            lambda c: c.table("enrollments")
            .select("course_id")
            .eq("student_id", student_id)
            .execute()
        )
        return [r["course_id"] for r in (getattr(resp, "data", []) or []) if r.get("course_id")]
    except Exception:
        return []


def _scope_notification_items(items: list, material_course: dict, enrolled_ids: set) -> list:
    """Filter stored notification rows down to what the student can actually use.
    ``material_course`` maps lowercased material title -> course_id. Material
    rows are kept only if their resource resolves to a material in an enrolled
    course; other sources (youtube/article) are kept only when their stored
    course context is an enrolled course. Anything unverifiable is hidden —
    nothing is deleted."""
    scoped = []
    for n in items:
        src = (n.get("resource_source") or "").strip().lower()
        if src == "material":
            title = (n.get("resource_title") or "").strip().lower()
            cid = material_course.get(title)
            if cid and cid in enrolled_ids:
                scoped.append(n)
        else:
            cid = n.get("course_id") or ""
            if cid in enrolled_ids:
                scoped.append(n)
    return scoped


def collect_missed_questions(
    obj_qs: list,
    submitted_obj: list,
    theory_qs: list,
    theory_answers: list,
    theory_scores: list,
    max_items: int = 6,
) -> list:
    """Return the question texts a student could not answer.

    Objective: a submitted index that is missing, None, or not equal to the
    stored correct index. Theory: a blank answer, or an AI score below
    ``THEORY_WEAK_SCORE``. Capped at ``max_items`` so the semantic
    recommendation query stays bounded.
    """
    missed = []
    submitted_obj = submitted_obj or []
    for i, q in enumerate(obj_qs):
        if i >= len(submitted_obj) or submitted_obj[i] is None:
            missed.append(q.get("question") or "")
        elif q.get("correct_answer_index") is not None and submitted_obj[i] != q.get("correct_answer_index"):
            missed.append(q.get("question") or "")

    theory_answers = theory_answers or []
    theory_scores = theory_scores or []
    for i, q in enumerate(theory_qs):
        ans = theory_answers[i] if i < len(theory_answers) else ""
        score = theory_scores[i] if i < len(theory_scores) else 0.0
        if not (ans or "").strip() or float(score or 0) < THEORY_WEAK_SCORE:
            missed.append(q.get("question") or "")

    cleaned = []
    for text in missed:
        text = (text or "").strip()
        if text and text not in cleaned:
            cleaned.append(text)
        if len(cleaned) >= max_items:
            break
    return cleaned


# Multiple-choice phrasings that carry no topical information. Strip them before
# the text is sent to the semantic pool or a live web search, so a query like
# "Which of the following tools is used for plagiarism detection?" becomes the
# keyword-rich "tools used for plagiarism detection".
_QUERY_BOILERPLATE_PATTERNS = [
    r"\bwhich one of the following\b",
    r"\bwhich of the following\b",
    r"\bwhich of these\b",
    r"\bwhich statement\b",
    r"\bwhich is\b",
    r"\bwhich\b",
    r"\bwhat is\b",
    r"\bwhat are\b",
    r"\bwhat does\b",
    r"\bwhat\b",
    r"\bwhy is\b",
    r"\bwhy does\b",
    r"\bwhy do\b",
    r"\bwhy\b",
    r"\bhow does\b",
    r"\bhow is\b",
    r"\bhow do\b",
    r"\bhow\b",
    r"\bchoose the correct\b",
    r"\bchoose the best\b",
    r"\bselect the correct\b",
    r"\bselect the best\b",
    r"\bselect the right\b",
    r"\bchoose\b",
    r"\bselect\b",
    r"\bthe correct answer is\b",
    r"\ball of the following\b",
    r"\bstate whether\b",
    r"\bexplain\b",
    r"\bdefine\b",
    r"\bdescribe\b",
    r"\bdiscuss\b",
    r"\bdistinguish between\b",
    r"\bcompare and contrast\b",
    r"\bidentify\b",
    r"\bis primarily used for\b",
    r"\bis mainly used for\b",
    r"\bis best described as\b",
    r"\bis known for its\b",
    r"\bis specifically designed for\b",
    r"\bis commonly used in\b",
    r"\bis commonly used for\b",
    r"\bis generally used for\b",
    r"\bis used for\b",
    r"\bis used in\b",
    r"\brefers to\b",
    r"\bis considered\b",
    r"\bis defined as\b",
    r"\bis known as\b",
    r"\bis called\b",
    r"\bis a type of\b",
    r"\bis an example of\b",
    r"\bknown as\b",
    r"\bis the\b",
    r"\bis a\b",
    r"\bis an\b",
    r"\bthe concept of\b",
    r"\bthe process of\b",
    r"\bthe following\b",
]

_QUERY_BOILERPLATE_REGEX = re.compile(
    "|".join(_QUERY_BOILERPLATE_PATTERNS), re.IGNORECASE
)
# Clean up punctuation orphans left behind by boilerplate removal, e.g.
# "Overleaf is primarily used for:" -> "Overleaf :" -> "Overleaf".
_QUERY_TRIM_REGEX = re.compile(r"\s*[:.,]\s*(;|\b|$)")
_QUERY_MAX_LENGTH = 140


def _clean_search_query(raw_query: str, weak_concept: str = "") -> str:
    """Scrub MCQ boilerplate from the recommendation search text and trim it to a
    bounded, keyword-rich length so semantic scoring and live web search both
    work well. Falls back to the original text when nothing meaningful remains
    and appends the course context when the cleaned query is very short."""
    text = _QUERY_BOILERPLATE_REGEX.sub(" ", (raw_query or "").strip())
    text = " ".join((text or "").split())
    text = _QUERY_TRIM_REGEX.sub("", text)
    text = " ".join((text or "").split())
    text = text.strip(" ,.;:!?'\"-")
    if not text:
        text = (raw_query or "").strip()
    if len(text) < 40:
        context = (weak_concept or "").strip()
        if context:
            text = f"{text}; {context}" if text else context
    if len(text) > _QUERY_MAX_LENGTH:
        text = text[:_QUERY_MAX_LENGTH].rstrip(" ;,.")
    return text


def _pick_web_query(missed_questions: list, weak_concept: str = "") -> str:
    """Choose the single most topically informative missed question to send to
    the live web search. Merging many questions into one query dilutes every
    search engine (verified: Bing returned an online tool store for a merged
    research-tools query), so one focused question is searched instead. The
    most informative question is the one with the most distinct content words
    after MCQ boilerplate is stripped."""
    best = ""
    best_score = 0
    for q in missed_questions or []:
        cleaned = _clean_search_query(q, "")
        words = [w for w in re.split(r"[^a-z0-9]+", cleaned.lower()) if len(w) >= 3]
        score = len(set(words))
        if score > best_score:
            best, best_score = cleaned, score
    if not best and missed_questions:
        best = _clean_search_query(missed_questions[0], "")
    if not best:
        best = (weak_concept or "").strip()
    best = best[:90]
    context = (weak_concept or "").strip()
    if context and len(best.split()) < 3:
        best = f"{best} {context}"
    return best[:100]


def record_auto_recommendation(
    student_id: str,
    course_id: str,
    submission_id: str,
    score: float,
    weak_concept: str,
    top_n: int = 2,
    include_web: bool = True,
    query: str = "",
    missed_summary: str = "",
) -> list:
    """
    Generate resource recommendations for a weak concept and store them as
    unread notifications for the student. Returns the created notification rows.
    Never raises — a failing recommendation must not break quiz submission.

    ``weak_concept`` names the weakness for storage/display; when ``query`` is
    given (e.g. the text of the questions the student could not answer) the
    engine searches on that instead, so recommendations match the exact missed
    content. ``include_web`` is on by default so a struggling student gets live
    study resources (YouTube/short-answer articles) found from their missed
    questions, not just the small curated pool. The query is scrubbed of MCQ
    boilerplate before searching so engines get a clean, keyword-rich text.
    Database course materials are always excluded from the auto-recommendation
    output: the surfaced content is external study content (live videos and
    articles, or the hand-verified curated links ranked against the missed
    questions when the live web is unreachable). Only students scoring below
    RECOMMEND_THRESHOLD (50%) are redirected.
    """
    try:
        admin = get_admin_client()
        raw_text = (query or "").strip() or weak_concept
        search_text = _clean_search_query(raw_text, weak_concept)
        missed_qs = [q.strip() for q in (query or "").split(";") if q.strip()]
        web_text = _pick_web_query(missed_qs or [raw_text], weak_concept)
        results = engine.get_recommendations(
            weak_concepts=search_text,
            top_n=top_n,
            include_web=include_web,
            web_query=web_text,
            enrolled_course_ids=_enrolled_course_ids(admin, student_id),
            exclude_materials=True,
        )
    except Exception as e:
        print(f"[Recommendation] Auto-recommendation failed: {e}")
        return []

    if missed_summary:
        note = f"Missed: \u201c{missed_summary[:140]}\u201d (score {score}%)"
    else:
        note = f"Recommended for: \u201c{weak_concept}\u201d (score {score}%)"

    created = []
    for r in results:
        title = (r.get("title") or "").strip()
        if not title:
            continue
        try:
            resp = with_retry(
                lambda c, r=r: c.table("recommendation_notifications").insert({
                    "student_id": student_id,
                    "course_id": course_id,
                    "submission_id": submission_id,
                    "score": score,
                    "weak_concept": weak_concept,
                    "resource_title": title,
                    "resource_url": r.get("url") or "",
                    "resource_source": r.get("source") or "material",
                    "resource_type": r.get("type") or "Resource",
                    "resource_description": r.get("description") or "",
                    "reason": note,
                }).execute()
            )
            created.extend(getattr(resp, "data", []) or [])
        except Exception as e:
            print(f"[Recommendation] Failed to store notification: {e}")
    return created


def _dedupe(results: list) -> list:
    seen = set()
    unique = []
    for r in results:
        key = r.get("id") or r.get("url")
        if key in seen:
            continue
        seen.add(key)
        unique.append(r)
    return unique


@router.post("/", response_model=RecommendationResponse)
def get_recommendations(payload: RecommendationRequest, user: dict = Depends(require_role("student"))):
    """
    Accepts a student's weak concept description and uses Sentence-BERT cosine
    similarity to return the top N contextually relevant learning materials.

    Example weak concepts:
      - "I don't understand database normalization and SQL joins"
      - "Confused about pointers and memory allocation in C++"
      - "Neural network backpropagation is unclear"
    """
    if not payload.weak_concepts.strip():
        raise HTTPException(status_code=400, detail="Weak concepts description cannot be empty.")

    top_n = max(1, min(payload.top_n or 3, 10))  # Clamp between 1–10

    try:
        admin = get_admin_client()
        results = engine.get_recommendations(
            weak_concepts=payload.weak_concepts,
            top_n=top_n,
            enrolled_course_ids=_enrolled_course_ids(admin, user["id"]),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Recommendation engine error: {e}")

    student_id = payload.student_id or user["id"]
    return RecommendationResponse(
        student_id=student_id,
        weak_concepts=payload.weak_concepts,
        recommendations=_decorate_recommendations(results, payload.weak_concepts),
    )


@router.post("/ask")
def ask_tutor(payload: AskTutorRequest, user: dict = Depends(require_role("student"))):
    """
    Answers a student's question with the AI tutor. When ``course_id`` is given,
    the answer is grounded in that course's material content.
    """
    question = (payload.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    material_context = ""
    if payload.course_id:
        try:
            admin = get_admin_client()
            mat_resp = with_retry(
                lambda c: c.table("materials")
                .select("title, description, content_url, content_type")
                .eq("course_id", payload.course_id)
                .execute()
            )
            parts = []
            for mat in getattr(mat_resp, "data", []) or []:
                text = f"{mat.get('title', '')} - {mat.get('description', '')}".strip()
                content_url = mat.get("content_url") or ""
                content_type = (mat.get("content_type") or "").lower()
                if content_url:
                    extracted = material_text_from_url(content_url, content_type)
                    if extracted:
                        text = f"{text}\n{extracted}"
                if text.strip():
                    parts.append(text)
            material_context = "\n\n".join(parts)[:15000]
        except Exception as e:
            print(f"[recommendations] Could not load course material context: {e}")

    answer = quiz_ai.ask_tutor(question, material_context)
    if not answer:
        raise HTTPException(status_code=503, detail="AI tutor is unavailable. Please try again later.")

    return {"status": "success", "answer": answer}


@router.get("/auto", response_model=AutoRecommendationResponse)
def auto_recommendations(user: dict = Depends(require_role("student"))):
    """
    Automatically detects the student's weak topics from their quiz history and
    returns targeted recommendations for each detected weak topic.
    """
    admin = get_admin_client()

    try:
        quiz_resp = with_retry(
            lambda c: c.table("quiz_results").select(
                "score, total_questions, quizzes(course_id)"
            ).eq("student_id", user["id"]).execute()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not load quiz history: {e}")

    quiz_rows = getattr(quiz_resp, "data", []) or []

    # Map course_id -> title for topic detection (single batched query).
    course_ids = list({r.get("quizzes", {}).get("course_id") for r in quiz_rows
                       if r.get("quizzes")})
    course_map = {}
    if course_ids:
        try:
            cresp = with_retry(
                lambda c: c.table("courses").select("id, title").in_("id", course_ids).execute()
            )
            course_map = {c["id"]: c.get("title", "") for c in (getattr(cresp, "data", []) or [])}
        except Exception:
            pass

    # Aggregate normalized scores per detected topic.
    from collections import defaultdict
    topic_stats = defaultdict(list)
    for r in quiz_rows:
        quiz = r.get("quizzes") or {}
        cid = quiz.get("course_id")
        title = course_map.get(cid, "")
        if not title:
            continue
        score = r.get("score", 0)
        total = r.get("total_questions") or 0
        if total <= 0:
            continue
        topic = detect_topic(title)
        topic_stats[topic].append(score / total * 100.0)

    weak_topics = []
    for topic, scores in topic_stats.items():
        avg_score = round(sum(scores) / len(scores), 1)
        if avg_score < WEAK_SCORE_THRESHOLD:
            weak_topics.append(WeakTopic(
                topic=topic,
                label=TOPIC_LABELS.get(topic, topic),
                avg_score=avg_score,
                attempts=len(scores),
            ))

    weak_topics.sort(key=lambda t: t.avg_score)

    # Fetch targeted resources for each weak topic. include_web=False keeps page
    # load fast: it only searches the local pool (no live YouTube round-trips
    # per topic), matching the fast path used right after a quiz submission.
    all_recs = []
    for wt in weak_topics:
        try:
            results = engine.get_recommendations(
                weak_concepts=wt.label, top_n=4, include_web=False,
                enrolled_course_ids=_enrolled_course_ids(admin, user["id"]),
            )
            all_recs.extend(_decorate_recommendations(results, wt.label))
        except Exception:
            pass

    return AutoRecommendationResponse(
        weak_topics=weak_topics,
        recommendations=_dedupe(all_recs)[:10],
    )


@router.get("/resources")
def list_all_resources(user: dict = Depends(get_current_user)):
    """Returns all available learning resources in the recommendation pool."""
    engine._ensure_ready()
    if not engine.resources:
        raise HTTPException(status_code=404, detail="No learning resources available.")
    return {"total": len(engine.resources), "resources": engine.resources}


@router.get("/notifications")
def get_recommendation_notifications(user: dict = Depends(require_role("student"))):
    """
    Returns the student's unread auto-generated resource recommendations. The
    sidebar reads this endpoint to show an unread badge on the Recommendations
    link after login.
    """
    admin = get_admin_client()
    try:
        resp = with_retry(
            lambda c: c.table("recommendation_notifications")
            .select(
                "id, course_id, score, weak_concept, resource_title, resource_url, "
                "resource_source, resource_type, resource_description, reason, created_at"
            )
            .eq("student_id", user["id"])
            .eq("is_read", False)
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not load recommendations: {e}")

    items = getattr(resp, "data", []) or []
    # Scope stored rows to the student's enrolled courses so legacy messages
    # (generated before enrollment scoping) can't surface other courses' material.
    enrolled = set(_enrolled_course_ids(admin, user["id"]))
    if enrolled and items:
        material_course = {}
        try:
            mresp = with_retry(
                lambda c: c.table("materials").select("title, course_id").execute()
            )
            for m in (getattr(mresp, "data", []) or []):
                key = (m.get("title") or "").strip().lower()
                if key and not material_course.get(key):
                    material_course[key] = m.get("course_id")
        except Exception:
            pass
        items = _scope_notification_items(items, material_course, enrolled)

    return {"unread_count": len(items), "items": items}


@router.post("/notifications/read")
def mark_recommendations_read(user: dict = Depends(require_role("student"))):
    """Marks all of the student's recommendation notifications as read."""
    admin = get_admin_client()
    try:
        resp = with_retry(
            lambda c: c.table("recommendation_notifications")
            .update({"is_read": True})
            .eq("student_id", user["id"])
            .eq("is_read", False)
            .execute()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not update recommendations: {e}")

    updated = len(getattr(resp, "data", []) or [])
    return {"status": "success", "updated": updated}


# ── TikTok-style "For You" feed ─────────────────────────────────────────────
# The feed is personalized: the ranker builds a per-student interest profile
# (weak topics, engagement, seen/saved/dismissed + impression history), then
# scores every candidate and re-ranks for diversity and exploration. Profiles
# are cached briefly so infinite scroll stays cheap without going stale.

_PROFILE_CACHE = {}
_PROFILE_CACHE_LOCK = threading.Lock()

VALID_FEED_ACTIONS = {"open", "save", "dismiss", "unsave"}
VALID_FEED_TYPES = {"material", "study_resource", "external"}


def _cached_profile(admin, student_id: str) -> feed_ranker.StudentProfile:
    now = time.time()
    with _PROFILE_CACHE_LOCK:
        cached = _PROFILE_CACHE.get(student_id)
        if cached and now - cached[0] < feed_ranker.PROFILE_TTL_SECONDS:
            return cached[1]
    profile = feed_ranker.build_profile(admin, student_id)
    with _PROFILE_CACHE_LOCK:
        _PROFILE_CACHE[student_id] = (now, profile)
    return profile


def _serialize_weak_topics(weak_topics) -> list:
    return [
        {
            "topic": topic,
            "label": TOPIC_LABELS.get(topic, topic.replace("_", " ").title()),
            "avg_score": avg,
            "attempts": attempts,
        }
        for topic, avg, attempts in weak_topics
    ]


@router.get("/feed")
def get_feed(
    cursor: Optional[str] = None,
    page_size: Optional[int] = None,
    user: dict = Depends(require_role("student")),
):
    """One page of the personalized For You feed. The cursor is opaque and is
    supplied by the previous page's ``next_cursor``."""
    size = feed_ranker.FEED_PAGE_DEFAULT
    if page_size is not None:
        size = max(1, min(page_size, feed_ranker.FEED_PAGE_MAX))

    admin = get_admin_client()
    try:
        profile = _cached_profile(admin, user["id"])
        page = feed_ranker.rank_feed(admin, profile, page_size=size, cursor=cursor or "")
    except feed_ranker.FeedError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not build feed: {e}")

    # Record that the page was surfaced so exploration bonuses decay naturally.
    try:
        with_retry(
            lambda c, items=page["items"]: (
                c.table("feed_interactions")
                .insert([
                    {
                        "student_id": user["id"],
                        "item_type": it["item_type"],
                        "item_key": it["item_key"],
                        "action": "impression",
                    }
                    for it in items
                ])
                .execute()
            )
        )
    except Exception:
        pass  # impression logging must never break the feed

    return {
        "items": page["items"],
        "next_cursor": page["next_cursor"],
        "weak_topics": _serialize_weak_topics(page["weak_topics"]),
    }


@router.post("/feed/track")
def track_feed_interaction(
    payload: FeedTrackRequest,
    user: dict = Depends(require_role("student")),
):
    """Records Open / Save / Not-for-me. These signals retrain the student's
    feed live: saves unpin recommendations, dismissals suppress the item, and
    opens mark it as seen."""
    item_type = (payload.item_type or "").strip().lower()
    item_key = (payload.item_key or "").strip()
    action = (payload.action or "").strip().lower()

    if item_type not in VALID_FEED_TYPES:
        raise HTTPException(status_code=400, detail="Invalid item_type.")
    if not item_key:
        raise HTTPException(status_code=400, detail="item_key is required.")
    if action not in VALID_FEED_ACTIONS:
        raise HTTPException(status_code=400, detail="Invalid action.")

    admin = get_admin_client()
    row = {
        "student_id": user["id"],
        "item_type": item_type,
        "item_key": item_key,
        "action": action,
    }
    # Persist a snapshot on save so live web items (YouTube / Wikipedia) can be
    # restored on the Saved tab even after they leave the feed pool.
    if action == "save" and isinstance(payload.payload, dict):
        row["payload"] = payload.payload
    try:
        with_retry(
            lambda c, row=row: c.table("feed_interactions").insert(row).execute()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not record interaction: {e}")

    # Bump the cached profile so the very next page reflects the signal.
    _PROFILE_CACHE.pop(user["id"], None)

    return {"status": "success"}


@router.get("/feed/saved")
def get_saved_feed_items(user: dict = Depends(require_role("student"))):
    """The student's saved feed items (For You bookmarks)."""
    admin = get_admin_client()
    try:
        profile = _cached_profile(admin, user["id"])
        items = feed_ranker.saved_items(admin, profile)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not load saved items: {e}")
    return {"items": items}
