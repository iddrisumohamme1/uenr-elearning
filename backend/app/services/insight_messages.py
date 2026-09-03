# File: backend/app/services/insight_messages.py
# Purpose: Composes and delivers automated AI insight messages to a student's
#          inbox after meaningful events (classification refresh, quiz or
#          graded-assignment submission). The student receives a short plain-
#          text summary of their engagement + assessment standing, sent as the
#          dedicated "AI Insight Assistant" user so it is clearly machine-made.
#
# Every function here is defensive: a failure in analytics or messaging must
# never break the primary request that triggered it, so callers are expected to
# wrap each call in try/except — see the hooks in quiz.py, assignments.py and
# engagement.py. The AI sender is optional: if its profile row is missing we
# silently skip sending.

import os
from datetime import datetime, timedelta, timezone

from app.database import get_admin_client, with_retry

AI_INSIGHT_EMAIL = "ai-insight@uenr.edu.gh"
COOLDOWN_MINUTES = 60

_profiles = {"engagement": ["At-Risk", "Moderate", "Highly Engaged"],
             "comprehension": ["Low", "Moderate", "Good"]}

_ai_sender_id = None


def _engagement_avg(scores):
    scores = [float(s) for s in scores if s is not None]
    return round(sum(scores) / len(scores)) if scores else None


def _ai_assistant_id(admin):
    """Cached id of the AI assistant profile row (its auth user is seeded via
    the Supabase Auth Admin API; its matching users row via migration)."""
    global _ai_sender_id
    if _ai_sender_id:
        return _ai_sender_id
    try:
        resp = with_retry(
            lambda c: c.table("users")
            .select("id")
            .eq("email", AI_INSIGHT_EMAIL)
            .limit(1)
            .execute()
        )
        rows = getattr(resp, "data", []) or []
        if rows:
            _ai_sender_id = rows[0]["id"]
        return _ai_sender_id
    except Exception as exc:
        print(f"[insight] Could not resolve AI assistant sender: {exc}")
        return None


def _assessment_summary(admin, student_id, course_id):
    """Per-course standing from AI quizzes, legacy quizzes and graded
    assignment submissions. Standalone (no route imports) so it stays acyclic."""
    summary = {"quiz_scores": [], "assign_grades": [], "assign_submitted": 0}

    # AI-generated quizzes for this course
    try:
        quizzes = with_retry(
            lambda c: c.table("generated_quizzes")
            .select("id")
            .eq("course_id", course_id)
            .execute()
        ).data or []
        qids = [q["id"] for q in quizzes if q.get("id")]
        if qids:
            subs = with_retry(
                lambda c: c.table("quiz_submissions")
                .select("score")
                .eq("student_id", student_id)
                .in_("quiz_id", qids)
                .execute()
            ).data or []
            summary["quiz_scores"].extend(s.get("score") for s in subs)
    except Exception as exc:
        print(f"[insight] AI quiz summary error: {exc}")

    # Legacy quizzes for this course
    try:
        quizzes = with_retry(
            lambda c: c.table("quizzes")
            .select("id")
            .eq("course_id", course_id)
            .execute()
        ).data or []
        qids = [q["id"] for q in quizzes if q.get("id")]
        if qids:
            results = with_retry(
                lambda c: c.table("quiz_results")
                .select("score")
                .eq("student_id", student_id)
                .in_("quiz_id", qids)
                .execute()
            ).data or []
            summary["quiz_scores"].extend(r.get("score") for r in results)
    except Exception as exc:
        print(f"[insight] legacy quiz summary error: {exc}")

    # Graded assignments (shared + the student's own auto-generated)
    try:
        assignments = with_retry(
            lambda c: c.table("assignments")
            .select("id, auto_generated, student_id")
            .eq("course_id", course_id)
            .execute()
        ).data or []
        visible = [
            a for a in assignments
            if not a.get("auto_generated") or a.get("student_id") == student_id
        ]
        a_ids = [a["id"] for a in visible if a.get("id")]
        if a_ids:
            subs = with_retry(
                lambda c: c.table("assignment_submissions")
                .select("score")
                .eq("student_id", student_id)
                .in_("assignment_id", a_ids)
                .execute()
            ).data or []
            summary["assign_submitted"] = len(subs)
            summary["assign_grades"].extend(s.get("score") for s in subs)
    except Exception as exc:
        print(f"[insight] assignment summary error: {exc}")

    return summary


