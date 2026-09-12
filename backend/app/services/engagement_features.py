# File: backend/app/services/engagement_features.py
# Purpose: Shared logic that turns raw platform telemetry into the OULAD
#          interaction feature set and runs the Two-Tower classification,
#          without any persistence side effects.
#
# Single source of truth used by:
#   - app/routes/engagement.py  ->  /auto-classify (persists + notifies)
#   - scripts/backfill_engagement.py (reconciles historical rows in place)
#
# Interaction feature semantics (built from real platform telemetry):
#   total_activities            Σ time_spent (seconds→minutes)
#   unique_materials            distinct material_id
#   active_days                 distinct day of created_at
#   avg_daily_activity          total / max(active_days, 1)
#   activity_per_registered_day total / max(enrolled days, 1)
#   days_since_last_activity    now − last telemetry day (0 if fresh)
#   assessment_count            distinct graded quizzes + assignments

from datetime import datetime, timezone

from app.database import with_retry
from app.services.engagement_analyzer import ENGAGEMENT_LABELS, get_analyzer

# ── Comprehension thresholds (mirror quiz same-page labels) ───────────────────
# >=80 Good, >=50 Moderate, else Low. The label reflects the MOST RECENT scored
# assessment so a freshly improved quiz immediately lifts the comprehension
# label instead of leaving a stale one.
_COMPREHENSION_OK_MIN = 80.0
_COMPREHENSION_MOD_MIN = 50.0

# The platform collects no demographic fields (gender/age/education/IMD/
# disability), so every student shares this Student-Tower profile; the
# discrimination then comes entirely from the interaction tower.
STUDENT_DEFAULTS = {
    "gender": 1.0,
    "age_band": 1.0,
    "highest_education": 1.0,
    "imd_band": 5.0,
    "disability": 0.0,
}


def parse_utc(v):
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def comprehension_from_scores(scores):
    """Map a student's real quiz/assignment percentages to (class, label).

    Uses the most recent score in ``scores`` (callers hand over the list in
    chronological order, newest last). Returns None when there are no scored
    assessments — callers then fall back to the ML model's comprehension output.
    """
    if not scores:
        return None
    latest = scores[-1]
    if latest >= _COMPREHENSION_OK_MIN:
        return 2, "Good Comprehension"
    if latest >= _COMPREHENSION_MOD_MIN:
        return 1, "Moderate Comprehension"
    return 0, "Low Comprehension"


def assignment_scores(admin, student_id, course_id):
    """Latest graded assignment scores for a student in a course.

    Mirrors the visibility rule used by the assignments list: shared
    (manually created) assignments plus the student's own auto-generated ones.
    Only graded (non-null) scores count; they are clamped to 0-100 and returned
    newest-first so older attempts never shadow recent work.
    """
    scores = []
    try:
        assign_resp = with_retry(
            lambda c: c.table("assignments")
            .select("id, auto_generated, student_id")
            .eq("course_id", course_id)
            .execute()
        )
        assignments = getattr(assign_resp, "data", []) or []
        visible = [
            a for a in assignments
            if not a.get("auto_generated") or a.get("student_id") == student_id
        ]
        a_ids = [a["id"] for a in visible if a.get("id")]
        if not a_ids:
            return scores

        subs_resp = with_retry(
            lambda c: c.table("assignment_submissions")
            .select("assignment_id, submitted_at, score")
            .eq("student_id", student_id)
            .in_("assignment_id", a_ids)
            .order("submitted_at", desc=True)
            .execute()
        )
        for s in (getattr(subs_resp, "data", []) or []):
            score = s.get("score")
            if score is None:
                continue
            try:
                scores.append(max(0.0, min(100.0, float(score))))
            except (TypeError, ValueError):
                continue
    except Exception as e:
        print(f"[features] Could not fetch assignment scores: {e}")
    return scores


