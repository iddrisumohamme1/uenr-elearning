# File: backend/app/routes/analytics.py
# Purpose: Analytics endpoints for Lecturer and HOD dashboards.
#          Aggregates Two-Tower classification results from engagement_logs
#          to surface at-risk statistics, comprehension trends, and course-level metrics.

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from app.core.security import get_current_user, require_role
from app.database import get_admin_client, with_retry
from app.routes.study import _predict_percentage, _quiz_stats, _attendance_stats

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


# ─── Lecturer Analytics ───────────────────────────────────────────────────────

@router.get("/course/{course_id}/summary")
def course_summary(course_id: str, user=Depends(get_current_user)):
    """
    Returns an engagement + comprehension summary for a single course.
    Used by the Lecturer dashboard overview card.
    """
    admin = get_admin_client()

    # Verify course belongs to the user's department
    try:
        course_resp = with_retry(
            lambda c: c.table("courses")
            .select("id, department, lecturer_id")
            .eq("id", course_id)
            .execute()
        )
        course_data = getattr(course_resp, "data", []) or []
        if not course_data:
            raise HTTPException(status_code=404, detail="Course not found.")
        course = course_data[0]
        if course.get("department") != user.get("department"):
            raise HTTPException(status_code=403, detail="Access denied to this course.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    try:
        logs = with_retry(
            lambda c: c.table("engagement_logs")
            .select("student_id, engagement_class, comprehension_class, created_at")
            .eq("course_id", course_id)
            .execute()
        ).data
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query engagement logs: {exc}")

    if not logs:
        return {"course_id": course_id, "total_students": 0, "summary": {}}

    total     = len(logs)
    at_risk   = sum(1 for r in logs if r["engagement_class"] == 0)
    moderate  = sum(1 for r in logs if r["engagement_class"] == 1)
    high      = sum(1 for r in logs if r["engagement_class"] == 2)
    low_comp  = sum(1 for r in logs if r["comprehension_class"] == 0)
    mod_comp  = sum(1 for r in logs if r["comprehension_class"] == 1)
    good_comp = sum(1 for r in logs if r["comprehension_class"] == 2)
    student_ids = {record["student_id"] for record in logs if record.get("student_id")}

    return {
        "course_id": course_id,
        "total_logs": total,
        "unique_students": len(student_ids),
        "engagement": {
            "at_risk":   {"count": at_risk,  "pct": round(at_risk  / total * 100, 1)},
            "moderate":  {"count": moderate, "pct": round(moderate / total * 100, 1)},
            "highly_engaged": {"count": high,"pct": round(high     / total * 100, 1)},
        },
        "comprehension": {
            "low":      {"count": low_comp,  "pct": round(low_comp  / total * 100, 1)},
            "moderate": {"count": mod_comp,  "pct": round(mod_comp  / total * 100, 1)},
            "good":     {"count": good_comp, "pct": round(good_comp / total * 100, 1)},
        },
    }


@router.get("/course/{course_id}/at-risk")
def course_at_risk(course_id: str, user=Depends(get_current_user)):
    """
    Returns all students flagged as At-Risk (engagement_class=0)
    in a course — used to trigger intervention alerts on the lecturer dashboard.
    """
    admin = get_admin_client()

    # Verify course belongs to the user's department
    try:
        course_resp = with_retry(
            lambda c: c.table("courses")
            .select("id, department")
            .eq("id", course_id)
            .execute()
        )
        course_data = getattr(course_resp, "data", []) or []
        if not course_data:
            raise HTTPException(status_code=404, detail="Course not found.")
        if course_data[0].get("department") != user.get("department"):
            raise HTTPException(status_code=403, detail="Access denied to this course.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    try:
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("student_id, comprehension_class, comprehension_label, created_at")
            .eq("course_id", course_id)
            .eq("engagement_class", 0)
            .order("created_at", desc=True)
            .execute()
        )
        students = resp.data

        # Enrich with student names so the lecturer dashboard can show who needs help.
        student_ids = list({s.get("student_id") for s in students if s.get("student_id")})
        name_map = {}
        if student_ids:
            try:
                users = with_retry(lambda c: c.table("users").select("id, full_name").in_("id", student_ids).execute())
                name_map = {u["id"]: u.get("full_name") for u in (users.data or []) if u.get("id")}
            except Exception:
                name_map = {}

        for s in students:
            s["full_name"] = name_map.get(s.get("student_id")) or None

        return {
            "course_id": course_id,
            "at_risk_count": len(students),
            "students": students,
        }
    except Exception as exc:
        raise HTTPException(500, detail=str(exc))


@router.get("/course/{course_id}/trend")
def course_engagement_trend(course_id: str, limit: int = 30, user=Depends(get_current_user)):
    """
    Returns a time-series of engagement class counts for chart rendering
    on the lecturer dashboard (last N records ordered by time).
    """
    limit = min(limit, 100)

    admin = get_admin_client()

    # Verify course belongs to the user's department
    try:
        course_resp = with_retry(
            lambda c: c.table("courses")
            .select("id, department")
            .eq("id", course_id)
            .execute()
        )
        course_data = getattr(course_resp, "data", []) or []
        if not course_data:
            raise HTTPException(status_code=404, detail="Course not found.")
        if course_data[0].get("department") != user.get("department"):
            raise HTTPException(status_code=403, detail="Access denied to this course.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    try:
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("engagement_class, comprehension_class, created_at")
            .eq("course_id", course_id)
            .order("created_at", desc=False)
            .limit(limit)
            .execute()
        )
        return {"course_id": course_id, "trend": resp.data}
    except Exception as exc:
        raise HTTPException(500, detail=str(exc))


# ─── HOD Analytics ────────────────────────────────────────────────────────────

@router.get("/department/summary")
def department_summary(user=Depends(require_role("hod"))):
    """
    Returns aggregated engagement statistics across courses in the HOD's department.
    Scoped to the logged-in HOD's department.
    """
    if not user.get("department"):
        raise HTTPException(status_code=400, detail="HOD department is not configured.")

    admin = get_admin_client()

    # Get courses in the HOD's department
    try:
        courses_resp = with_retry(
            lambda c: c.table("courses")
            .select("id")
            .eq("department", user["department"])
            .execute()
        )
        dept_courses = getattr(courses_resp, "data", []) or []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query department courses: {exc}")

    if not dept_courses:
        return {"total_records": 0, "department_engagement": {}, "by_course": {}}

    course_ids = [c["id"] for c in dept_courses]

    # Fetch engagement logs for all department courses
    all_logs = []
    for cid in course_ids:
        try:
            resp = with_retry(
                lambda c, cid=cid: c.table("engagement_logs")
                .select("course_id, engagement_class, comprehension_class")
                .eq("course_id", cid)
                .execute()
            )
            logs_data = getattr(resp, "data", []) or []
            all_logs.extend(logs_data)
        except Exception:
            continue

    if not all_logs:
        return {"total_records": 0, "department_engagement": {}, "by_course": {}}

    total    = len(all_logs)
    at_risk  = sum(1 for r in all_logs if r["engagement_class"] == 0)
    moderate = sum(1 for r in all_logs if r["engagement_class"] == 1)
    high     = sum(1 for r in all_logs if r["engagement_class"] == 2)

    # Per-course breakdown
    by_course = defaultdict(lambda: {"at_risk": 0, "moderate": 0, "high": 0, "total": 0})
    for r in all_logs:
        cid = r["course_id"]
        by_course[cid]["total"] += 1
        if r["engagement_class"] == 0:
            by_course[cid]["at_risk"] += 1
        elif r["engagement_class"] == 1:
            by_course[cid]["moderate"] += 1
        else:
            by_course[cid]["high"] += 1

    return {
        "total_records": total,
        "department_engagement": {
            "at_risk":  {"count": at_risk,  "pct": round(at_risk  / total * 100, 1)},
            "moderate": {"count": moderate, "pct": round(moderate / total * 100, 1)},
            "highly_engaged": {"count": high,"pct": round(high    / total * 100, 1)},
        },
        "by_course": dict(by_course),
    }

@router.get("/predict-grade/{student_id}/{course_id}")
def predict_grade(student_id: str, course_id: str, user=Depends(get_current_user)):
    """
    Predicts the likely end-of-semester grade for a student in a course by
    blending quiz performance, comprehension classification, attendance and
    weekly study time into a 0-100 percentage with a letter grade and a
    "what-if" projection for improving study time.
    """
    if user["role"] == "student" and user["id"] != student_id:
        raise HTTPException(status_code=403, detail="Can only predict own grade")

    admin = get_admin_client()
    course_ids = [course_id]

    # Comprehension signal from the latest Two-Tower classifications
    comp_class = None
    try:
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("comprehension_class")
            .eq("student_id", student_id)
            .eq("course_id", course_id)
            .not_.is_("comprehension_class", "null")
            .order("created_at", desc=True)
            .limit(10)
            .execute()
        )
        logs = getattr(resp, "data", []) or []
        if logs:
            comp_class = round(sum(float(l["comprehension_class"]) for l in logs) / len(logs), 2)
    except Exception:
        pass

    quiz_stats = _quiz_stats(admin, student_id, course_ids)
    attendance = _attendance_stats(admin, student_id, course_ids)
    quiz_avg = quiz_stats.get(course_id)
    attendance_rate = attendance.get("per_course", {}).get(course_id)

    # Weekly study coverage
    study_coverage = None
    try:
        from datetime import datetime, timedelta
        from app.routes.study import MINUTES_PER_MATERIAL, STUDY_WINDOW_DAYS
        window_start = (datetime.utcnow() - timedelta(days=STUDY_WINDOW_DAYS)).isoformat() + "Z"
        mat_resp = with_retry(
            lambda c: c.table("materials").select("id").eq("course_id", course_id).execute()
        )
        materials_count = len(getattr(mat_resp, "data", []) or [])
        logs_resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("time_spent")
            .eq("student_id", student_id)
            .eq("course_id", course_id)
            .gte("created_at", window_start)
            .execute()
        )
        time_spent_minutes = round(
            sum(float(l.get("time_spent") or 0) for l in (getattr(logs_resp, "data", []) or [])) / 60, 1
        )
        recommended = round(materials_count * MINUTES_PER_MATERIAL, 1) if materials_count else 0
        if recommended:
            study_coverage = min(100.0, round(time_spent_minutes / recommended * 100, 1))
    except Exception as exc:
        print(f"[analytics] study coverage error: {exc}")

    if quiz_avg is None and comp_class is None and attendance_rate is None and study_coverage is None:
        return {
            "status": "success",
            "prediction": "Insufficient Data",
            "advice": "Please engage more with the platform and take more quizzes so we can predict your performance.",
        }

    predicted = _predict_percentage(
        quiz_avg=quiz_avg,
        comprehension_class=comp_class,
        attendance_rate=attendance_rate,
        study_coverage=study_coverage,
    )

    percentage = predicted["percentage"]
    if percentage is None:
        advice = "Please engage more with the platform so we can predict your performance."
    elif percentage >= 80:
        advice = "You are on track for a strong result. Keep your current study rhythm going."
    elif percentage >= 60:
        advice = "You are doing well. Add a little more weekly study time and review the recommended resources to push higher."
    elif percentage >= 50:
        advice = "You are at the pass boundary. Increasing your weekly study time and taking more quizzes will help secure a better grade."
    else:
        advice = "You are at risk. Prioritise this course — aim for at least 20 minutes of study per material and complete the practice questions."

    return {
        "status": "success",
        "predicted_percentage": percentage,
        "predicted_grade": predicted["grade"],
        "prediction": f"{predicted['grade']} ({percentage}%)" if percentage is not None else "Insufficient Data",
        "signals": {
            "quiz_avg": quiz_avg,
            "comprehension_class": comp_class,
            "attendance_present_rate": attendance_rate,
            "study_coverage": study_coverage,
        },
        "what_if": predicted["what_if"],
        "advice": advice,
    }