def _material_summary(admin, student_id, course_id, window_hours, limit):
    """Most recently engaged materials, one per line. When window_hours is
    set, rows are filtered to that window (used for the 'just studied' list);
    otherwise all course history is ranked by last engagement time."""
    try:
        query = (
            admin.table("engagement_logs")
            .select("material_id, engagement_score, engagement_level, time_spent, idle_time, created_at")
            .eq("student_id", student_id)
            .eq("course_id", course_id)
            .order("created_at", desc=True)
            .limit(300)
        )
        logs = with_retry(lambda c: query.execute()).data or []

        since = None
        if window_hours:
            since = datetime.now(timezone.utc) - timedelta(hours=window_hours)
            logs = [l for l in logs if l.get("created_at")
                    and _parse_ts(l["created_at"]) >= since]

        # Group by material, newest-first, keeping last engagement time and title.
        agg = {}
        for l in logs:
            mid = l.get("material_id")
            if not mid:
                continue
            entry = agg.setdefault(mid, {"active_secs": 0, "last": None,
                                         "scores": [], "level": None})
            spent = l.get("time_spent") or 0
            idle = l.get("idle_time") or 0
            entry["active_secs"] += max(0, int(spent) - int(idle))
            if entry["last"] is None:
                entry["last"] = l.get("created_at")
                entry["level"] = l.get("engagement_level")
            if l.get("engagement_score") is not None:
                entry["scores"].append(l["engagement_score"])

        if not agg:
            return []

        material_ids = list(agg.keys())
        titles = {}
        try:
            mats = with_retry(
                lambda c: c.table("materials")
                .select("id, title")
                .in_("id", material_ids)
                .execute()
            ).data or []
            titles = {m["id"]: m.get("title") for m in mats}
        except Exception as exc:
            print(f"[insight] material titles error: {exc}")

        ordered = sorted(
            agg.items(), key=lambda kv: _parse_ts(kv[1]["last"]) or datetime.min.replace(tzinfo=timezone.utc), reverse=True
        )[:limit]

        lines = []
        for mid, e in ordered:
            title = titles.get(mid) or "Course material"
            mins = max(1, round(e["active_secs"] / 60))
            score = _engagement_avg(e["scores"])
            engagement = f" (level {e['level']})" if e.get("level") else ""
            score_txt = f", engagement {score}/100" if score is not None else ""
            lines.append(f"  • {title} — {mins} min active{engagement}{score_txt}")
        return lines
    except Exception as exc:
        print(f"[insight] material summary error: {exc}")
        return []


def _parse_ts(ts):
    try:
        if isinstance(ts, str):
            ts = ts.replace("Z", "+00:00")
        return datetime.fromisoformat(ts)
    except Exception:
        return None


def _classification_line(latest):
    """Latest classification row → friendly profile line (or '' if absent)."""
    if not latest:
        return ""
    eng = latest.get("engagement_class")
    comp = latest.get("comprehension_class")
    if eng is None or comp is None:
        return ""
    eng_word = _profiles["engagement"][int(eng)] if 0 <= int(eng) < 3 else "Unknown"
    comp_word = _profiles["comprehension"][int(comp)] if 0 <= int(comp) < 3 else "Unknown"
    line = f"Your current learning profile: {eng_word} / {comp_word} comprehension."
    if latest.get("low_confidence"):
        line += " (based on limited data — complete more quizzes/assignments for a clearer picture.)"
    return line


