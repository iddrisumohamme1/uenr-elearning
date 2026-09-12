# File: backend/app/routes/engagement.py
# Purpose: Logs student telemetry, runs Two-Tower Neural Network inference,
#          and persists engagement + comprehension classifications to Supabase.
#
# Two-Tower feature aggregation + inference live in
# app.services.engagement_features (shared with the historical backfill
# script backend/scripts/backfill_engagement.py), so the analysis here and
# the data reconciliation can never drift.

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timedelta, timezone
from app.database import get_admin_client, with_retry
from app.core.security import get_current_user, require_role
from app.services.engagement_analyzer import get_analyzer
from app.services.engagement_features import comprehension_from_scores, compute_classification
from app.services.insight_messages import push_insight_message

router = APIRouter(prefix="/api/engagement", tags=["engagement"])


# ── Request / Response Models ─────────────────────────────────────────────────

class StudentProfile(BaseModel):
    """5 demographic features → Student Tower (OULAD encodings, see defaults)"""
    gender:           float = Field(1.0, ge=0, le=1, description="0=Female, 1=Male")
    age_band:         float = Field(1.0, ge=0, le=2, description="0-35=0, 35-55=1, 55+=2")
    highest_education: float = Field(1.0, ge=0, le=3,
                                     description="NoFormal=0, LowerA=1, ALevel=2, Higher=3")
    imd_band:         float = Field(5.0, ge=0, le=9, description="IMD deprivation decile 0-9")
    disability:       float = Field(0.0, ge=0, le=1, description="0=No, 1=Yes")


class InteractionLog(BaseModel):
    """7 behavioural features → Interaction Tower (OULAD telemetry)"""
    total_activities:               float = Field(0.0, ge=0, description="Total activity volume (mins)")
    unique_materials:               float = Field(0.0, ge=0, description="Distinct materials accessed")
    active_days:                    float = Field(0.0, ge=0, description="Distinct active days")
    avg_daily_activity:             float = Field(0.0, ge=0, description="Total / active days")
    activity_per_registered_day:    float = Field(0.0, ge=0, description="Total / enrolled days")
    days_since_last_activity:       float = Field(0.0, ge=0, description="Days since last telemetry")
    assessment_count:               float = Field(0.0, ge=0, description="Distinct graded assessments")


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
    low_confidence:             bool = False


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
        "total_activities":            interaction_dict["total_activities"],
        "unique_materials":            interaction_dict["unique_materials"],
        "active_days":                 interaction_dict["active_days"],
        "avg_daily_activity":          interaction_dict["avg_daily_activity"],
        "activity_per_registered_day": interaction_dict["activity_per_registered_day"],
        "days_since_last_activity":    interaction_dict["days_since_last_activity"],
        "assessment_count":            interaction_dict["assessment_count"],
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
                # Wall-clock span the session was open, vs. the active minutes
                # above. Lets the UI say "28 min open · 1 min active" so a Low
                # rating on a long-but-mostly-idle session reads sensibly.
                "open_minutes": max(0, round((s["end"] - s["start"]).total_seconds() / 60)),
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





def _material_course_id(admin, material_id):
    """Resolve the course a material belongs to, or None."""
    try:
        resp = with_retry(
            lambda c: c.table("materials").select("course_id").eq("id", material_id).limit(1).execute()
        )
        rows = getattr(resp, "data", []) or []
        if rows and rows[0].get("course_id"):
            return rows[0]["course_id"]
    except Exception as e:
        print(f"[material-assessment] material->course lookup failed: {e}")
    return None


def _material_assessment(admin, student_id, material_id, course_id=None):
    """(class, label) of a material's latest graded assessment, or None.

    Bridges a student's actual quiz/assignment result into the per-material
    comprehension shown on the course breakdown, so a material the student
    scored well on (e.g. 70% -> Moderate) never displays a stale Low because the
    newer quiz wasn't recorded into an engagement_logs classification row.
    Only AI quizzes (generated_quizzes.material_id) and auto/shared assignments
    (assignments.source_material_id) link to a material.
    """
    if course_id is None:
        course_id = _material_course_id(admin, material_id)
    if not course_id:
        return None

    best = None  # (sortable_timestamp, score)

    def _consider(ts_raw, score):
        nonlocal best
        try:
            from datetime import datetime
            ts = None
            if ts_raw:
                try:
                    ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
                except ValueError:
                    ts = None
        except Exception:
            ts = None
        if best is None or (ts is not None and (best[0] is None or ts > best[0])):
            best = (ts, score)

    try:
        gq_resp = with_retry(
            lambda c: c.table("generated_quizzes")
            .select("id").eq("material_id", material_id).eq("course_id", course_id).execute()
        )
        qids = [q["id"] for q in (getattr(gq_resp, "data", []) or []) if q.get("id")]
        if qids:
            sub_resp = with_retry(
                lambda c: c.table("quiz_submissions")
                .select("score, submitted_at").eq("student_id", student_id)
                .in_("quiz_id", qids).order("submitted_at", desc=True).limit(1).execute()
            )
            for s in (getattr(sub_resp, "data", []) or []):
                if s.get("score") is None:
                    continue
                _consider(s.get("submitted_at"), float(s["score"]))
    except Exception as e:
        print(f"[material-assessment] quiz lookup failed: {e}")

    try:
        a_resp = with_retry(
            lambda c: c.table("assignments")
            .select("id").eq("course_id", course_id).eq("source_material_id", material_id).execute()
        )
        a_ids = [a["id"] for a in (getattr(a_resp, "data", []) or []) if a.get("id")]
        if a_ids:
            sub_resp = with_retry(
                lambda c: c.table("assignment_submissions")
                .select("score, submitted_at").eq("student_id", student_id)
                .in_("assignment_id", a_ids).order("submitted_at", desc=True).limit(1).execute()
            )
            for s in (getattr(sub_resp, "data", []) or []):
                if s.get("score") is None:
                    continue
                _consider(s.get("submitted_at"), float(s["score"]))
    except Exception as e:
        print(f"[material-assessment] assignment lookup failed: {e}")

    if best is None:
        return None
    return comprehension_from_scores([best[1]])


