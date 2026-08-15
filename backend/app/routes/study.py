# File: backend/app/routes/study.py
# Purpose: Personal study insights for students: predicted grades, study-time
#          warnings, weekly targets, quiz/assignment/attendance summaries.

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from app.core.security import get_current_user
from app.database import get_admin_client, with_retry
from app.services.grades import letter_grade

router = APIRouter(prefix="/api/study", tags=["study"])

MINUTES_PER_MATERIAL = 20
STUDY_WINDOW_DAYS = 7


def _warning_for(minutes: float, recommended: float) -> Optional[str]:
    if minutes <= 0:
        return "You haven't spent any time studying this course this week. Start with at least 10 minutes today — every material counts."
    if minutes < 10:
        return f"You've studied only {int(minutes)} minutes this week — that's far below target. Try to add at least 10 more minutes today."
    if minutes < 15:
        return f"You've studied {int(minutes)} minutes this week. Push for at least 15 minutes to build momentum."
    if minutes < 20:
        return f"You've studied {int(minutes)} minutes this week. Aim for at least 20 minutes (about one material) to stay on track."
    if minutes < recommended:
        return f"Good start — {int(minutes)} minutes this week. Keep going to reach the {int(recommended)}-minute weekly target."
    return None


@router.get("/summary/{student_id}")
def study_summary(student_id: str, user=Depends(get_current_user)):
    """Per-course progress + predictions + study-time warnings for a student."""
    if user["id"] != student_id and user.get("role") not in ("lecturer", "hod"):
        raise HTTPException(status_code=403, detail="You can only view your own study insights.")

    admin = get_admin_client()
    try:
        enroll_resp = with_retry(
            lambda c: c.table("enrollments").select("course_id").eq("student_id", student_id).execute()
        )
        course_ids = [e["course_id"] for e in (getattr(enroll_resp, "data", []) or []) if e.get("course_id")]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch enrollments: {exc}")

    courses = []
    window_start = (datetime.utcnow() - timedelta(days=STUDY_WINDOW_DAYS)).isoformat() + "Z"

    for cid in course_ids:
        try:
            course_resp = with_retry(
                lambda c, cid=cid: c.table("courses")
                .select("id, title, code, lecturer_id")
                .eq("id", cid)
                .execute()
            )
            course_data = (getattr(course_resp, "data", []) or [])
            if not course_data:
                continue
            course = course_data[0]

            mat_resp = with_retry(
                lambda c, cid=cid: c.table("materials")
                .select("id, week_number")
                .eq("course_id", cid)
                .execute()
            )
            materials = getattr(mat_resp, "data", []) or []
            materials_count = len(materials)
            weeks_covered = len({m.get("week_number") for m in materials if m.get("week_number") is not None})

            logs_resp = with_retry(
                lambda c, cid=cid: c.table("engagement_logs")
                .select("time_spent, comprehension_class, created_at")
                .eq("student_id", student_id)
                .eq("course_id", cid)
                .gte("created_at", window_start)
                .execute()
            )
            logs = getattr(logs_resp, "data", []) or []
            time_spent_minutes = round(sum(float(l.get("time_spent") or 0) for l in logs) / 60, 1)

            # Comprehension from the student's latest classifications per course
            comp_class = None
            all_logs_resp = with_retry(
                lambda c, cid=cid: c.table("engagement_logs")
                .select("comprehension_class")
                .eq("student_id", student_id)
                .eq("course_id", cid)
                .not_.is_("comprehension_class", "null")
                .order("created_at", desc=True)
                .limit(10)
                .execute()
            )
            comp_logs = getattr(all_logs_resp, "data", []) or []
            if comp_logs:
                comp_class = round(sum(float(l["comprehension_class"]) for l in comp_logs) / len(comp_logs), 2)
        except Exception:
            continue

        recommended_minutes = round(materials_count * MINUTES_PER_MATERIAL, 1) if materials_count else 0
        study_coverage = min(100.0, round(time_spent_minutes / recommended_minutes * 100, 1)) if recommended_minutes else 0.0

        courses.append({
            "course_id": cid,
            "course_title": course.get("title", "Untitled"),
            "course_code": course.get("code"),
            "materials_count": materials_count,
            "weeks_covered": weeks_covered,
            "time_spent_minutes": time_spent_minutes,
            "recommended_minutes": recommended_minutes,
            "study_coverage": study_coverage,
            "comprehension_class": comp_class,
            "warning": _warning_for(time_spent_minutes, recommended_minutes),
        })

    # Quiz performance per course (AI quizzes)
    quiz_stats = _quiz_stats(admin, student_id, course_ids)
    # Assignment stats
    assignment_stats = _assignment_stats(admin, student_id, course_ids)
    # Attendance
    attendance = _attendance_stats(admin, student_id, course_ids)

    for c in courses:
        c["quiz_avg"] = quiz_stats.get(c["course_id"])
        c["assignments_total"] = assignment_stats.get(c["course_id"], {}).get("total", 0)
        c["assignments_submitted"] = assignment_stats.get(c["course_id"], {}).get("submitted", 0)
        c["assignments_on_time"] = assignment_stats.get(c["course_id"], {}).get("on_time", 0)
        att = attendance.get("per_course", {}).get(c["course_id"])
        c["attendance_present_rate"] = att.get("present_rate") if att else None
        c["attendance_sessions"] = att.get("present_sessions") if att else None
        c["attendance_total"] = att.get("total_sessions") if att else None
        c["assignments_grade_avg"] = assignment_stats.get(c["course_id"], {}).get("grade_avg")
        predicted = _predict_percentage(
            quiz_avg=c["quiz_avg"],
            comprehension_class=c["comprehension_class"],
            attendance_rate=c["attendance_present_rate"],
            study_coverage=c["study_coverage"],
            assignment_avg=c["assignments_grade_avg"],
        )
        c["predicted_percentage"] = predicted["percentage"]
        c["predicted_grade"] = predicted["grade"]
        c["what_if"] = predicted["what_if"]

    overall_quiz_avg = _avg([c["quiz_avg"] for c in courses])
    overall_attendance = attendance.get("present_rate")
    overall_assignment_avg = _avg([c["assignments_grade_avg"] for c in courses if c["assignments_grade_avg"] is not None])

    overall_predicted = _predict_percentage(
        quiz_avg=overall_quiz_avg,
        comprehension_class=None,
        attendance_rate=overall_attendance,
        study_coverage=None,
        assignment_avg=overall_assignment_avg,
    )

    return {
        "student_id": student_id,
        "courses": courses,
        "overall": {
            "predicted_percentage": overall_predicted["percentage"],
            "predicted_grade": overall_predicted["grade"],
            "quiz_avg": overall_quiz_avg,
            "attendance_present_rate": overall_attendance,
            "attendance_sessions": attendance.get("present_sessions"),
            "attendance_total": attendance.get("total_sessions"),
            "active_warnings": sum(1 for c in courses if c["warning"]),
        },
    }