def _existing_recent(admin, sender_id, student_id, course_id, window_minutes=None):
    """True if the AI already messaged this student about this course recently.
    `window_minutes` overrides the default COOLDOWN_MINUTES (used by the lazy
    daily generation which fires once per 24h)."""
    window = window_minutes if window_minutes is not None else COOLDOWN_MINUTES
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=window)).isoformat()
        resp = with_retry(
            lambda c: c.table("messages")
            .select("id")
            .eq("sender_id", sender_id)
            .eq("recipient_id", student_id)
            .eq("course_id", course_id)
            .gte("created_at", cutoff)
            .limit(1)
            .execute()
        )
        return bool(getattr(resp, "data", []) or [])
    except Exception as exc:
        print(f"[insight] cooldown check error: {exc}")
        return False


def push_insight_message(admin, student_id, course_id, kind, latest=None, score=None,
                         comprehension_level=None, window_minutes=None):
    """Compose and send an insight inbox message. `kind` is one of
    "classification" | "quiz" | "assignment" | "daily". Returns True if a
    message was sent, False otherwise. Non-blocking: it never raises so the
    caller is safe. `window_minutes` overrides the cooldown window (used by
    "daily" to gate to once per 24h)."""
    sender_id = _ai_assistant_id(admin)
    if not sender_id:
        print("[insight] AI assistant sender not found — skipping message")
        return False
    if _existing_recent(admin, sender_id, student_id, course_id, window_minutes):
        return False

    summary = _assessment_summary(admin, student_id, course_id)

    quiz_avg = _engagement_avg(summary["quiz_scores"])
    quiz_n = len(summary["quiz_scores"])
    grade_avg = _engagement_avg(summary["assign_grades"])
    grade_n = len(summary["assign_grades"])

    if kind == "classification":
        body = [
            f"📘 Study update for this course.",
            _classification_line(latest) or "Check your engagement in the profile.",
        ]
        recent = _material_summary(admin, student_id, course_id, window_hours=24, limit=5)
        if recent:
            body.append("Materials you engaged with in the last 24h:")
            body.extend(recent)
        body.append(_standing_line(quiz_avg, quiz_n, grade_avg, grade_n, summary["assign_submitted"]))
    elif kind == "quiz":
        body = []
        if score is not None:
            body.append(
                f"📝 You scored {score}% on this quiz"
                + (f" ({comprehension_level} comprehension)" if comprehension_level else "")
                + "."
            )
        recent = _material_summary(admin, student_id, course_id, window_hours=None, limit=3)
        if recent:
            body.append("Materials you recently studied:")
            body.extend(recent)
        body.append(_standing_line(quiz_avg, quiz_n, grade_avg, grade_n, summary["assign_submitted"]))
        line = _classification_line(latest)
        if line:
            body.append(line)
    elif kind == "daily":
        body = [
            "📘 Here's your daily learning update for this course.",
        ]
        line = _classification_line(latest)
        if line:
            body.append(line)
        recent = _material_summary(admin, student_id, course_id, window_hours=24, limit=5)
        if recent:
            body.append("Materials you engaged with in the last 24h:")
            body.extend(recent)
        else:
            body.append("You haven't studied any materials for this course in the last 24h.")
        body.append(_standing_line(quiz_avg, quiz_n, grade_avg, grade_n, summary["assign_submitted"]))
    else:  # assignment
        body = []
        if score is not None:
            body.append(f"📄 Your assignment was graded: {score}%.")
        recent = _material_summary(admin, student_id, course_id, window_hours=None, limit=3)
        if recent:
            body.append("Materials you recently studied:")
            body.extend(recent)
        body.append(_standing_line(quiz_avg, quiz_n, grade_avg, grade_n, summary["assign_submitted"]))
        line = _classification_line(latest)
        if line:
            body.append(line)

    content = "\n".join(part for part in body if part)
    if not content:
        return False

    try:
        with_retry(
            lambda c: c.table("messages").insert({
                "sender_id": sender_id,
                "recipient_id": student_id,
                "course_id": course_id,
                "content": content,
            }).execute()
        )
        print(f"[insight] sent {kind} message to {student_id} for course {course_id}")
    except Exception as exc:
        print(f"[insight] failed to insert message: {exc}")
        return False
    return True