def graded_assessment_count(admin, student_id, course_id):
    """Distinct graded assessments a student has in a course (quizzes + assignments).

    Counts distinct graded items (not resubmission attempts) to match OULAD's
    assessment_count intent.
    """
    quiz_ids = set()
    try:
        q_resp = with_retry(
            lambda c: c.table("quiz_results")
            .select("quiz_id, score, quizzes!inner(course_id)")
            .eq("student_id", student_id)
            .execute()
        )
        for qr in (getattr(q_resp, "data", []) or []):
            cinfo = qr.get("quizzes")
            if not (isinstance(cinfo, dict) and cinfo.get("course_id") == course_id):
                continue
            if qr.get("score") is not None and qr.get("quiz_id"):
                quiz_ids.add(qr["quiz_id"])
    except Exception as e:
        print(f"[graded-count] quiz_results error: {e}")

    try:
        ai_resp = with_retry(
            lambda c: c.table("quiz_submissions")
            .select("quiz_id, score, generated_quizzes!inner(course_id)")
            .eq("student_id", student_id)
            .execute()
        )
        for qr in (getattr(ai_resp, "data", []) or []):
            gq = qr.get("generated_quizzes")
            if not (isinstance(gq, dict) and gq.get("course_id") == course_id):
                continue
            if qr.get("score") is not None and qr.get("quiz_id"):
                quiz_ids.add(qr["quiz_id"])
    except Exception as e:
        print(f"[graded-count] quiz_submissions error: {e}")

    assign_ids = set()
    try:
        assign_resp = with_retry(
            lambda c: c.table("assignments")
            .select("id, auto_generated, student_id")
            .eq("course_id", course_id)
            .execute()
        )
        assignments = getattr(assign_resp, "data", []) or []
        visible = [
            a for a in assignments
            if not a.get("auto_generated") or a.get("student_id") == student_id
        ]
        a_ids = [a["id"] for a in visible if a.get("id")]
        if a_ids:
            subs_resp = with_retry(
                lambda c: c.table("assignment_submissions")
                .select("assignment_id, score")
                .eq("student_id", student_id)
                .in_("assignment_id", a_ids)
                .execute()
            )
            for s in (getattr(subs_resp, "data", []) or []):
                if s.get("score") is not None and s.get("assignment_id"):
                    assign_ids.add(s["assignment_id"])
    except Exception as e:
        print(f"[graded-count] assignment lookup error: {e}")

    return len(quiz_ids) + len(assign_ids)


def course_graded_scores(admin, student_id, course_id):
    """Every scored assessment a student has in a course, globally time-sorted.

    Merges legacy quizzes (quiz_results), AI-generated quizzes
    (quiz_submissions) and graded assignments (assignment_submissions) into a
    single chronological list of ``(submitted_at, score)`` drawn from one
    timestamp column, so the newest assessment is always last regardless of
    source. Payload scores are stored on a 0-100 percentage scale.
    """
    rows = []
    try:
        quiz_resp = with_retry(
            lambda c: c.table("quiz_results")
            .select("submitted_at, score, quizzes!inner(course_id)")
            .eq("student_id", student_id)
            .execute()
        )
        for qr in (getattr(quiz_resp, "data", []) or []):
            cinfo = qr.get("quizzes")
            if not (isinstance(cinfo, dict) and cinfo.get("course_id") == course_id):
                continue
            score = qr.get("score")
            if score is None:
                continue
            rows.append((qr.get("submitted_at"), float(score)))
    except Exception as e:
        print(f"[graded-scores] quiz_results error: {e}")

    try:
        ai_resp = with_retry(
            lambda c: c.table("quiz_submissions")
            .select("submitted_at, score, generated_quizzes!inner(course_id)")
            .eq("student_id", student_id)
            .execute()
        )
        for qr in (getattr(ai_resp, "data", []) or []):
            gq = qr.get("generated_quizzes")
            if not (isinstance(gq, dict) and gq.get("course_id") == course_id):
                continue
            score = qr.get("score")
            if score is None:
                continue
            rows.append((qr.get("submitted_at"), float(score)))
    except Exception as e:
        print(f"[graded-scores] quiz_submissions error: {e}")

    for score in assignment_scores(admin, student_id, course_id):
        rows.append((None, score))

    rows.sort(key=lambda r: (r[0] is None, r[0] or ""))
    return rows


