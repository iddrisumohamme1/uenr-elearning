# File: backend/app/routes/engagement.py
# Purpose: Logs student telemetry, runs Two-Tower Neural Network inference,
#          and persists engagement + comprehension classifications to Supabase.
#
# Two-Tower input split:
#   Student Tower  → 9 demographic features (profile data)
#   Interaction Tower → 6 behavioural features (platform activity)

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from app.database import get_admin_client, with_retry
from app.core.security import get_current_user, require_role
from app.services.engagement_analyzer import analyzer

router = APIRouter(prefix="/api/engagement", tags=["engagement"])


# ── Request / Response Models ─────────────────────────────────────────────────

class StudentProfile(BaseModel):
    """9 demographic features → Student Tower"""
    age:        float = Field(17.0, ge=10, le=25)
    sex:        float = Field(1.0,  description="1=Male, 0=Female")
    address:    float = Field(1.0,  description="1=Urban, 0=Rural")
    famsize:    float = Field(1.0,  description="1=GT3, 0=LE3")
    Pstatus:    float = Field(1.0,  description="1=Together, 0=Apart")
    Medu:       float = Field(2.0,  ge=0, le=4, description="Mother education 0-4")
    Fedu:       float = Field(2.0,  ge=0, le=4, description="Father education 0-4")
    traveltime: float = Field(1.0,  ge=1, le=4)
    studytime:  float = Field(2.0,  ge=1, le=4)


class InteractionLog(BaseModel):
    """6 behavioural / academic interaction features → Interaction Tower"""
    failures: float = Field(0.0, ge=0, le=4, description="Past course failures")
    absences: float = Field(5.0, ge=0,        description="Number of absences")
    G1:       float = Field(12.0, ge=0, le=20, description="First period grade (0-20)")
    G2:       float = Field(12.0, ge=0, le=20, description="Second period grade (0-20)")
    G3:       float = Field(12.0, ge=0, le=20, description="Final grade (0-20)")
    freetime: float = Field(3.0,  ge=1, le=5,  description="Free time after school 1-5")


class EngagementRequest(BaseModel):
    student_id:   str
    course_id:    str
    student:      StudentProfile
    interaction:  InteractionLog
    material_id:  Optional[str] = None


class MaterialEngagementLog(BaseModel):
    student_id: str
    material_id: Optional[str] = None
    course_id: str
    mouse_movements: int = Field(0, ge=0)
    scroll_depth: int = Field(0, ge=0)
    clicks: int = Field(0, ge=0)
    time_spent: int = Field(0, ge=0)
    idle_time: int = Field(0, ge=0)
    is_embedded: bool = Field(False, description="True for PDFs, Office docs loaded in iframe")


class EngagementResult(BaseModel):
    student_id:                 str
    course_id:                  str
    engagement_class:           int
    engagement_label:           str
    comprehension_class:        int
    comprehension_label:        str
    engagement_probabilities:   list
    comprehension_probabilities: list
    fallback:                   bool


class EngagementLogResponse(BaseModel):
    student_id: str
    material_id: str
    engagement_score: int
    engagement_level: str
    logged_at: str | None = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/log", response_model=EngagementLogResponse, status_code=201)
def log_engagement(payload: MaterialEngagementLog, user=Depends(get_current_user)):
    """
    Persist raw student engagement metrics for a material and return a lightweight score.
    For embedded content (PDFs, Office docs in iframe), mouse/scroll/clicks can't be
    tracked inside the iframe, so we weight time_spent and idle_time more heavily.
    """
    # Students can only log their own engagement
    if user.get("role") == "student" and user["id"] != payload.student_id:
        raise HTTPException(status_code=403, detail="Students can only log their own engagement.")
    if payload.is_embedded:
        # Embedded content: rely on time + tab visibility
        score = min(
            100,
            max(
                0,
                round(
                    0.5 * min(payload.time_spent, 300)
                    + 0.3 * min(payload.mouse_movements, 50)
                    + 0.2 * min(payload.clicks, 10)
                    - 0.15 * payload.idle_time,
                ),
            ),
        )
    else:
        # Regular content: full telemetry available
        score = min(
            100,
            max(
                0,
                round(
                    0.3 * min(payload.scroll_depth, 100)
                    + 0.2 * min(payload.mouse_movements, 200)
                    + 0.25 * payload.clicks
                    + 0.2 * min(payload.time_spent, 300)
                    - 0.1 * payload.idle_time,
                ),
            ),
        )

    if score >= 75:
        level = "High"
    elif score >= 40:
        level = "Medium"
    else:
        level = "Low"

    try:
        admin = get_admin_client()
        resp = (
            admin.table("engagement_logs")
            .insert(
                {
                    "student_id": payload.student_id,
                    "material_id": payload.material_id,
                    "course_id": payload.course_id,
                    "mouse_movements": payload.mouse_movements,
                    "scroll_depth": payload.scroll_depth,
                    "clicks": payload.clicks,
                    "time_spent": payload.time_spent,
                    "idle_time": payload.idle_time,
                    "engagement_score": score,
                    "engagement_level": level,
                    "engagement_class": 1,
                    "engagement_label": level,
                    "comprehension_class": 1,
                    "comprehension_label": "Moderate",
                }
            )
            .execute()
        )
    except Exception as e:
        print(f"[engagement] log write error: {e}")

    return EngagementLogResponse(
        student_id=payload.student_id,
        material_id=payload.material_id,
        engagement_score=score,
        engagement_level=level,
    )


