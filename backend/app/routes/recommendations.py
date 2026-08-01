# File: backend/app/routes/recommendations.py
# Purpose: Returns semantic resource recommendations for at-risk students.
#          Accepts a weak concept description and returns top-N matched learning
#          materials, OR auto-detects weak topics from the student's quiz history.

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from app.core.security import require_role, get_current_user
from app.database import get_admin_client, with_retry
from app.services.recommendation_engine import engine, detect_topic

router = APIRouter(prefix="/api/recommendations", tags=["recommendations"])

# Score below this (as a percentage) marks a topic as a weakness.
WEAK_SCORE_THRESHOLD = 60.0

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
        results = engine.get_recommendations(
            weak_concepts=payload.weak_concepts,
            top_n=top_n,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Recommendation engine error: {e}")

    student_id = payload.student_id or user["id"]
    return RecommendationResponse(
        student_id=student_id,
        weak_concepts=payload.weak_concepts,
        recommendations=_decorate_recommendations(results, payload.weak_concepts),
    )


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

    # Map course_id -> title for topic detection.
    course_ids = list({r.get("quizzes", {}).get("course_id") for r in quiz_rows
                       if r.get("quizzes")})
    course_map = {}
    if course_ids:
        for cid in course_ids:
            try:
                cresp = with_retry(lambda c, cid=cid: c.table("courses").select("id, title").eq("id", cid).limit(1).execute())
                cdata = getattr(cresp, "data", []) or []
                if cdata:
                    course_map[cid] = cdata[0].get("title", "")
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

    # Fetch targeted resources for each weak topic.
    all_recs = []
    for wt in weak_topics:
        try:
            results = engine.get_recommendations(weak_concepts=wt.label, top_n=4)
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
    if not engine.resources:
        raise HTTPException(status_code=404, detail="No learning resources available.")
    return {"total": len(engine.resources), "resources": engine.resources}
