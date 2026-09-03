# File: backend/app/routes/students.py
# Purpose: Student-specific endpoints for dashboard stats, enrolled courses,
#          and quiz history.

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from app.core.security import get_current_user, require_role
from app.database import get_admin_client, with_retry

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
        enrollments_resp = with_retry(
            lambda c: c.table("enrollments")
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
            course_resp = with_retry(
                lambda c, cid=cid: c.table("courses")
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
                    lec_resp = with_retry(
                        lambda c, lid=course["lecturer_id"]: c.table("users")
                        .select("full_name")
                        .eq("id", lid)
                        .execute()
                    )
                    lec_data = getattr(lec_resp, "data", []) or []
                    if lec_data:
                        lecturer_name = lec_data[0].get("full_name")
                except Exception:
                    pass

            # Progress = fraction of the course's materials the student has
            # actually read. A material counts as completed once the student
            # has logged at least 60 seconds of reading (time_spent, in
            # seconds) against it — matching the reader's active-reading gate
            # — so merely opening it isn't enough to mark it done.
            try:
                mats_resp = with_retry(
                    lambda c, cid=cid: c.table("materials")
                    .select("id")
                    .eq("course_id", cid)
                    .execute()
                )
                total_materials = len(getattr(mats_resp, "data", []) or [])

                logs_resp = with_retry(
                    lambda c, cid=cid: c.table("engagement_logs")
                    .select("material_id, time_spent")
                    .eq("student_id", student_id)
                    .eq("course_id", cid)
                    .execute()
                )
                spent_by_material = {}
                for l in (getattr(logs_resp, "data", []) or []):
                    mid = l.get("material_id")
                    if not mid:
                        continue
                    spent_by_material[mid] = spent_by_material.get(mid, 0) + int(l.get("time_spent") or 0)

                completed_materials = sum(
                    1 for secs in spent_by_material.values() if secs >= 60
                )
                progress = round(completed_materials / total_materials * 100) if total_materials else 0
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
        enroll_resp = with_retry(
            lambda c: c.table("enrollments")
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
        logs_resp = with_retry(
            lambda c: c.table("engagement_logs")
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

    # Completed courses: count enrolled courses where the student has finished
    # every material (each read for at least 60s of time_spent), matching the
    # course-progress completion gate so this agrees with the enrolled-course
    # cards. Merely opening a material is not enough to complete it.
    completed_topics = 0
    for cid in enrollments:
        try:
            cid = cid.get("course_id") if isinstance(cid, dict) else cid
            if not cid:
                continue
            mats_resp = with_retry(
                lambda c, cid=cid: c.table("materials")
                .select("id")
                .eq("course_id", cid)
                .execute()
            )
            total_materials = len(getattr(mats_resp, "data", []) or [])
            if not total_materials:
                continue

            logs_resp = with_retry(
                lambda c, cid=cid: c.table("engagement_logs")
                .select("material_id, time_spent")
                .eq("student_id", student_id)
                .eq("course_id", cid)
                .execute()
            )
            spent_by_material = {}
            for l in (getattr(logs_resp, "data", []) or []):
                mid = l.get("material_id")
                if not mid:
                    continue
                spent_by_material[mid] = spent_by_material.get(mid, 0) + int(l.get("time_spent") or 0)
            completed_materials = sum(1 for secs in spent_by_material.values() if secs >= 60)
            if completed_materials >= total_materials:
                completed_topics += 1
        except Exception:
            continue

    return StudentStats(
        engagement_score=engagement_score,
        enrolled_courses=enrolled_count,
        completed_topics=completed_topics,
    )