@router.post("/classify", response_model=EngagementResult, status_code=201)
def classify_engagement(payload: EngagementRequest, user=Depends(get_current_user)):
    """
    Runs the Two-Tower Neural Network on student profile + interaction data
    to classify engagement and comprehension levels.
    Persists the result to the engagement_logs table in Supabase.
    """
    # Students can only classify their own engagement
    if user.get("role") == "student" and user["id"] != payload.student_id:
        raise HTTPException(status_code=403, detail="Students can only classify their own engagement.")
    student_dict     = payload.student.model_dump()
    interaction_dict = payload.interaction.model_dump()

    # ── Run Two-Tower inference ───────────────────────────────────────────────
    result = analyzer.classify(student_dict, interaction_dict)

    # ── Persist to Supabase ───────────────────────────────────────────────────
    record = {
        "student_id":        payload.student_id,
        "course_id":         payload.course_id,
        # Interaction features stored as telemetry metrics
        "failures":          interaction_dict["failures"],
        "absences":          interaction_dict["absences"],
        "G1":                interaction_dict["G1"],
        "G2":                interaction_dict["G2"],
        "G3":                interaction_dict["G3"],
        "freetime":          interaction_dict["freetime"],
        # Classification output
        "engagement_class":   result["engagement_class"],
        "engagement_label":   result["engagement_label"],
        "comprehension_class":  result["comprehension_class"],
        "comprehension_label":  result["comprehension_label"],
    }
    if payload.material_id:
        record["material_id"] = payload.material_id

    try:
        admin = get_admin_client()
        admin.table("engagement_logs").insert(record).execute()
    except Exception as e:
        # Log but don't fail — classification result is still returned
        print(f"[engagement] DB write error: {e}")

    return EngagementResult(
        student_id=payload.student_id,
        course_id=payload.course_id,
        **result,
    )


@router.get("/student/{student_id}")
def get_student_engagement(student_id: str, user=Depends(get_current_user)):
    """Returns the 10 most recent engagement records for a student."""
    # Students can only view their own engagement
    if user.get("role") == "student" and user["id"] != student_id:
        raise HTTPException(status_code=403, detail="Access denied.")
    try:
        admin = get_admin_client()
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("*")
            .eq("student_id", student_id)
            .order("created_at", desc=True)
            .limit(10)
            .execute()
        )
        return {"student_id": student_id, "logs": resp.data}
    except Exception as e:
        raise HTTPException(500, detail=str(e))


@router.get("/course/{course_id}")
def get_course_engagement(course_id: str, user=Depends(get_current_user)):
    """Returns engagement summary for all students in a course (Lecturer view)."""
    # Verify course belongs to user's department
    admin = get_admin_client()
    course_resp = with_retry(lambda c: c.table("courses").select("department").eq("id", course_id).execute())
    course_data = getattr(course_resp, "data", []) or []
    if not course_data:
        raise HTTPException(status_code=404, detail="Course not found.")
    if course_data[0].get("department") != user.get("department"):
        raise HTTPException(status_code=403, detail="Access denied.")
    try:
        admin = get_admin_client()
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("student_id, engagement_class, engagement_label, comprehension_class, comprehension_label, created_at")
            .eq("course_id", course_id)
            .order("created_at", desc=True)
            .execute()
        )
        return {"course_id": course_id, "students": resp.data}
    except Exception as e:
        raise HTTPException(500, detail=str(e))


@router.get("/at-risk/{course_id}")
def get_at_risk_students(course_id: str, user=Depends(get_current_user)):
    """Returns only at-risk students (engagement_class=0) for a course."""
    # Verify course belongs to user's department
    admin = get_admin_client()
    course_resp = with_retry(lambda c: c.table("courses").select("department").eq("id", course_id).execute())
    course_data = getattr(course_resp, "data", []) or []
    if not course_data:
        raise HTTPException(status_code=404, detail="Course not found.")
    if course_data[0].get("department") != user.get("department"):
        raise HTTPException(status_code=403, detail="Access denied.")
    try:
        admin = get_admin_client()
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("student_id, engagement_label, comprehension_label, created_at")
            .eq("course_id", course_id)
            .eq("engagement_class", 0)
            .order("created_at", desc=True)
            .execute()
        )
        return {"course_id": course_id, "at_risk_count": len(resp.data), "students": resp.data}
    except Exception as e:
        raise HTTPException(500, detail=str(e))


# ── Auto-Classify: bridges telemetry logs with Two-Tower NN ───────────────────

class AutoClassifyRequest(BaseModel):
    student_id: str
    course_id: str
    material_id: Optional[str] = None


