# File: backend/app/routes/recommendations.py
# Purpose: Returns Sentence-BERT semantic resource recommendations for at-risk students.
#          Takes a weak concept description and returns top-N matched learning materials.

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from app.services.recommendation_engine import engine

router = APIRouter(prefix="/api/recommendations", tags=["recommendations"])


class RecommendationRequest(BaseModel):
    student_id: str
    weak_concepts: str
    top_n: Optional[int] = 3


class ResourceItem(BaseModel):
    id: str
    title: str
    description: str
    topic: str
    type: str
    difficulty: str
    similarity_score: float


class RecommendationResponse(BaseModel):
    student_id: str
    weak_concepts: str
    recommendations: List[dict]


@router.post("/", response_model=RecommendationResponse)
def get_recommendations(payload: RecommendationRequest):
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
            top_n=top_n
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Recommendation engine error: {e}")

    return RecommendationResponse(
        student_id=payload.student_id,
        weak_concepts=payload.weak_concepts,
        recommendations=results,
    )


@router.get("/resources")
def list_all_resources():
    """Returns all available learning materials in the recommendation pool."""
    if not engine.resources:
        raise HTTPException(status_code=404, detail="No learning resources available.")
    return {"total": len(engine.resources), "resources": engine.resources}
