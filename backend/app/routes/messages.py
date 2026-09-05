# File: backend/app/routes/messages.py
# Purpose: Direct messaging from lecturers to students based on analytics.

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional

from app.core.security import get_current_user, require_role
from app.database import get_admin_client, with_retry
from app.services.insight_messages import (
    push_ai_staff_message,
    push_ai_reply,
    push_insight_message,
    compose_ai_staff_draft,
    _ai_assistant_id,
    _insert_ai_message,
    _student_has_activity,
)

router = APIRouter(prefix="/api/messages", tags=["messages"])

class MessageRequest(BaseModel):
    recipient_id: str
    course_id: Optional[str] = None
    content: str

class AIStaffMessageRequest(BaseModel):
    recipient_id: str
    course_id: Optional[str] = None
    topic: Optional[str] = ""

class AIReplyRequest(BaseModel):
    course_id: Optional[str] = None
    message: str

class StudentReplyRequest(BaseModel):
    recipient_id: str
    course_id: Optional[str] = None
    content: str

@router.post("/reply")
def student_reply(payload: StudentReplyRequest, user=Depends(require_role("student"))):
    """
    A student replies to the lecturer/HOD who messaged them about a course.

    Students may ONLY reply to a staff member who has already messaged them in
    that course (reply-to-sender), which prevents messaging arbitrary staff or
    spamming a department. The recipient must be a real lecturer/HOD — never
    the AI assistant and never another student.
    """
    admin = get_admin_client()
    content = (payload.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    if payload.recipient_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot reply to yourself.")

    # The recipient must be a lecturer or HOD (not the AI assistant, not a student).
    try:
        rec = with_retry(
            lambda c: c.table("users")
            .select("id, role")
            .eq("id", payload.recipient_id)
            .limit(1)
            .execute()
        )
        rec_rows = getattr(rec, "data", []) or []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to validate recipient: {exc}")
    if not rec_rows:
        raise HTTPException(status_code=404, detail="Recipient not found.")
    if rec_rows[0].get("role") not in ("lecturer", "hod"):
        raise HTTPException(status_code=403, detail="You can only reply to a lecturer or HOD.")

    # Reply-to-sender scope: the staff member must have messaged this student in
    # this course already.
    if payload.course_id:
        try:
            prior = with_retry(
                lambda c: c.table("messages")
                .select("id")
                .eq("sender_id", payload.recipient_id)
                .eq("recipient_id", user["id"])
                .eq("course_id", payload.course_id)
                .limit(1)
                .execute()
            )
            has_prior = bool(getattr(prior, "data", []) or [])
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to check reply permission: {exc}")
        if not has_prior:
            raise HTTPException(status_code=403, detail="You can only reply to a message this staff member sent you.")

    try:
        with_retry(lambda c: c.table("messages").insert({
            "sender_id": user["id"],
            "recipient_id": payload.recipient_id,
            "course_id": payload.course_id,
            "content": content,
        }).execute())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to send your reply: {exc}")

    return {"status": "success", "message": "Reply sent."}

@router.post("/send")
def send_message(payload: MessageRequest, user=Depends(require_role("lecturer", "hod"))):
    """
    Lecturers can send messages to students.
    """
    admin = get_admin_client()
    try:
        with_retry(lambda c: c.table("messages").insert({
            "sender_id": user["id"],
            "recipient_id": payload.recipient_id,
            "course_id": payload.course_id,
            "content": payload.content
        }).execute())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to send message: {exc}")

    return {"status": "success", "message": "Message sent successfully."}

@router.post("/ai/draft")
def ai_staff_draft(payload: AIStaffMessageRequest, user=Depends(require_role("lecturer", "hod"))):
    """
    Return an AI-composed, HOD/lecturer-voiced outreach draft for the "Reach
    out" dialog (no DB write, no cooldown). The staff member edits it and
    sends it as themselves via POST /api/messages/send.
    """
    if payload.recipient_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot draft a message to yourself.")
    draft = compose_ai_staff_draft(
        get_admin_client(),
        payload.recipient_id,
        payload.course_id,
        payload.topic or "",
    )
    if not draft:
        raise HTTPException(status_code=500, detail="Could not compose a draft.")
    return {"draft": draft}

@router.post("/ai/send")
def ai_send_message(payload: AIStaffMessageRequest, user=Depends(require_role("lecturer", "hod"))):
    """
    Lecturer/HOD asks the AI Insight Assistant to message a specific student.
    The AI composes a data-grounded message (recent study + assessment standing
    + profile) plus the instructor's optional topic/note and delivers it.
    """
    if payload.recipient_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot ask the AI to message yourself.")
    try:
        sent = push_ai_staff_message(
            get_admin_client(),
            payload.recipient_id,
            payload.course_id,
            payload.topic or "",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to compose AI message: {exc}")
    if not sent:
        raise HTTPException(status_code=409, detail="AI message skipped (recent message exists for this student/course or sender unavailable).")
    return {"status": "success", "message": "AI message sent to the student."}

@router.post("/ai/reply")
def ai_reply(payload: AIReplyRequest, user=Depends(require_role("student"))):
    """
    Student replies to the AI assistant in the inbox. Their message is stored,
    then a contextual AI reply is composed (data-grounded, best-effort LLM)
    and delivered back as the AI assistant.
    """
    admin = get_admin_client()
    sender_id = _ai_assistant_id(admin)
    if not sender_id:
        raise HTTPException(status_code=404, detail="AI assistant is not available.")
    if not payload.message or not payload.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    # Store the student's message first.
    try:
        with_retry(lambda c: c.table("messages").insert({
            "sender_id": user["id"],
            "recipient_id": sender_id,
            "course_id": payload.course_id,
            "content": payload.message.strip(),
        }).execute())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to send your message: {exc}")

    # Compose and deliver the AI reply.
    try:
        reply = push_ai_reply(admin, user["id"], payload.course_id, payload.message.strip())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to compose AI reply: {exc}")
    if not reply:
        raise HTTPException(status_code=500, detail="AI could not compose a reply.")

    inserted = _insert_ai_message(admin, sender_id, user["id"], payload.course_id, reply)
    if not inserted:
        raise HTTPException(status_code=500, detail="Failed to deliver AI reply.")
    return {"status": "success", "reply": reply}

@router.get("/inbox")
def get_inbox(user=Depends(get_current_user)):
    """
    Retrieve messages for the logged-in user (student or lecturer).

    Returns both messages addressed to the user AND messages the user sent
    (e.g. the student's own replies to the AI assistant), so a conversation
    reads as a complete two-way thread instead of appearing one-sided. Each
    row is tagged with an `outgoing` flag the frontend can style/align by.
    """
    admin = get_admin_client()
    try:
        resp = with_retry(
            lambda c: c.table("messages")
            .select("id, sender_id, recipient_id, course_id, content, is_read, created_at, users!sender_id(full_name, role), recipient:users!recipient_id(full_name, role)")
            .or_(f"recipient_id.eq.{user['id']},sender_id.eq.{user['id']}")
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch inbox: {exc}")

    rows = getattr(resp, "data", []) or []
    for row in rows:
        row["outgoing"] = bool(row.get("sender_id") == user["id"])
    return rows


DAILY_INSIGHT_MINUTES = 24 * 60


@router.post("/insight-on-open")
def insight_on_open(user=Depends(require_role("student"))):
    """
    Lazy daily AI generation: when the student opens their inbox, generate a
    data-grounded AI insight message for each enrolled course with prior
    activity that has not received one in the last 24h. Non-blocking and
    defensive — a failure here never breaks the inbox load.
    """
    admin = get_admin_client()
    student_id = user["id"]
    generated = 0

    try:
        enroll_resp = with_retry(
            lambda c: c.table("enrollments")
            .select("course_id")
            .eq("student_id", student_id)
            .execute()
        )
        course_ids = [e["course_id"] for e in (enroll_resp.data or []) if e.get("course_id")]
    except Exception as exc:
        print(f"[messages] insight-on-open enrollments error: {exc}")
        return {"generated": 0}

    for cid in course_ids:
        try:
            if not _student_has_activity(admin, student_id, cid):
                continue
            sent = push_insight_message(
                admin, student_id, cid,
                kind="daily",
                latest=None,
                window_minutes=DAILY_INSIGHT_MINUTES,
            )
            if sent:
                generated += 1
        except Exception as exc:
            print(f"[messages] insight-on-open generation error for {cid}: {exc}")

    return {"generated": generated}


@router.get("/unread-count")
def get_unread_count(user=Depends(get_current_user)):
    """
    Number of unread messages for the logged-in user. Used by the sidebar to
    show an unread badge on the Inbox link after login.
    """
    admin = get_admin_client()
    try:
        resp = with_retry(
            lambda c: c.table("messages")
            .select("id")
            .eq("recipient_id", user["id"])
            .eq("is_read", False)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch unread count: {exc}")

    return {"unread_count": len(getattr(resp, "data", []) or [])}

@router.post("/read/{message_id}")
def mark_as_read(message_id: str, user=Depends(get_current_user)):
    """
    Mark a specific message as read.
    """
    admin = get_admin_client()
    try:
        with_retry(
            lambda c: c.table("messages")
            .update({"is_read": True})
            .eq("id", message_id)
            .eq("recipient_id", user["id"])
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to mark as read: {exc}")

    return {"status": "success"}
