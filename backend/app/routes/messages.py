# File: backend/app/routes/messages.py
# Purpose: Direct messaging from lecturers to students based on analytics.

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional

from app.core.security import get_current_user, require_role
from app.database import get_admin_client, with_retry

router = APIRouter(prefix="/api/messages", tags=["messages"])

class MessageRequest(BaseModel):
    recipient_id: str
    course_id: Optional[str] = None
    content: str

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

@router.get("/inbox")
def get_inbox(user=Depends(get_current_user)):
    """
    Retrieve messages for the logged-in user (student or lecturer).
    """
    admin = get_admin_client()
    try:
        resp = with_retry(
            lambda c: c.table("messages")
            .select("id, sender_id, recipient_id, course_id, content, is_read, created_at, users!sender_id(full_name)")
            .eq("recipient_id", user["id"])
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch inbox: {exc}")

    return getattr(resp, "data", [])


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