def _course_material_comprehension(admin, student_id, course_id):
    """material_id -> (class, label) for every assessed material in a course.

    Efficiently maps a student's AI-quiz and assignment scores to their source
    material so the course-level comprehension aggregate can reflect real
    assessment results per material rather than stale telemetry.
    """
    result = {}
    try:
        gq_resp = with_retry(
            lambda c: c.table("generated_quizzes")
            .select("id, material_id").eq("course_id", course_id).execute()
        )
        mid_by_quiz = {
            q["id"]: q.get("material_id")
            for q in (getattr(gq_resp, "data", []) or [])
            if q.get("id") and q.get("material_id")
        }
        qids = list(mid_by_quiz.keys())
        if qids:
            sub_resp = with_retry(
                lambda c: c.table("quiz_submissions")
                .select("quiz_id, score, submitted_at").eq("student_id", student_id)
                .in_("quiz_id", qids).order("submitted_at", desc=True).execute()
            )
            seen_quiz = set()
            for s in (getattr(sub_resp, "data", []) or []):
                qid = s.get("quiz_id")
                if qid in seen_quiz or s.get("score") is None:
                    continue
                seen_quiz.add(qid)
                mid = mid_by_quiz.get(qid)
                if mid is None:
                    continue
                comp = comprehension_from_scores([float(s["score"])])
                if comp is not None:
                    result[mid] = comp
    except Exception as e:
        print(f"[course-material-comp] quiz lookup failed: {e}")

    try:
        a_resp = with_retry(
            lambda c: c.table("assignments")
            .select("id, source_material_id").eq("course_id", course_id).execute()
        )
        mid_by_assign = {
            a["id"]: a.get("source_material_id")
            for a in (getattr(a_resp, "data", []) or [])
            if a.get("id") and a.get("source_material_id")
        }
        a_ids = list(mid_by_assign.keys())
        if a_ids:
            sub_resp = with_retry(
                lambda c: c.table("assignment_submissions")
                .select("assignment_id, score, submitted_at").eq("student_id", student_id)
                .in_("assignment_id", a_ids).order("submitted_at", desc=True).execute()
            )
            seen_assign = set()
            for s in (getattr(sub_resp, "data", []) or []):
                aid = s.get("assignment_id")
                if aid in seen_assign or s.get("score") is None:
                    continue
                seen_assign.add(aid)
                mid = mid_by_assign.get(aid)
                if mid is None:
                    continue
                comp = comprehension_from_scores([float(s["score"])])
                if comp is not None:
                    result[mid] = comp
    except Exception as e:
        print(f"[course-material-comp] assignment lookup failed: {e}")

    return result


# ── Auto-Classify: bridges telemetry logs with Two-Tower NN ───────────────────

class AutoClassifyRequest(BaseModel):
    student_id: str
    course_id: str
    material_id: Optional[str] = None


def _run_classification(admin, student_id, course_id, material_id=None):
    """Compute, persist and return an engagement + comprehension classification.

    Shared by the /auto-classify endpoint and the auto re-classify that runs
    after a student submits a quiz or graded assignment, so a fresh assessment
    immediately refreshes the stored label instead of waiting for the next
    study session.

    Feature aggregation + Two-Tower inference live in
    `app.services.engagement_features.compute_classification` (shared with the
    historical backfill script), so live classification and the data
    reconciliation can never drift.

    Raises RuntimeError if the classification cannot be persisted — callers
    that should surface a 5xx convert it to an HTTPException; post-submit
    triggers catch it and log, never failing the student-facing response.
    """
    result, record = compute_classification(admin, student_id, course_id, material_id=material_id)

    try:
        admin.table("engagement_logs").insert(record).execute()
    except Exception as e:
        # Persisting the classification is the whole point of the classifier.
        # If it fails we must NOT report success — an empty result here is
        # exactly how dashboards end up showing no classifications despite
        # students reading materials. Surface it so it is diagnosable.
        print(f"[auto-classify] DB WRITE FAILED for student={student_id} "
              f"course={course_id}: {e}")
        raise RuntimeError("Classification computed but could not be saved.")

    # Notify the student in their inbox after a fresh classification. Never
    # blocks the response the student is waiting for.
    try:
        push_insight_message(
            admin,
            student_id,
            course_id,
            kind="classification",
            latest={
                "engagement_class": result["engagement_class"],
                "comprehension_class": result["comprehension_class"],
                "low_confidence": record["low_confidence"],
            },
        )
    except Exception as e:
        print(f"[auto-classify] Insight message skipped: {e}")

    return EngagementResult(
        student_id=student_id,
        course_id=course_id,
        low_confidence=record["low_confidence"],
        **result,
    )