@router.post("/auto-classify", response_model=EngagementResult, status_code=201)
def auto_classify(payload: AutoClassifyRequest, user=Depends(get_current_user)):
    """
    Automatically classifies a student using available data from quiz results
    and material telemetry. Designed to be called from the frontend after a
    material-viewing session to trigger Two-Tower classification.

    Pulls the student's latest quiz scores for the course (G1/G2/G3)
    and uses sensible defaults for demographic features not stored in Supabase.
    """
    # Students can only auto-classify themselves
    if user.get("role") == "student" and user["id"] != payload.student_id:
        raise HTTPException(status_code=403, detail="Students can only classify their own engagement.")
    admin = get_admin_client()

    # ── Fetch latest quiz results for this course as interaction proxy ────────
    interaction_defaults = {"failures": 0, "absences": 0, "G1": 10, "G2": 10, "G3": 10, "freetime": 3}

    try:
        quiz_resp = with_retry(
            lambda c: c.table("quiz_results")
            .select("score, quizzes!inner(course_id)")
            .eq("student_id", payload.student_id)
            .order("created_at", desc=True)
            .limit(10)
            .execute()
        )
        quiz_data = getattr(quiz_resp, "data", []) or []

        # Filter to this course's quizzes and extract scores as G1/G2/G3 proxy
        course_scores = []
        for qr in quiz_data:
            course_info = qr.get("quizzes")
            if isinstance(course_info, dict) and course_info.get("course_id") == payload.course_id:
                course_scores.append(float(qr.get("score", 10)))

        if course_scores:
            # Map to G1 (first quiz), G2 (middle), G3 (latest)
            interaction_defaults["G1"] = course_scores[-1] if len(course_scores) >= 1 else 10
            interaction_defaults["G2"] = course_scores[len(course_scores) // 2] if len(course_scores) >= 2 else course_scores[0]
            interaction_defaults["G3"] = course_scores[0]  # Latest score
    except Exception as e:
        print(f"[auto-classify] Could not fetch quiz results: {e}")

    # ── Fetch engagement log metrics if available ─────────────────────────────
    try:
        eng_resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("failures, absences, freetime")
            .eq("student_id", payload.student_id)
            .eq("course_id", payload.course_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        eng_data = getattr(eng_resp, "data", []) or []
        if eng_data:
            latest = eng_data[0]
            if latest.get("failures") is not None:
                interaction_defaults["failures"] = float(latest["failures"])
            if latest.get("absences") is not None:
                interaction_defaults["absences"] = float(latest["absences"])
            if latest.get("freetime") is not None:
                interaction_defaults["freetime"] = float(latest["freetime"])
    except Exception:
        pass

    # ── Student tower: use sensible defaults (UCI dataset midpoints) ──────────
    student_defaults = {
        "age": 17, "sex": 1, "address": 1, "famsize": 1,
        "Pstatus": 1, "Medu": 2, "Fedu": 2, "traveltime": 1, "studytime": 2,
    }

    # ── Run Two-Tower inference ───────────────────────────────────────────────
    result = analyzer.classify(student_defaults, interaction_defaults)

    # ── Persist to Supabase ───────────────────────────────────────────────────
    record = {
        "student_id": payload.student_id,
        "course_id": payload.course_id,
        "failures": interaction_defaults["failures"],
        "absences": interaction_defaults["absences"],
        "G1": interaction_defaults["G1"],
        "G2": interaction_defaults["G2"],
        "G3": interaction_defaults["G3"],
        "freetime": interaction_defaults["freetime"],
        "engagement_class": result["engagement_class"],
        "engagement_label": result["engagement_label"],
        "comprehension_class": result["comprehension_class"],
        "comprehension_label": result["comprehension_label"],
    }
    if payload.material_id:
        record["material_id"] = payload.material_id

    try:
        admin.table("engagement_logs").insert(record).execute()
    except Exception as e:
        print(f"[auto-classify] DB write error: {e}")

    return EngagementResult(
        student_id=payload.student_id,
        course_id=payload.course_id,
        **result,
    )


@router.get("/student/{student_id}/classification")
def get_student_classification(student_id: str, user=Depends(get_current_user)):
    """Returns the latest Two-Tower classification for a student across all courses."""
    # Students can only view their own classification
    if user.get("role") == "student" and user["id"] != student_id:
        raise HTTPException(status_code=403, detail="Access denied.")
    try:
        admin = get_admin_client()
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("student_id, course_id, engagement_class, engagement_label, comprehension_class, comprehension_label, created_at")
            .eq("student_id", student_id)
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )
        logs = getattr(resp, "data", []) or []

        if not logs:
            return {"student_id": student_id, "classifications": [], "latest": None}

        # Compute aggregate from most recent classification per course
        latest_per_course = {}
        for log in logs:
            cid = log.get("course_id")
            if cid not in latest_per_course:
                latest_per_course[cid] = log

        return {
            "student_id": student_id,
            "classifications": logs,
            "latest": logs[0] if logs else None,
            "by_course": latest_per_course,
        }
    except Exception as e:
        raise HTTPException(500, detail=str(e))
