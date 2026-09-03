# File: backend/app/routes/materials.py
# Purpose: Learning materials management and Supabase persistence.

import httpx
import re
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4
from typing import List

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.core.security import get_current_user, require_role
from app.database import (
    MATERIAL_MAX_BYTES,
    get_admin_client,
    get_storage_client,
    upload_blob,
    with_retry,
)
from app.schemas.materials import CourseMaterialsResponse, MaterialOut
from app.services.doc_converter import convert_to_pdf, is_office_file

router = APIRouter(prefix="/api/materials", tags=["materials"])

BUCKET_NAME = "materials"

# Allowed hostnames for the proxy endpoint (SSRF protection)
ALLOWED_PROXY_HOSTS = {"supabase.co", "supabase.in"}


def _check_course_access(admin, user, course_id: str) -> dict:
    """Shared access check used by list and download endpoints."""
    try:
        course_resp = with_retry(
            lambda c: c.table("courses")
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

    if user["role"] == "student":
        if course.get("department") != user.get("department"):
            try:
                enroll_resp = with_retry(
                    lambda c: c.table("enrollments")
                    .select("id")
                    .eq("student_id", user["id"])
                    .eq("course_id", course_id)
                    .execute()
                )
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Failed to query enrollment: {exc}")
            if not (getattr(enroll_resp, "data", []) or []):
                raise HTTPException(status_code=403, detail="Access denied to materials for this course.")
    elif course.get("department") != user.get("department"):
        raise HTTPException(status_code=403, detail="Access denied to materials for this course.")
    return course


@router.post("/upload", response_model=MaterialOut, status_code=201)
def upload_material(
    title: str = Form(...),
    course_id: str = Form(...),
    description: str | None = Form(None),
    week_number: int | None = Form(None),
    unit_label: str | None = Form(None),
    semester: str | None = Form(None),
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
        course_resp = with_retry(
            lambda c: c.table("courses")
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

    # Read once into memory so the size check, storage upload, and the optional
    # PDF conversion all share the same bytes (avoids re-reading the stream).
    file.file.seek(0)
    file_bytes = file.file.read()

    if len(file_bytes) > MATERIAL_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"File exceeds the {MATERIAL_MAX_BYTES // (1024 * 1024)} MB upload "
                "limit. Compress it or split it and try again."
            ),
        )

    try:
        # Create the public storage bucket only if it does not already exist.
        try:
            with_retry(lambda c: c.storage.get_bucket(BUCKET_NAME))
        except Exception:
            with_retry(lambda c: c.storage.create_bucket(BUCKET_NAME, options={"public": True}))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to verify storage bucket: {exc}")

    try:
        # Standard upload for small files, TUS resumable (6 MB chunks) above
        # the threshold so large files survive mid-upload connection drops.
        upload_blob(BUCKET_NAME, storage_path, file_bytes, file.content_type or "application/octet-stream")
        public_url = get_storage_client().from_(BUCKET_NAME).get_public_url(storage_path)
    except Exception as exc:
        # If the file upload failed, there is nothing to delete reasonably (the
        # route has not created any DB record yet): surfaces the real error.
        raise HTTPException(status_code=500, detail=f"Failed to upload file: {exc}")

    # Office documents get a PDF twin so the app can render them natively
    # (full engagement tracking + highlighting). Best-effort: any failure
    # leaves render_url NULL and the embedded-viewer fallback stays in place.
    render_url: str | None = None
    if is_office_file(file_name):
        pdf_bytes = convert_to_pdf(file_bytes, file_name)
        if pdf_bytes:
            try:
                pdf_path = f"{Path(storage_path).stem}.pdf"
                upload_blob(BUCKET_NAME, pdf_path, pdf_bytes, "application/pdf")
                render_url = get_storage_client().from_(BUCKET_NAME).get_public_url(pdf_path)
            except Exception as exc:
                print(f"[materials] Converted-PDF upload failed for '{file_name}': {exc}")

    try:
        insert_resp = with_retry(
            lambda c: c.table("materials")
            .insert(
                {
                    "course_id": course_id,
                    "title": title,
                    "description": description,
                    "content_url": public_url,
                    "content_type": file.content_type or "application/octet-stream",
                    "week_number": week_number,
                    "unit_label": unit_label,
                    "semester": semester,
                    "render_url": render_url,
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

    course = _check_course_access(admin, user, course_id)

    try:
        materials_resp = with_retry(
            lambda c: c.table("materials")
            .select("id, title, description, content_url, render_url, content_type, week_number, unit_label, semester, created_at")
            .eq("course_id", course_id)
            .order("semester", desc=False)
            .order("week_number", desc=False)
            .order("unit_label", desc=False)
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


@router.delete("/{material_id}", status_code=200)
def delete_material(material_id: str, user=Depends(require_role("lecturer", "hod"))):
    """
    Delete one learning material and everything tied to it.

    Removing the materials row cascades through the database (engagement
    logs, downloads, highlights, micro-question results, generated quizzes
    and their submissions, and AI study resources all reference materials
    with ON DELETE CASCADE). Auto-generated assignments keep their own
    content but lose the source-material reference (ON DELETE SET NULL).
    The uploaded file (and its converted-PDF twin, if any) is removed from
    storage as well. Lecturers may only remove materials from courses they
    own; HODs may remove materials within their department.
    """
    admin = get_admin_client()

    try:
        mat_resp = with_retry(
            lambda c: c.table("materials")
            .select("id, course_id, title, content_url, render_url")
            .eq("id", material_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query material: {exc}")

    mat_data = getattr(mat_resp, "data", []) or []
    if not mat_data:
        raise HTTPException(status_code=404, detail="Material not found.")
    material = mat_data[0]

    # Access control — mirror the upload rules.
    try:
        course_resp = with_retry(
            lambda c: c.table("courses")
            .select("id, title, department, lecturer_id")
            .eq("id", material["course_id"])
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    course_data = getattr(course_resp, "data", []) or []
    if not course_data:
        raise HTTPException(status_code=404, detail="Course not found.")
    course = course_data[0]

    if user["role"] == "lecturer" and course.get("lecturer_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Lecturers may only delete materials from their own courses.")
    if user["role"] == "hod" and course.get("department") != user.get("department"):
        raise HTTPException(status_code=403, detail="HOD may only delete materials for courses in their department.")

    try:
        with_retry(
            lambda c: c.table("materials")
            .delete()
            .eq("id", material_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete material: {exc}")

    cleanup_success = True
    for key in ("content_url", "render_url"):
        url = material.get(key) or ""
        if url and "/materials/" in url:
            path = url.split("/materials/", 1)[-1].split("?")[0]
            if path:
                try:
                    get_storage_client().from_(BUCKET_NAME).remove([path])
                except Exception:
                    cleanup_success = False

    return {
        "status": "ok",
        "message": "Material deleted.",
        "storage_cleaned": cleanup_success,
    }


@router.get("/download")
def download_material(id: str, user=Depends(get_current_user)):
    """
    Downloads a material file (Content-Disposition: attachment) and records the
    download so the system can auto-generate an assignment for downloaders.
    """
    admin = get_admin_client()

    try:
        mat_resp = with_retry(
            lambda c: c.table("materials")
            .select("id, course_id, title, content_url, content_type")
            .eq("id", id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query material: {exc}")

    mat_data = getattr(mat_resp, "data", []) or []
    if not mat_data:
        raise HTTPException(status_code=404, detail="Material not found.")
    material = mat_data[0]

    _check_course_access(admin, user, material["course_id"])

    if user["role"] == "student":
        try:
            admin.table("material_downloads").insert(
                {
                    "student_id": user["id"],
                    "course_id": material["course_id"],
                    "material_id": material["id"],
                }
            ).execute()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to record download: {exc}")

    url = material.get("content_url") or ""
    _validate_supabase_url(url)

    try:
        r = httpx.get(url, follow_redirects=True, timeout=30)
        r.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch file: {exc}")

    filename = Path(urlparse(url).path).name or "material"
    content_type = material.get("content_type") or r.headers.get("content-type", "application/octet-stream")
    return StreamingResponse(
        iter([r.content]),
        media_type=content_type,
        headers={
            "Content-Disposition": f"attachment; filename=\"{filename}\"",
        },
    )


def _validate_supabase_url(url: str) -> str:
    """Validate a URL is a Supabase storage URL (SSRF protection).

    Requires HTTPS and an exact ``<project-ref>.supabase.co`` / ``.supabase.in``
    host. A bare ``endswith()`` match is spoofable (``evilsupabase.co`` would
    pass), so the host must be a single project-ref label before the suffix.
    """
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()
        if parsed.scheme != "https":
            raise HTTPException(status_code=400, detail="Proxy only allows HTTPS URLs.")
        suffix_pattern = "|".join(
            re.escape(s) for s in sorted(ALLOWED_PROXY_HOSTS, key=len, reverse=True)
        )
        if not re.fullmatch(rf"[a-z0-9][a-z0-9-]*\.(?:{suffix_pattern})", hostname):
            raise HTTPException(status_code=400, detail="Proxy only allows Supabase storage URLs.")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL.")
    return url


@router.get("/proxy")
def proxy_material(url: str, request: Request):
    """
    Proxies a Supabase storage file so iframes can load it without
    being blocked by X-Frame-Options / CORS headers from Supabase.
    Only allows proxying URLs from Supabase storage hosts (SSRF protection).
    Range requests are forwarded so <video> seeking works through the proxy.
    """
    _validate_supabase_url(url)

    upstream_headers = {}
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    try:
        r = httpx.get(url, headers=upstream_headers, follow_redirects=True, timeout=30)
        r.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch file: {exc}")

    content_type = r.headers.get("content-type", "application/octet-stream")
    passthrough = {}
    for h in ("Content-Range", "Content-Length", "Accept-Ranges"):
        if r.headers.get(h):
            passthrough[h] = r.headers[h]
    if range_header and "Accept-Ranges" not in passthrough:
        passthrough["Accept-Ranges"] = "bytes"

    return StreamingResponse(
        iter([r.content]),
        status_code=r.status_code,
        media_type=content_type,
        headers={
            "Content-Disposition": "inline",
            **passthrough,
        },
    )