@router.post("/auto-classify", response_model=EngagementResult, status_code=201)
def auto_classify(payload: AutoClassifyRequest, user=Depends(get_current_user)):
    """
    Automatically classifies a student using available data from quiz results
    and material telemetry. Designed to be called from the frontend after a
    material-viewing session to trigger Two-Tower classification.

    Pulls the student's latest quiz and assignment scores for the course
    (OULAD assessment_count) and builds the OULAD interaction feature set from
    their real telemetry, using documented defaults for demographics not
    stored in Supabase.
    """
    # Students can only auto-classify themselves
    if user.get("role") == "student" and user["id"] != payload.student_id:
        raise HTTPException(status_code=403, detail="Students can only classify their own engagement.")
    admin = get_admin_client()
    try:
        return _run_classification(
            admin,
            payload.student_id,
            payload.course_id,
            material_id=payload.material_id,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


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
            .select("student_id, course_id, engagement_class, engagement_label, comprehension_class, comprehension_label, low_confidence, created_at")
            .eq("student_id", student_id)
            .not_.is_("engagement_class", "null")
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


@router.get("/material/{material_id}")
def get_material_summary(material_id: str, user=Depends(get_current_user)):
    """Per-material engagement/comprehension summary for the current student.

    Aggregates the student's engagement_logs rows for a single material so the
    reading surface can show, as soon as a material is opened, how engaged they
    have been with it and their latest comprehension prediction. Comprehension is
    course-level (derived from quiz grades through the Two-Tower model) — this
    returns the most recent prediction recorded for this material.
    """
    try:
        admin = get_admin_client()
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select(
                "course_id, engagement_score, engagement_level, "
                "engagement_class, engagement_label, "
                "comprehension_class, comprehension_label, created_at"
            )
            .eq("student_id", user["id"])
            .eq("material_id", material_id)
            .order("created_at", desc=True)
            .execute()
        )
        logs = getattr(resp, "data", []) or []

        # The material's own comprehension result takes precedence over any
        # telemetry-derived classification: if the student actually took an
        # assessment for this material (AI quiz or assignment), that result is
        # the honest signal — e.g. a 70% quiz shows Moderate, never a stale Low
        # recorded before the quiz was submitted.
        assessment = _material_assessment(
            admin, user["id"], material_id,
            course_id=(logs[0].get("course_id") if logs else None),
        )

        if not logs:
            return {
                "material_id": material_id,
                "student_id": user["id"],
                "has_history": False,
                "sessions": 0,
                "latest_engagement_score": None,
                "latest_engagement_level": None,
                "latest_engagement_class": None,
                "latest_engagement_label": None,
                "latest_comprehension_class": assessment[0] if assessment else None,
                "latest_comprehension_label": assessment[1] if assessment else None,
            }

        session_scores = [l.get("engagement_score") for l in logs if l.get("engagement_score") is not None]
        latest = logs[0]

        # Engagement comes from the most recent scored row; comprehension comes
        # from the most recent row that a model classification was written to
        # (only /auto-classify populates the class/label fields).
        eng_row = next((l for l in logs if l.get("engagement_score") is not None), None)
        eng_cls_row = next((l for l in logs if l.get("engagement_class") is not None), None)
        comp_row = next(
            (l for l in logs if l.get("comprehension_label") is not None),
            None,
        )

        return {
            "material_id": material_id,
            "student_id": user["id"],
            "course_id": latest.get("course_id"),
            "has_history": True,
            "sessions": len(logs),
            "avg_engagement_score": round(sum(session_scores) / len(session_scores)) if session_scores else None,
            "latest_engagement_score": (eng_row or {}).get("engagement_score"),
            "latest_engagement_level": (eng_row or {}).get("engagement_level"),
            "latest_engagement_class": (eng_cls_row or {}).get("engagement_class"),
            "latest_engagement_label": (eng_cls_row or {}).get("engagement_label"),
            "latest_comprehension_class": assessment[0] if assessment else (comp_row or {}).get("comprehension_class"),
            "latest_comprehension_label": assessment[1] if assessment else (comp_row or {}).get("comprehension_label"),
            "last_activity_at": latest.get("created_at"),
        }
    except Exception as e:
        raise HTTPException(500, detail=str(e))
