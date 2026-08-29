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
from datetime import datetime, timedelta, timezone
from app.database import get_admin_client, with_retry
from app.core.security import get_current_user, require_role
from app.services.engagement_analyzer import get_analyzer

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
    highlights: int = Field(0, ge=0, description="Text highlights made on PDF materials")
    video_watch_seconds: float = Field(0.0, ge=0, description="Seconds of actual playback consumed")
    video_coverage_pct: float = Field(0.0, ge=0, le=100, description="Unique footage covered (%)")
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
        # Regular content: full telemetry available. Highlighting a passage is
        # one of the strongest active-reading signals, so it carries real weight.
        # Video materials earn credit for real playback seconds and unique
        # footage coverage — scrubbing to the end never counts as watching.
        score = min(
            100,
            max(
                0,
                round(
                    0.3 * min(payload.scroll_depth, 100)
                    + 0.2 * min(payload.mouse_movements, 200)
                    + 0.25 * payload.clicks
                    + 0.2 * min(payload.time_spent, 300)
                    + 2.5 * min(payload.highlights, 10)
                    + 0.05 * min(payload.video_watch_seconds, 600)
                    + 0.15 * payload.video_coverage_pct
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
                    "highlights": payload.highlights,
                    "video_watch_seconds": payload.video_watch_seconds,
                    "video_coverage_pct": payload.video_coverage_pct,
                    "engagement_score": score,
                    "engagement_level": level,
                    # Model classification is intentionally left NULL here. The
                    # Two-Tower classes only get populated by /auto-classify, so
                    # lecturer/HOD aggregations don't count placeholder heartbeats.
                    "engagement_class": None,
                    "engagement_label": None,
                    "comprehension_class": None,
                    "comprehension_label": None,
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
    result = get_analyzer().classify(student_dict, interaction_dict)

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


@router.get("/student/{student_id}/summary")
def get_student_engagement_summary(student_id: str, user=Depends(get_current_user)):
    """
    Full-history engagement summary for the student performance page.

    The plain /student/{id} endpoint only returns the 10 most recent rows,
    which makes page-level averages misleading. This aggregates ALL logs:
      - real totals (sessions, materials, study minutes, highlights, video)
      - High/Medium/Low distribution over STUDY SESSIONS (ticks <30min apart
        group into one session; a session's score is duration-weighted), so
        one long sitting no longer counts a dozen times
      - a 14-day daily series (minutes + avg score) for the activity chart
      - this-week vs last-week average with trend delta
      - the 5 most recent sessions enriched with material/course titles
    """
    if user.get("role") == "student" and user["id"] != student_id:
        raise HTTPException(status_code=403, detail="Access denied.")

    try:
        admin = get_admin_client()
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("material_id,course_id,engagement_score,engagement_level,"
                    "time_spent,highlights,video_watch_seconds,created_at")
            .eq("student_id", student_id)
            .order("created_at", desc=False)
            .limit(5000)
            .execute()
        )
        logs = resp.data or []
    except Exception as e:
        raise HTTPException(500, detail=str(e))

    now = datetime.now(timezone.utc)

    def parse_ts(v):
        if not v:
            return None
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            return None

    def level_of(score):
        return "High" if score >= 75 else ("Medium" if score >= 40 else "Low")

    # ── Group ticks into study sessions: a gap > 30 min starts a new one ────
    sessions = []
    for l in logs:
        ts = parse_ts(l.get("created_at"))
        if ts is None:
            continue
        score = float(l.get("engagement_score") or 0)
        secs = float(l.get("time_spent") or 0)
        weight = max(secs, 1.0)
        if sessions and (ts - sessions[-1]["end"]).total_seconds() <= 1800:
            s = sessions[-1]
            s["end"] = max(s["end"], ts)
            s["secs"] += secs
            s["wsum"] += score * weight
            s["wgt"] += weight
            s["highlights"] += int(l.get("highlights") or 0)
            s["video_secs"] += float(l.get("video_watch_seconds") or 0)
            if l.get("material_id"):
                s["materials"].add(l["material_id"])
        else:
            sessions.append({
                "start": ts, "end": ts, "secs": secs,
                "wsum": score * weight, "wgt": weight,
                "highlights": int(l.get("highlights") or 0),
                "video_secs": float(l.get("video_watch_seconds") or 0),
                "materials": {l["material_id"]} if l.get("material_id") else set(),
            })

    sess_scores = [round(s["wsum"] / s["wgt"]) for s in sessions]

    totals = {
        "sessions": len(sessions),
        "materials_viewed": len({l.get("material_id") for l in logs if l.get("material_id")}),
        "minutes": round(sum(s["secs"] for s in sessions) / 60),
        "highlights": sum(s["highlights"] for s in sessions),
        "video_minutes": round(sum(s["video_secs"] for s in sessions) / 60, 1),
    }

    dist_counts = {"High": 0, "Medium": 0, "Low": 0}
    for sc in sess_scores:
        dist_counts[level_of(sc)] += 1
    n_sess = max(len(sessions), 1)
    distribution = {k: round(v * 100 / n_sess) for k, v in dist_counts.items()}

    # ── Daily series, last 14 days ──────────────────────────────────────────
    days = {}
    for l in logs:
        ts = parse_ts(l.get("created_at"))
        if ts is None or (now - ts).days > 13:
            continue
        key = ts.date().isoformat()
        d = days.setdefault(key, {"secs": 0.0, "wsum": 0.0, "wgt": 0.0})
        secs = float(l.get("time_spent") or 0)
        w = max(secs, 1.0)
        d["secs"] += secs
        d["wsum"] += float(l.get("engagement_score") or 0) * w
        d["wgt"] += w
    daily = []
    for i in range(13, -1, -1):
        key = (now - timedelta(days=i)).date().isoformat()
        d = days.get(key)
        daily.append({
            "date": key,
            "minutes": round(d["secs"] / 60) if d else 0,
            "score": round(d["wsum"] / d["wgt"]) if d and d["wgt"] else 0,
        })

    # ── Week-over-week trend (duration-weighted averages) ───────────────────
    week_logs, prev_week_logs = [], []
    active_days = set()
    for l in logs:
        ts = parse_ts(l.get("created_at"))
        if ts is None:
            continue
        age = now - ts
        if age <= timedelta(days=7):
            week_logs.append(l)
            active_days.add(ts.date().isoformat())
        elif timedelta(days=7) < age <= timedelta(days=14):
            prev_week_logs.append(l)

    def weighted_avg(rows):
        tw = sum(max(float(r.get("time_spent") or 0), 1.0) for r in rows)
        if not tw:
            return 0
        return round(sum(float(r.get("engagement_score") or 0) * max(float(r.get("time_spent") or 0), 1.0) for r in rows) / tw)

    this_week = weighted_avg(week_logs)
    last_week = weighted_avg(prev_week_logs)

    # ── Recent sessions with material/course titles ─────────────────────────
    recent_sessions = []
    if sessions:
        m2c = {l.get("material_id"): l.get("course_id") for l in logs if l.get("material_id")}
        last5 = list(reversed(sessions[-5:]))
        mat_ids = sorted({m for s in last5 for m in s["materials"]})
        course_ids = sorted({m2c[m] for m in mat_ids if m2c.get(m)})
        mat_titles, course_titles = {}, {}
        try:
            if mat_ids:
                r1 = with_retry(lambda c: c.table("materials").select("id,title").in_("id", mat_ids).execute())
                mat_titles = {r["id"]: r.get("title") or "" for r in (r1.data or [])}
            if course_ids:
                r2 = with_retry(lambda c: c.table("courses").select("id,title,code").in_("id", course_ids).execute())
                course_titles = {
                    r["id"]: f'{r.get("title") or ""} ({r.get("code") or ""})'.replace(" ()", "")
                    for r in (r2.data or [])
                }
        except Exception as e:
            print(f"[engagement] summary title lookup failed: {e}")

        for s in last5:
            mid = next(iter(s["materials"]), None)
            recent_sessions.append({
                "when": s["start"].isoformat(),
                "minutes": round(s["secs"] / 60),
                "level": level_of(round(s["wsum"] / s["wgt"])),
                "highlights": s["highlights"],
                "material_title": mat_titles.get(mid) or "Study session",
                "course_title": course_titles.get(m2c.get(mid, ""), ""),
            })

    return {
        "totals": totals,
        "distribution": distribution,
        "session_count": len(sessions),
        "daily": daily,
        "trend": {
            "this_week_avg": this_week,
            "last_week_avg": last_week,
            "delta": this_week - last_week,
            "active_days": len(active_days),
        },
        "recent_sessions": recent_sessions,
    }


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
    # NOTE: the Two-Tower model was trained on UCI grades (0-20 scale), while
    # the platform stores quiz scores as percentages (0-100). Raw percentages
    # would saturate the interaction tower, so they are rescaled by /5 below.
    # Both quiz systems feed the pool: legacy quizzes (quiz_results) and
    # AI-generated material quizzes (quiz_submissions).
    interaction_defaults = {"failures": 0, "absences": 0, "G1": 10, "G2": 10, "G3": 10, "freetime": 3}
    latest_by_quiz: dict = {}
    course_scores = []

    try:
        quiz_resp = with_retry(
            lambda c: c.table("quiz_results")
            .select("quiz_id, score, quizzes!inner(course_id)")
            .eq("student_id", payload.student_id)
            .order("submitted_at", desc=True)
            .limit(30)
            .execute()
        )
        quiz_data = getattr(quiz_resp, "data", []) or []

        # Rows arrive newest-first: keep each quiz's most recent attempt.
        for qr in quiz_data:
            course_info = qr.get("quizzes")
            if not (isinstance(course_info, dict) and course_info.get("course_id") == payload.course_id):
                continue
            score = float(qr.get("score", 10))
            course_scores.append(score)
            qid = qr.get("quiz_id")
            if qid and qid not in latest_by_quiz:
                latest_by_quiz[qid] = score
    except Exception as e:
        print(f"[auto-classify] Could not fetch quiz results: {e}")

    # AI-generated quiz attempts join the same percentage pool. The two pools
    # are merged newest-per-table rather than globally re-sorted — close enough
    # for a G1/G2/G3 proxy.
    try:
        ai_resp = with_retry(
            lambda c: c.table("quiz_submissions")
            .select("quiz_id, score, generated_quizzes!inner(course_id)")
            .eq("student_id", payload.student_id)
            .order("submitted_at", desc=True)
            .limit(30)
            .execute()
        )
        for qr in (getattr(ai_resp, "data", []) or []):
            gq = qr.get("generated_quizzes")
            if not (isinstance(gq, dict) and gq.get("course_id") == payload.course_id):
                continue
            score = float(qr.get("score", 10))
            course_scores.append(score)
            qid = qr.get("quiz_id")
            if qid and qid not in latest_by_quiz:
                latest_by_quiz[qid] = score
    except Exception as e:
        print(f"[auto-classify] Could not fetch AI quiz results: {e}")

    if latest_by_quiz:
        # UCI-style "failures" proxy: distinct course quizzes whose latest
        # attempt scored under 40% (model expects a 0-4 feature).
        interaction_defaults["failures"] = min(
            sum(1 for s in latest_by_quiz.values() if s < 40), 4)

    if course_scores:
        # Percentage -> UCI grade conversion.
        interaction_defaults["G1"] = round(course_scores[-1] / 5.0, 2)
        interaction_defaults["G2"] = round((course_scores[len(course_scores) // 2] if len(course_scores) >= 2 else course_scores[0]) / 5.0, 2)
        interaction_defaults["G3"] = round(course_scores[0] / 5.0, 2)  # Latest score

    # ── Absences come from self-reported attendance logs ──────────────────────
    try:
        att_resp = with_retry(
            lambda c: c.table("attendance_logs")
            .select("status")
            .eq("student_id", payload.student_id)
            .eq("course_id", payload.course_id)
            .execute()
        )
        att_rows = getattr(att_resp, "data", []) or []
        if att_rows:
            absent_days = sum(1 for r in att_rows if r.get("status") == "absent")
            interaction_defaults["absences"] = float(min(absent_days, 93))
    except Exception as e:
        print(f"[auto-classify] Could not fetch attendance: {e}")

    # ── Student tower: use sensible defaults (UCI dataset midpoints) ──────────
    # Documented limitation: the platform collects no demographic fields
    # (age/sex/address/parent education etc.), so every student shares this
    # tower profile; discrimination comes from the interaction tower.
    student_defaults = {
        "age": 17, "sex": 1, "address": 1, "famsize": 1,
        "Pstatus": 1, "Medu": 2, "Fedu": 2, "traveltime": 1, "studytime": 2,
    }

    # ── Run Two-Tower inference ───────────────────────────────────────────────
    result = get_analyzer().classify(student_defaults, interaction_defaults)

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
