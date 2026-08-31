# File: backend/app/routes/resources.py
# Purpose: Lecturers generate AI study resources (summaries, key points,
#          practice questions) from course material content for students.

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.core.security import get_current_user, require_role
from app.database import get_admin_client, with_retry
from app.services.material_content import material_text_from_url
from app.services.quiz_generator import quiz_ai

router = APIRouter(prefix="/api/resources", tags=["resources"])

RESOURCE_TYPES = ("summary", "key_points", "practice_questions")


class ResourceGenerateRequest(BaseModel):
    material_id: str
    resource_type: str = "summary"


class ResourcePublishRequest(BaseModel):
    course_id: str
    material_id: Optional[str] = None
    title: str
    resource_type: str
    content_text: str


def _check_course_scope(admin, course_id, user, allow_student=False):
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

    if user["role"] == "student":
        if not allow_student:
            raise HTTPException(status_code=403, detail="Access denied to this course.")
        enroll_resp = with_retry(
            lambda c: c.table("enrollments")
            .select("id")
            .eq("student_id", user["id"])
            .eq("course_id", course_id)
            .execute()
        )
        if not (getattr(enroll_resp, "data", []) or []):
            raise HTTPException(status_code=403, detail="Access denied to this course.")
    elif user["role"] == "hod":
        if course.get("department") != user.get("department"):
            raise HTTPException(status_code=403, detail="You can only manage courses in your department.")
    elif course.get("lecturer_id") != user["id"]:
        raise HTTPException(status_code=403, detail="You can only manage your own courses.")

    return course


def _fetch_material_text(admin, material_id: str) -> tuple:
    """Return (course_id, material_text) for a material."""
    mat_resp = with_retry(
        lambda c: c.table("materials")
        .select("course_id, title, description, content_url, content_type")
        .eq("id", material_id)
        .execute()
    )
    mat_data = getattr(mat_resp, "data", []) or []
    if not mat_data:
        raise HTTPException(status_code=404, detail="Material not found.")
    mat = mat_data[0]

    text = f"{mat.get('title', '')} - {mat.get('description', '')}".strip()
    extracted = material_text_from_url(mat.get("content_url") or "", mat.get("content_type") or "")
    if extracted:
        text = f"{text}\n{extracted}" if text else extracted
    if not text:
        text = "Standard introduction to the course concepts."
    return mat.get("course_id"), text


@router.post("/generate")
def generate_resource(payload: ResourceGenerateRequest, user=Depends(require_role("lecturer", "hod"))):
    """Preview an AI-generated study resource for a material (not saved yet)."""
    if payload.resource_type not in RESOURCE_TYPES:
        raise HTTPException(status_code=400, detail="resource_type must be summary, key_points or practice_questions.")

    admin = get_admin_client()
    try:
        course_id, material_text = _fetch_material_text(admin, payload.material_id)
        _check_course_scope(admin, course_id, user)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to fetch this material.")

    content = quiz_ai.generate_resource(material_text[:30000], payload.resource_type)
    if not content:
        raise HTTPException(status_code=503, detail="Resources generation failed. Try again later.")

    titles = {
        "summary": "Summary",
        "key_points": "Key Points",
        "practice_questions": "Practice Questions",
    }
    return {
        "resource_type": payload.resource_type,
        "title": f"{titles[payload.resource_type]}",
        "content_text": content,
    }


@router.post("/publish", status_code=201)
def publish_resource(payload: ResourcePublishRequest, user=Depends(require_role("lecturer", "hod"))):
    """Save a generated study resource so students can view it."""
    if payload.resource_type not in RESOURCE_TYPES:
        raise HTTPException(status_code=400, detail="resource_type must be summary, key_points or practice_questions.")
    if not payload.content_text.strip():
        raise HTTPException(status_code=400, detail="content_text cannot be empty.")

    admin = get_admin_client()
    try:
        _check_course_scope(admin, payload.course_id, user)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to query this course.")

    try:
        insert_resp = with_retry(
            lambda c: c.table("study_resources").insert({
                "course_id": payload.course_id,
                "material_id": payload.material_id,
                "title": payload.title,
                "resource_type": payload.resource_type,
                "content_text": payload.content_text,
            }).execute()
        )
        return {"status": "success", "resource": (getattr(insert_resp, "data", []) or [])[0]}
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to publish this resource.")


@router.get("/course/{course_id}")
def get_course_resources(course_id: str, user=Depends(get_current_user)):
    """List published study resources for a course."""
    admin = get_admin_client()
    try:
        _check_course_scope(admin, course_id, user, allow_student=True)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to query this course.")

    try:
        resp = with_retry(
            lambda c: c.table("study_resources")
            .select("*")
            .eq("course_id", course_id)
            .order("created_at", desc=True)
            .execute()
        )
        return {"course_id": course_id, "resources": getattr(resp, "data", []) or []}
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to fetch these resources.")


@router.delete("/{resource_id}")
def delete_resource(resource_id: str, user=Depends(require_role("lecturer", "hod"))):
    """Delete a study resource (lecturers/HODs of the owning course)."""
    admin = get_admin_client()
    try:
        res_resp = with_retry(
            lambda c: c.table("study_resources")
            .select("id, course_id")
            .eq("id", resource_id)
            .execute()
        )
        res_data = getattr(res_resp, "data", []) or []
        if not res_data:
            raise HTTPException(status_code=404, detail="Resource not found.")
        _check_course_scope(admin, res_data[0]["course_id"], user)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to query this resource.")

    try:
        with_retry(lambda c: c.table("study_resources").delete().eq("id", resource_id).execute())
        return {"status": "success", "message": "Resource deleted."}
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to delete this resource.")
