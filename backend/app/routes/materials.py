# File: backend/app/routes/materials.py
# Purpose: Learning materials management and Supabase persistence.

import httpx
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4
from typing import List

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.core.security import get_current_user, require_role
from app.database import get_admin_client
from app.schemas.materials import CourseMaterialsResponse, MaterialOut

router = APIRouter(prefix="/api/materials", tags=["materials"])

BUCKET_NAME = "materials"

# Allowed hostnames for the proxy endpoint (SSRF protection)
ALLOWED_PROXY_HOSTS = {"supabase.co", "supabase.in"}


@router.post("/upload", response_model=MaterialOut, status_code=201)
def upload_material(
    title: str = Form(...),
    course_id: str = Form(...),
    description: str | None = Form(None),
    file: UploadFile = File(...),
    user=Depends(require_role("lecturer", "hod")),
):
    """
    Upload a learning material file and persist its metadata in Supabase.
    Lecturers may upload only to their own course; HODs may upload to any course in their department.
    """
    admin = get_admin_client()

    # Validate course ownership / department scope.
    try:
        course_resp = (
            admin.table("courses")
            .select("id, title, department, lecturer_id")
            .eq("id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    course_data = getattr(course_resp, "data", []) or []
    if not course_data:
        raise HTTPException(status_code=404, detail="Course not found.")

    course = course_data[0]
    if user["role"] == "lecturer" and course.get("lecturer_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Lecturers may only upload materials for their own courses.")
    if user["role"] == "hod" and course.get("department") != user.get("department"):
        raise HTTPException(status_code=403, detail="HOD may only upload materials for courses in their department.")

    file_name = Path(file.filename).name
    storage_path = f"{course_id}/{uuid4().hex}-{file_name}"

    try:
        # Create the public storage bucket if it does not exist.
        admin.storage.create_bucket(BUCKET_NAME, options={"public": True})
    except Exception as exc:
        if "already exists" not in str(exc).lower():
            raise HTTPException(status_code=500, detail=f"Failed to verify storage bucket: {exc}")

    try:
        bucket = admin.storage.from_(BUCKET_NAME)
        file.file.seek(0)
        file_bytes = file.file.read()
        bucket.upload(storage_path, file_bytes)
        public_url = bucket.get_public_url(storage_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to upload file: {exc}")

    try:
        insert_resp = (
            admin.table("materials")
            .insert(
                {
                    "course_id": course_id,
                    "title": title,
                    "description": description,
                    "content_url": public_url,
                    "content_type": file.content_type or "application/octet-stream",
                }
            )
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save material metadata: {exc}")

    material_data = getattr(insert_resp, "data", []) or []
    if not material_data:
        raise HTTPException(status_code=500, detail="Material was not created.")

    return MaterialOut(**material_data[0])


@router.get("/course/{course_id}", response_model=CourseMaterialsResponse)
def get_course_materials(course_id: str, user=Depends(get_current_user)):
    """
    Returns all learning materials for a specific course.
    """
    admin = get_admin_client()

    try:
        course_resp = (
            admin.table("courses")
            .select("id, title, department, lecturer_id")
            .eq("id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    course_data = getattr(course_resp, "data", []) or []
    if not course_data:
        raise HTTPException(status_code=404, detail="Course not found.")

    course = course_data[0]
    if user["role"] in {"student", "hod"} and course.get("department") != user.get("department"):
        raise HTTPException(status_code=403, detail="Access denied to materials for this course.")
    if user["role"] == "lecturer" and course.get("department") != user.get("department"):
        raise HTTPException(status_code=403, detail="Access denied to materials for this course.")

    try:
        materials_resp = (
            admin.table("materials")
            .select("id, title, description, content_url, content_type, created_at")
            .eq("course_id", course_id)
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query materials: {exc}")

    return CourseMaterialsResponse(
        course_id=course_id,
        course_title=course.get("title") or "Course Materials",
        materials=getattr(materials_resp, "data", []) or [],
    )


@router.get("/proxy")
def proxy_material(url: str):
    """
    Proxies a Supabase storage file so iframes can load it without
    being blocked by X-Frame-Options / CORS headers from Supabase.
    Only allows proxying URLs from Supabase storage hosts (SSRF protection).
    """
    # Validate URL to prevent SSRF
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()
        # Allow Supabase storage hosts (*.supabase.co, *.supabase.in)
        if not any(hostname.endswith(h) for h in ALLOWED_PROXY_HOSTS):
            raise HTTPException(status_code=400, detail="Proxy only allows Supabase storage URLs.")
        if parsed.scheme not in ("https", "http"):
            raise HTTPException(status_code=400, detail="Only HTTP(S) URLs are allowed.")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL.")

    try:
        r = httpx.get(url, follow_redirects=True, timeout=30, verify=False)
        r.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch file: {exc}")

    content_type = r.headers.get("content-type", "application/octet-stream")
    return StreamingResponse(
        iter([r.content]),
        media_type=content_type,
        headers={"Content-Disposition": "inline"},
    )
