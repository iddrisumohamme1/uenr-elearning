# File: backend/app/routes/attendance.py
# Purpose: Allow students to self-log their attendance.

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional
from datetime import date

from app.core.security import get_current_user, require_role
from app.database import get_admin_client, with_retry

router = APIRouter(prefix="/api/attendance", tags=["attendance"])

class AttendanceLogRequest(BaseModel):
    course_id: str
    status: str  # 'present', 'absent', 'late'

@router.post("/log")
def log_attendance(payload: AttendanceLogRequest, user=Depends(require_role("student"))):
    """
    Students self-report their attendance for a specific course today.
    """
    if payload.status not in ("present", "absent", "late"):
        raise HTTPException(status_code=400, detail="Invalid status. Must be present, absent, or late.")

    admin = get_admin_client()
    try:
        # Check if already logged today to prevent duplicate logs (DB unique constraint will also catch it)
        with_retry(lambda c: c.table("attendance_logs").insert({
            "student_id": user["id"],
            "course_id": payload.course_id,
            "status": payload.status,
            "logged_date": str(date.today())
        }).execute())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to log attendance. You may have already logged it for today. {exc}")

    return {"status": "success", "message": f"Attendance marked as {payload.status}."}

@router.get("/student/{student_id}")
def get_student_attendance(student_id: str, course_id: Optional[str] = None, user=Depends(get_current_user)):
    """
    Get a student's attendance history. 
    Students can view their own, lecturers can view any student's.
    """
    if user["role"] == "student" and user["id"] != student_id:
        raise HTTPException(status_code=403, detail="You can only view your own attendance.")

    admin = get_admin_client()
    try:
        query = admin.table("attendance_logs").select("*").eq("student_id", student_id)
        if course_id:
            query = query.eq("course_id", course_id)
        
        resp = with_retry(lambda c: query.order("logged_date", desc=True).execute())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to retrieve attendance: {exc}")

    return getattr(resp, "data", [])
