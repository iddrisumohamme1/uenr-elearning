# File: backend/app/schemas/engagement.py
# Purpose: Pydantic schemas for engagement telemetry validation.

from pydantic import BaseModel, Field
from typing import Optional


class EngagementMetricsIn(BaseModel):
    login_frequency: float = Field(..., ge=0, description="Times student logged in this week")
    time_on_task: float = Field(..., ge=0, description="Active hours on study materials")
    navigation_score: float = Field(..., ge=0, le=100, description="Navigation efficiency score (0-100)")
    quiz_scores: float = Field(..., ge=0, le=100, description="Average quiz/formative score (0-100)")
    resource_access: float = Field(..., ge=0, description="Number of distinct resources accessed")
    forum_posts: float = Field(..., ge=0, description="Discussion forum posts count")
    assessment_attempts: float = Field(..., ge=0, description="Number of assessment submission attempts")
    telemetry_score: float = Field(..., ge=0, le=100, description="Mouse/click telemetry activity index (0-100)")


class EngagementLog(EngagementMetricsIn):
    student_id: str
    course_id: str


class EngagementPrediction(BaseModel):
    engagement_class: int = Field(..., description="0=At-Risk, 1=Moderate, 2=Highly Engaged")
    engagement_label: str
    probabilities: list
    fallback: bool = False