def _avg(values) -> Optional[float]:
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    return round(sum(vals) / len(vals), 1)


def _quiz_stats(admin, student_id, course_ids):
    stats = {cid: None for cid in course_ids}
    if not course_ids:
        return stats
    try:
        quiz_resp = with_retry(
            lambda c: c.table("generated_quizzes")
            .select("id, course_id")
            .in_("course_id", course_ids)
            .execute()
        )
        quizzes = getattr(quiz_resp, "data", []) or []
        quiz_course = {q["id"]: q["course_id"] for q in quizzes}
        quiz_ids = list(quiz_course.keys())
        if not quiz_ids:
            return stats

        subs_resp = with_retry(
            lambda c: c.table("quiz_submissions")
            .select("quiz_id, score")
            .eq("student_id", student_id)
            .in_("quiz_id", quiz_ids)
            .execute()
        )
        subs = getattr(subs_resp, "data", []) or []
        by_course = {cid: [] for cid in course_ids}
        for s in subs:
            cid = quiz_course.get(s["quiz_id"])
            if cid and s.get("score") is not None:
                by_course[cid].append(float(s["score"]))
        for cid, scores in by_course.items():
            if scores:
                stats[cid] = round(sum(scores) / len(scores), 1)
    except Exception as exc:
        print(f"[study] quiz stats error: {exc}")
    return stats


def _assignment_stats(admin, student_id, course_ids):
    stats = {cid: {"total": 0, "submitted": 0, "on_time": 0, "grade_avg": None} for cid in course_ids}
    if not course_ids:
        return stats
    try:
        assign_resp = with_retry(
            lambda c: c.table("assignments")
            .select("id, course_id, due_date")
            .in_("course_id", course_ids)
            .execute()
        )
        assignments = getattr(assign_resp, "data", []) or []
        by_course = {}
        for a in assignments:
            stats[a["course_id"]]["total"] += 1
            by_course[a["id"]] = a["course_id"]

        assign_ids = list(by_course.keys())
        if not assign_ids:
            return stats

        subs_resp = with_retry(
            lambda c: c.table("assignment_submissions")
            .select("assignment_id, submitted_at, score")
            .eq("student_id", student_id)
            .in_("assignment_id", assign_ids)
            .execute()
        )
        subs = getattr(subs_resp, "data", []) or []
        for s in subs:
            cid = by_course.get(s["assignment_id"])
            if not cid:
                continue
            stats[cid]["submitted"] += 1
            due = next((a["due_date"] for a in assignments if a["id"] == s["assignment_id"]), None)
            if _on_time(s.get("submitted_at"), due):
                stats[cid]["on_time"] += 1

        # Average of graded (scored) submissions — auto-graded assignments count here
        scored = {}
        for s in subs:
            score = s.get("score")
            if score is None:
                continue
            cid = by_course.get(s["assignment_id"])
            if not cid:
                continue
            scored.setdefault(cid, []).append(float(score))
        for cid, values in scored.items():
            stats[cid]["grade_avg"] = round(sum(values) / len(values), 1)
    except Exception as exc:
        print(f"[study] assignment stats error: {exc}")
    return stats