def build_interaction_features(admin, student_id, course_id, now=None):
    """Recompute the 7 OULAD interaction features from platform telemetry.

    Returns a 2-tuple ``(features, telemetry_count)`` so callers can judge
    confidence (empty telemetry) without a second query.
    """
    now = now or datetime.now(timezone.utc)

    eng_rows = []
    try:
        eng_resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("material_id, time_spent, created_at")
            .eq("student_id", student_id)
            .eq("course_id", course_id)
            .order("created_at", desc=False)
            .limit(5000)
            .execute()
        )
        eng_rows = getattr(eng_resp, "data", []) or []
    except Exception as e:
        print(f"[features] Could not fetch engagement logs: {e}")

    total_minutes = 0.0
    material_ids = set()
    active_day_keys = set()
    last_ts = None
    for row in eng_rows:
        ts = parse_utc(row.get("created_at"))
        if ts is None:
            continue
        total_minutes += max(float(row.get("time_spent") or 0), 0.0) / 60.0
        mid = row.get("material_id")
        if mid:
            material_ids.add(str(mid))
        active_day_keys.add(ts.date().isoformat())
        if last_ts is None or ts > last_ts:
            last_ts = ts

    active_days = len(active_day_keys)
    if last_ts is not None:
        days_since_last = float(max(0, (now - last_ts).days))
    else:
        # No telemetry at all: model reads a long-inactive profile so the
        # student classifies as At-Risk rather than as "perfectly fresh".
        days_since_last = 200.0

    # Enrolled-day denominator from enrollments.enrolled_at (fallback 1 day).
    days_enrolled = 1.0
    try:
        enroll_resp = with_retry(
            lambda c: c.table("enrollments")
            .select("enrolled_at")
            .eq("student_id", student_id)
            .eq("course_id", course_id)
            .limit(1)
            .execute()
        )
        enroll_rows = getattr(enroll_resp, "data", []) or []
        if enroll_rows:
            enrolled_at = parse_utc(enroll_rows[0].get("enrolled_at"))
            if enrolled_at is not None:
                days_enrolled = max(1.0, float((now - enrolled_at).days))
    except Exception as e:
        print(f"[features] Could not fetch enrollment: {e}")

    features = {
        "total_activities":            round(total_minutes, 2),
        "unique_materials":            float(len(material_ids)),
        "active_days":                 float(active_days),
        "avg_daily_activity":          round(total_minutes / max(active_days, 1), 3),
        "activity_per_registered_day": round(total_minutes / days_enrolled, 3),
        "days_since_last_activity":    round(days_since_last, 1),
        "assessment_count":            float(graded_assessment_count(admin, student_id, course_id)),
    }
    return features, len(eng_rows)


# ── Platform-aware engagement calibration ─────────────────────────────────────
# The Two-Tower engagement head was trained on OULAD, whose interaction
# statistics are far larger than this platform's minute-scale logs over ~10-day
# courses (OULAD active_days mean ≈ 55 vs. typical 1-5 here, total_activities
# mean ≈ 1200 clicks vs. tens of minutes). In this lower-volume domain the head
# saturates to At-Risk for essentially every student, so the stored engagement
# class is decided here by a deterministic platform-native score. The model
# probabilities are still computed and stored alongside for transparency, and
# comprehension is untouched (driven by real assessment scores).
_ENG_WEIGHT_ACTIVE_DAY  = 30.0
_ENG_WEIGHT_AVG_DAILY   = 2.0
_ENG_WEIGHT_MATERIAL    = 15.0
_ENG_WEIGHT_ASSESSMENT  = 12.0
_ENG_WEIGHT_STALENESS   = 4.0
_ENG_MODERATE_MIN       = 60.0
_ENG_HIGHLY_ENGAGED_MIN = 250.0


