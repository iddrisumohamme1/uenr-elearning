# File: backend/app/routes/students.py
# Purpose: Student-specific endpoints for dashboard stats, enrolled courses,
#          and quiz history.

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from app.core.security import get_current_user, require_role
from app.database import get_admin_client

router = APIRouter(prefix="/api/students", tags=["students"])


class EnrolledCourse(BaseModel):
    id: str
    title: str
    code: Optional[str] = None
    lecturer_name: Optional[str] = None
    progress: int = 0


class StudentStats(BaseModel):
    engagement_score: int = 0
    enrolled_courses: int = 0
    completed_topics: int = 0


@router.get("/{student_id}/courses", response_model=List[EnrolledCourse])
def get_student_courses(student_id: str, user=Depends(get_current_user)):
    """Return all courses a student is enrolled in, with basic progress info."""
    if user["id"] != student_id and user.get("role") not in ("lecturer", "hod"):
        raise HTTPException(status_code=403, detail="Access denied.")

    admin = get_admin_client()

    try:
        enrollments_resp = (
            admin.table("enrollments")
            .select("course_id")
            .eq("student_id", student_id)
            .execute()
        )
        enrollments = getattr(enrollments_resp, "data", []) or []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query enrollments: {exc}")

    if not enrollments:
        return []

    course_ids = [e["course_id"] for e in enrollments if e.get("course_id")]

    courses = []
    for cid in course_ids:
        try:
            course_resp = (
                admin.table("courses")
                .select("id, title, code, lecturer_id")
                .eq("id", cid)
                .execute()
            )
            course_data = getattr(course_resp, "data", []) or []
            if not course_data:
                continue
            course = course_data[0]

            # Get lecturer name
            lecturer_name = None
            if course.get("lecturer_id"):
                try:
                    lec_resp = (
                        admin.table("users")
                        .select("full_name")
                        .eq("id", course["lecturer_id"])
                        .execute()
                    )
                    lec_data = getattr(lec_resp, "data", []) or []
                    if lec_data:
                        lecturer_name = lec_data[0].get("full_name")
                except Exception:
                    pass

            # Count engagement logs as rough progress
            try:
                logs_resp = (
                    admin.table("engagement_logs")
                    .select("id")
                    .eq("student_id", student_id)
                    .eq("course_id", cid)
                    .execute()
                )
                log_count = len(getattr(logs_resp, "data", []) or [])
                # Simple heuristic: each material engagement is ~20% progress
                progress = min(100, log_count * 20)
            except Exception:
                progress = 0

            courses.append(EnrolledCourse(
                id=course["id"],
                title=course.get("title", "Untitled"),
                code=course.get("code"),
                lecturer_name=lecturer_name,
                progress=progress,
            ))
        except Exception:
            continue

    return courses


@router.get("/{student_id}/stats", response_model=StudentStats)
def get_student_stats(student_id: str, user=Depends(get_current_user)):
    """Return aggregated stats for the student dashboard."""
    if user["id"] != student_id and user.get("role") not in ("lecturer", "hod"):
        raise HTTPException(status_code=403, detail="Access denied.")

    admin = get_admin_client()

    # Enrolled courses count
    try:
        enroll_resp = (
            admin.table("enrollments")
            .select("course_id")
            .eq("student_id", student_id)
            .execute()
        )
        enrollments = getattr(enroll_resp, "data", []) or []
        enrolled_count = len(enrollments)
    except Exception:
        enrolled_count = 0

    # Engagement score: average of recent engagement_logs
    try:
        logs_resp = (
            admin.table("engagement_logs")
            .select("engagement_score")
            .eq("student_id", student_id)
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )
        logs = getattr(logs_resp, "data", []) or []
        if logs:
            scores = [l.get("engagement_score", 0) for l in logs if l.get("engagement_score") is not None]
            engagement_score = round(sum(scores) / len(scores)) if scores else 0
        else:
            engagement_score = 0
    except Exception:
        engagement_score = 0

    # Completed topics: count distinct materials the student has engaged with
    try:
        materials_resp = (
            admin.table("engagement_logs")
            .select("material_id")
            .eq("student_id", student_id)
            .execute()
        )
        material_ids = {l.get("material_id") for l in (getattr(materials_resp, "data", []) or []) if l.get("material_id")}
        completed_topics = len(material_ids)
    except Exception:
        completed_topics = 0

    return StudentStats(
        engagement_score=engagement_score,
        enrolled_courses=enrolled_count,
        completed_topics=completed_topics,
    )