def _standing_line(quiz_avg, quiz_n, grade_avg, grade_n, assign_submitted):
    """Human sentence summarising quiz + assignment standing."""
    parts = []
    if quiz_avg is None and grade_avg is None:
        parts.append("No graded quizzes or assignments recorded yet — complete some to unlock performance insight.")
    else:
        if quiz_avg is not None:
            parts.append(f"average quiz score {quiz_avg}% across {quiz_n} attempt(s)")
        if grade_avg is not None:
            parts.append(f"average assignment grade {grade_avg}% across {assign_submitted} submission(s)")
    return "Assessment standing: " + "; ".join(parts) + "."


def _latest_classification(admin, student_id, course_id):
    """Latest classification row for a student in a course (or None)."""
    try:
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("engagement_class, comprehension_class, low_confidence")
            .eq("student_id", student_id)
            .eq("course_id", course_id)
            .not_.is_("engagement_class", "null")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = getattr(resp, "data", []) or []
        return rows[0] if rows else None
    except Exception as exc:
        print(f"[insight] latest classification error: {exc}")
        return None


def _student_has_activity(admin, student_id, course_id):
    """True if the student has any engagement log or assessment data for this
    course. Used by the lazy daily generation to avoid messaging brand-new
    empty enrollments. Defensive: returns False on error."""
    try:
        resp = with_retry(
            lambda c: c.table("engagement_logs")
            .select("id")
            .eq("student_id", student_id)
            .eq("course_id", course_id)
            .limit(1)
            .execute()
        )
        if getattr(resp, "data", []) or []:
            return True
    except Exception as exc:
        print(f"[insight] activity check error: {exc}")
        return False
    try:
        summary = _assessment_summary(admin, student_id, course_id)
        if summary["quiz_scores"] or summary["assign_grades"]:
            return True
    except Exception as exc:
        print(f"[insight] activity assessment error: {exc}")
    return False


def _compose_ai_staff_content(admin, recipient_id, course_id, topic="", as_ai=True):
    """Build the data-grounded staff outreach text (not persisted).

    `as_ai=True` produces the AI-persona delivery ("Your lecturer asked me…" /
    "…— AI Insight Assistant"); `as_ai=False` produces an HOD-voiced DRAFT the
    staff member edits and sends as themselves via the normal message route."""
    summary = _assessment_summary(admin, recipient_id, course_id)
    quiz_avg = _engagement_avg(summary["quiz_scores"])
    grade_avg = _engagement_avg(summary["assign_grades"])

    if as_ai:
        body = ["🤖 Your lecturer asked me to reach out to you about this course."]
        if topic and topic.strip():
            body.append(f"\n{topic.strip()}")
        closer = "Reply here if you'd like help. — AI Insight Assistant"
    else:
        body = ["Hi, I noticed you might need a little support with this course.", ""]
        if topic and topic.strip():
            body.append(f"\n{topic.strip()}\n")
        closer = "Let me know how I can help."

    recent = _material_summary(admin, recipient_id, course_id, window_hours=None, limit=3)
    if recent:
        body.append("\nHere's how you're doing:")
        body.extend(recent)
    body.append(_standing_line(quiz_avg, len(summary["quiz_scores"]), grade_avg,
                               len(summary["assign_grades"]), summary["assign_submitted"]))
    line = _classification_line(_latest_classification(admin, recipient_id, course_id))
    if line:
        body.append(line)
    body.append(closer)

    return "\n".join(part for part in body if part)