def calibrate_engagement(features: dict, telemetry_count: int) -> tuple:
    """Map platform telemetry to a platform-calibrated engagement (class, label).

    ``features`` is the 7-feature interaction dict produced by
    ``build_interaction_features``; ``telemetry_count`` guards the zero-data
    case so a brand-new enrollment reads At-Risk rather than "perfectly fresh".
    """
    if telemetry_count <= 0:
        return 0, ENGAGEMENT_LABELS[0]

    active_days = float(features.get("active_days") or 0)
    avg_daily   = float(features.get("avg_daily_activity") or 0)
    materials   = float(features.get("unique_materials") or 0)
    assessments = min(float(features.get("assessment_count") or 0), 5.0)
    stale       = float(features.get("days_since_last_activity") or 0)

    raw = (
        active_days * _ENG_WEIGHT_ACTIVE_DAY
        + avg_daily * _ENG_WEIGHT_AVG_DAILY
        + materials * _ENG_WEIGHT_MATERIAL
        + assessments * _ENG_WEIGHT_ASSESSMENT
        - stale * _ENG_WEIGHT_STALENESS
    )
    if raw >= _ENG_HIGHLY_ENGAGED_MIN:
        cls = 2
    elif raw >= _ENG_MODERATE_MIN:
        cls = 1
    else:
        cls = 0
    return cls, ENGAGEMENT_LABELS[cls]


def compute_classification(admin, student_id, course_id, material_id=None, now=None):
    """Pure compute: OULAD features + Two-Tower class + comprehension override.

    Returns a 2-tuple ``(result, record)``:
      result : the classification dict (classes, labels, probabilities, fallback)
      record : the engagement_logs row that callers should INSERT, containing
               the 7 interaction features + classes + low_confidence.

    Comprehension is driven directly by the student's *real* assessment scores
    (quizzes + assignments); the model's comprehension head is only used when
    there are no graded scores yet.
    Persistence, and any notification/side effects, are the caller's job.
    """
    features, telemetry_count = build_interaction_features(
        admin, student_id, course_id, now=now
    )

    graded_rows = course_graded_scores(admin, student_id, course_id)
    course_scores = [score for _, score in graded_rows]
    graded_count = len(course_scores)

    # "Based on limited data" flag: fewer than 2 graded assessments or zero
    # telemetry rows -> classification is a weak signal.
    low_confidence = graded_count < 2 or telemetry_count == 0

    result = get_analyzer().classify(STUDENT_DEFAULTS, features)

    # Platform calibration override (see calibrate_engagement docstring): the
    # OULAD-trained engagement head saturates to At-Risk in this platform's
    # lower-volume domain, so re-map the class from real telemetry while
    # keeping the raw model probabilities for transparency.
    cal_class, cal_label = calibrate_engagement(features, telemetry_count)
    result["engagement_class"] = cal_class
    result["engagement_label"] = cal_label

    graded_comp = comprehension_from_scores(course_scores)
    if graded_comp is not None:
        result["comprehension_class"] = graded_comp[0]
        result["comprehension_label"] = graded_comp[1]

    record = {
        "student_id": student_id,
        "course_id": course_id,
        "total_activities":            features["total_activities"],
        "unique_materials":            features["unique_materials"],
        "active_days":                 features["active_days"],
        "avg_daily_activity":          features["avg_daily_activity"],
        "activity_per_registered_day": features["activity_per_registered_day"],
        "days_since_last_activity":    features["days_since_last_activity"],
        "assessment_count":            features["assessment_count"],
        "engagement_class":            result["engagement_class"],
        "engagement_label":            result["engagement_label"],
        "comprehension_class":         result["comprehension_class"],
        "comprehension_label":         result["comprehension_label"],
        "low_confidence":              low_confidence,
        "engagement_probabilities":    result["engagement_probabilities"],
        "comprehension_probabilities": result["comprehension_probabilities"],
    }
    if material_id:
        record["material_id"] = material_id

    return result, record