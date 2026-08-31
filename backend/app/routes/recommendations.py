# File: backend/app/routes/recommendations.py
# Purpose: Returns semantic resource recommendations for at-risk students.
#          Accepts a weak concept description and returns top-N matched learning
#          materials, OR auto-detects weak topics from the student's quiz history.

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
# surfaced to the student as a sidebar notification.
RECOMMEND_THRESHOLD = 60.0

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


def record_auto_recommendation(
    student_id: str,
    course_id: str,
    submission_id: str,
    score: float,
    weak_concept: str,
    top_n: int = 2,
    include_web: bool = False,
) -> list:
    """
    Generate resource recommendations for a weak concept and store them as
    unread notifications for the student. Returns the created notification rows.
    Never raises — a failing recommendation must not break quiz submission.

    `include_web` is off by default so the fast path (used right after a quiz)
    only searches the local pool (every course's materials + curated external
    resources) and skips the network-bound live YouTube search.
    """
    try:
        admin = get_admin_client()
        results = engine.get_recommendations(
            weak_concepts=weak_concept,
            top_n=top_n,
            include_web=include_web,
            enrolled_course_ids=_enrolled_course_ids(admin, student_id),
        )
    except Exception as e:
        print(f"[Recommendation] Auto-recommendation failed: {e}")
        return []

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
                    "reason": f"Recommended for: \u201c{weak_concept}\u201d (quiz score {score}%)",
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
