# File: backend/app/routes/highlights.py
# Purpose: Persistent per-student text highlights on course materials.
#
# The frontend renders PDFs with a selectable text layer; when a student
# highlights a passage the selected line boxes are stored as percentage
# rectangles relative to the rendered page, so they repaint correctly at any
# zoom level or screen size. Highlights count toward engagement telemetry.

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from typing import List

from app.database import get_admin_client, with_retry
from app.core.security import get_current_user

router = APIRouter(prefix="/api/highlights", tags=["highlights"])


class HighlightRect(BaseModel):
    """One line box of the selection, in % of the rendered page."""
    l: float = Field(..., ge=0, le=100)  # left
    t: float = Field(..., ge=0, le=100)  # top
    w: float = Field(..., ge=0, le=100)  # width
    h: float = Field(..., ge=0, le=100)  # height


class HighlightCreate(BaseModel):
    material_id: str
    course_id: str
    page_number: int = Field(1, ge=1)
    rects: List[HighlightRect] = Field(..., min_length=1)
    text: str = ""
    color: str = Field("amber", pattern="^(amber|green|blue)$")


@router.get("/material/{material_id}")
def list_highlights(material_id: str, user=Depends(get_current_user)):
    """All highlights the current user made on one material."""
    try:
        resp = with_retry(
            lambda c: c.table("material_highlights")
            .select("*")
            .eq("student_id", user["id"])
            .eq("material_id", material_id)
            .order("created_at", desc=False)
            .execute()
        )
        return {"highlights": resp.data}
    except Exception as e:
        raise HTTPException(500, detail=str(e))


@router.post("/", status_code=201)
def create_highlight(payload: HighlightCreate, user=Depends(get_current_user)):
    """Save a new highlight. The owner is always the authenticated user."""
    record = {
        "student_id": user["id"],
        "material_id": payload.material_id,
        "course_id": payload.course_id,
        "page_number": payload.page_number,
        "rects": [r.model_dump() for r in payload.rects],
        "text": payload.text[:2000],
        "color": payload.color,
    }
    try:
        resp = with_retry(
            lambda c: c.table("material_highlights").insert(record).execute()
        )
        return {"highlight": resp.data[0]}
    except Exception as e:
        raise HTTPException(500, detail=str(e))


@router.delete("/material/{material_id}")
def clear_material_highlights(material_id: str, user=Depends(get_current_user)):
    """Bulk-remove every highlight the current user made on one material."""
    try:
        resp = with_retry(
            lambda c: c.table("material_highlights")
            .delete()
            .eq("student_id", user["id"])
            .eq("material_id", material_id)
            .select("id")
            .execute()
        )
        return {"deleted": len(resp.data or [])}
    except Exception as e:
        raise HTTPException(500, detail=str(e))


@router.delete("/{highlight_id}", status_code=200)
def delete_highlight(highlight_id: str, user=Depends(get_current_user)):
    """Remove one of the current user's own highlights."""
    admin = get_admin_client()
    try:
        existing = with_retry(
            lambda c: c.table("material_highlights")
            .select("id")
            .eq("id", highlight_id)
            .eq("student_id", user["id"])
            .execute()
        )
        if not existing.data:
            raise HTTPException(status_code=404, detail="Highlight not found.")

        with_retry(
            lambda c: c.table("material_highlights")
            .delete()
            .eq("id", highlight_id)
            .eq("student_id", user["id"])
            .execute()
        )
        return {"deleted": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, detail=str(e))