def _on_time(submitted_at, due_date):
    if not submitted_at or not due_date:
        return True
    try:
        return str(submitted_at)[:10] <= str(due_date)[:10]
    except Exception:
        return True


def _attendance_stats(admin, student_id, course_ids):
    """
    Session-based attendance. A session is a recorded class meeting: a
    distinct (course_id, logged_date) pair seen across *all* students'
    attendance_logs. Each student's attendance is the count of their own
    days logged as present, against the course's recorded meetings.
    """
    per_course = {cid: None for cid in course_ids}
    present_count = 0
    held_count = 0
    if course_ids:
        # Recorded meetings per course: distinct dates anyone logged.
        held_dates = {cid: set() for cid in course_ids}
        try:
            held_resp = with_retry(
                lambda c: c.table("attendance_logs")
                .select("course_id, logged_date")
                .in_("course_id", course_ids)
                .execute()
            )
            for l in (getattr(held_resp, "data", []) or []):
                cid = l.get("course_id")
                if cid in held_dates and l.get("logged_date"):
                    held_dates[cid].add(str(l["logged_date"])[:10])
        except Exception as exc:
            print(f"[study] attendance held-sessions error: {exc}")

        # This student's statuses per course (one row per course per day).
        by_course = {cid: [] for cid in course_ids}
        try:
            att_resp = with_retry(
                lambda c: c.table("attendance_logs")
                .select("course_id, status")
                .eq("student_id", student_id)
                .in_("course_id", course_ids)
                .execute()
            )
            for l in (getattr(att_resp, "data", []) or []):
                cid = l.get("course_id")
                if cid in by_course:
                    by_course[cid].append(l.get("status"))
        except Exception as exc:
            print(f"[study] attendance stats error: {exc}")

        for cid, statuses in by_course.items():
            held = len(held_dates.get(cid, set())) or len(statuses)
            if held == 0:
                continue
            present = sum(1 for s in statuses if s == "present")
            per_course[cid] = {
                "present_sessions": present,
                "total_sessions": held,
                "present_rate": round(present / held * 100, 1),
            }
            present_count += present
            held_count += held

    present_rate = round(present_count / held_count * 100, 1) if held_count else None
    return {
        "present_rate": present_rate,
        "present_sessions": present_count,
        "total_sessions": held_count,
        "per_course": per_course,
    }


def _predict_percentage(quiz_avg=None, comprehension_class=None, attendance_rate=None, study_coverage=None, assignment_avg=None):
    """
    Blend quiz, assignment, comprehension, attendance and study-time signals
    into a 0-100 predicted percentage. Any missing signal is dropped
    (renormalised). When an assignment average exists it weighs equally with
    quizzes and comprehension shifts into a secondary slot.
    Returns the base prediction plus a "what-if" projection if the student
    raised their study time to the weekly target.
    """
    components = []
    weights = []

    if quiz_avg is not None:
        components.append(quiz_avg)
        weights.append(0.4)
    if comprehension_class is not None:
        components.append(comprehension_class / 2.0 * 100)
        weights.append(0.3)
    if attendance_rate is not None:
        components.append(attendance_rate)
        weights.append(0.15)
    if study_coverage is not None:
        components.append(study_coverage)
        weights.append(0.15)

    # With a graded assignment average present, rebalance: assignments carry
    # the weight of comprehension + half of quiz performance.
    if assignment_avg is not None:
        components.append(assignment_avg)
        weights.append(0.35)
        for i in range(len(weights) - 1):
            weights[i] *= 0.65

    if not components:
        return {"percentage": None, "grade": "N/A", "what_if": None}

    total_w = sum(weights)
    base = round(sum(c * w for c, w in zip(components, weights)) / total_w, 1)

    what_if = None
    if study_coverage is not None and study_coverage < 100:
        boost = round(min(15.0, (100 - study_coverage) * 0.15), 1)
        projected = round(min(100.0, base + boost), 1)
        what_if = {
            "projected_percentage": projected,
            "projected_grade": letter_grade(projected),
            "note": "If you reach your weekly study-time target, your predicted performance could rise.",
        }

    return {"percentage": base, "grade": letter_grade(base), "what_if": what_if}