def push_ai_staff_message(admin, recipient_id, course_id, topic=""):
    """A lecturer/HOD asks the AI assistant to message a specific student.
    Composes a data-grounded message (recent study + assessment standing +
    profile) plus the instructor's optional note/topic, delivered as the AI.
    Returns True if a message was sent, False if skipped (no sender/cooldown)."""
    sender_id = _ai_assistant_id(admin)
    if not sender_id:
        return False
    if _existing_recent(admin, sender_id, recipient_id, course_id):
        return False

    content = _compose_ai_staff_content(admin, recipient_id, course_id, topic, as_ai=True)
    if not content:
        return False
    try:
        with_retry(
            lambda c: c.table("messages").insert({
                "sender_id": sender_id,
                "recipient_id": recipient_id,
                "course_id": course_id,
                "content": content,
            }).execute()
        )
        print(f"[insight] staff-triggered AI message to {recipient_id} for course {course_id}")
        return True
    except Exception as exc:
        print(f"[insight] failed to insert staff-triggered message: {exc}")
        return False


def compose_ai_staff_draft(admin, recipient_id, course_id, topic=""):
    """Return an HOD-voiced outreach draft (no DB write, no cooldown). The
    staff member edits this in the "Reach out" dialog and sends it as
    themselves so a real person owns the message. Returns "" on failure."""
    try:
        return _compose_ai_staff_content(admin, recipient_id, course_id, topic, as_ai=False)
    except Exception as exc:
        print(f"[insight] compose AI staff draft error: {exc}")
        return ""


def push_ai_reply(admin, student_id, course_id, student_message):
    """Compose a contextual AI reply to the student's question in the inbox.
    Returns the reply text ("" on failure). Uses the data builder plus a
    best-effort LLM enhancement (falls back to the data-driven template)."""
    sender_id = _ai_assistant_id(admin)
    if not sender_id:
        return ""

    summary = _assessment_summary(admin, student_id, course_id)
    quiz_avg = _engagement_avg(summary["quiz_scores"])
    grade_avg = _engagement_avg(summary["assign_grades"])
    profile_line = _classification_line(_latest_classification(admin, student_id, course_id))
    recent = _material_summary(admin, student_id, course_id, window_hours=None, limit=3)
    materials = "; ".join(l.strip(" • ") for l in recent) if recent else "—"

    # Deterministic, data-grounded template reply.
    template = (
        "Thanks for reaching out! Here's a quick summary of where things stand:\n"
        f"{_standing_line(quiz_avg, len(summary['quiz_scores']), grade_avg, len(summary['assign_grades']), summary['assign_submitted'])}\n"
        f"Recent study: {materials}.\n"
        + (f"{profile_line}\n" if profile_line else "")
        + "Which topic would you like help with? I can point you to the material or a practice quiz."
    )

    # Best-effort LLM enhancement for a natural, targeted response.
    try:
        from app.services.quiz_generator import quiz_ai
        facts = (
            f"Quiz average {quiz_avg}% (n={len(summary['quiz_scores'])}); "
            f"assignment average {grade_avg}% (n={len(summary['assign_grades'])}); "
            f"recent materials: {materials}; profile: {profile_line}. "
        )
        prompt = (
            "You are a friendly learning assistant inside a university e-learning platform. "
            "A student asked:\n"
            f"\"{student_message}\"\n\n"
            f"Known facts about this student's course: {facts}\n"
            "Answer helpfully, concisely (3-5 sentences), reference their actual numbers where relevant, "
            "and end by offering a concrete next step (re-reading a material or trying a quiz). "
            "Do NOT invent scores that are not provided."
        )
        return (quiz_ai._complete(prompt) or "").strip() or template
    except Exception as exc:
        print(f"[insight] AI reply enhancement skipped: {exc}")
        return template


def _insert_ai_message(admin, sender_id, recipient_id, course_id, content):
    try:
        with_retry(
            lambda c: c.table("messages").insert({
                "sender_id": sender_id,
                "recipient_id": recipient_id,
                "course_id": course_id,
                "content": content,
            }).execute()
        )
        return True
    except Exception as exc:
        print(f"[insight] failed to insert AI message: {exc}")
        return False
