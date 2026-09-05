# File: backend/app/routes/materials.py
# Purpose: Learning materials management and Supabase persistence.

import hashlib
import hmac
import time

import httpx
from pathlib import Path
from urllib.parse import unquote
from uuid import uuid4
from typing import List

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.core.security import get_current_user, optional_current_user, require_role
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

SIGNED_URL_TTL_SECONDS = 3600

# Native media elements (<img>/<video>/<iframe>, PDF.js) cannot attach an
# Authorization header, so the frontend fetches a short-lived, material-scoped
# HMAC token from /view-token/{id} and appends it as ?vt=. The token is signed
# with a derivation of the service-role key and covers only the given material,
# so it never exposes the user's JWT and can't be replayed on other materials.
VIEW_TOKEN_TTL_SECONDS = 3600


def _view_token_key() -> bytes:
    return hmac.new(
        settings.SUPABASE_SERVICE_ROLE_KEY.encode(),
        b"ufy-materials-view-token",
        hashlib.sha256,
    ).digest()


def _sign_view_token(material_id: str) -> str:
    expires_at = int(time.time()) + VIEW_TOKEN_TTL_SECONDS
    sig = hmac.new(
        _view_token_key(),
        f"{material_id}:{expires_at}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{expires_at}.{sig}"


def _verify_view_token(material_id: str, token: str) -> bool:
    try:
        expires_at_str, _, sig = token.partition(".")
        expires_at = int(expires_at_str)
    except (ValueError, AttributeError):
        return False
    if expires_at < int(time.time()):
        return False
    expected = hmac.new(
        _view_token_key(),
        f"{material_id}:{expires_at}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(sig, expected)


def _storage_path(value: str | None) -> str | None:
    """Normalize a stored material reference into a storage object path.

    Handles legacy public URLs (``…/storage/v1/object/public/materials/<course>/<file>``),
    the `content_url`/`render_url` URL form, and the modern bare-path form
    (``<course>/<file>``). Returns None when nothing usable is present.
    """
    if not value:
        return None
    value = value.strip()
    marker = f"/{BUCKET_NAME}/"
    if marker in value:
        value = value.split(marker, 1)[-1]
    path = unquote(value.split("?")[0]).strip("/")
    return path or None


def _signed_url(path: str, expires_in: int = SIGNED_URL_TTL_SECONDS) -> str | None:
    """Create a short-lived signed URL for a private storage object.

    The service-role client can read private buckets, so bursts of viewer
    requests are cheap; the 1h window keeps PDF/video sessions alive without
    ever exposing a stable public URL.
    """
    try:
        signed = with_retry(
            lambda c: c.storage.from_(BUCKET_NAME).create_signed_url(path, expires_in)
        )
    except Exception as exc:
        print(f"[materials] Failed to sign '{path}': {exc}")
        return None
    if isinstance(signed, dict):
        return signed.get("signedURL")
    data = getattr(signed, "data", None)
    return data.get("signedURL") if isinstance(data, dict) else None


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
        # Ensure the storage bucket exists AND is private. Files are never
        # exposed through a public URL: every read goes through the
        # access-checked /view and /download endpoints via short-lived
        # signed URLs, or the server-side text extractor.
        try:
            with_retry(lambda c: c.storage.get_bucket(BUCKET_NAME))
            try:
                with_retry(lambda c: c.storage.update_bucket(BUCKET_NAME, {"public": False}))
            except Exception:
                pass
        except Exception:
            with_retry(lambda c: c.storage.create_bucket(BUCKET_NAME, options={"public": False}))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to verify storage bucket: {exc}")

    try:
        # Standard upload for small files, TUS resumable (6 MB chunks) above
        # the threshold so large files survive mid-upload connection drops.
        upload_blob(BUCKET_NAME, storage_path, file_bytes, file.content_type or "application/octet-stream")
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
                render_url = pdf_path
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
                    "content_url": storage_path,
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
        path = _storage_path(material.get(key))
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

    url = _signed_url(_storage_path(material.get("content_url")) or "")
    if not url:
        raise HTTPException(status_code=502, detail="Material file is unavailable.")

    try:
        r = httpx.get(url, follow_redirects=True, timeout=30)
        r.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch file: {exc}")

    filename = Path(_storage_path(material.get("content_url")) or "").name or "material"
    content_type = material.get("content_type") or r.headers.get("content-type", "application/octet-stream")
    return StreamingResponse(
        iter([r.content]),
        media_type=content_type,
        headers={
            "Content-Disposition": f"attachment; filename=\"{filename}\"",
        },
    )


@router.get("/view-token/{material_id}")
def get_view_token(
    material_id: str,
    variant: str = "content",
    user=Depends(get_current_user),
):
    """Issue a short-lived, material-scoped token for media elements.

    Native <img>/<video>/<iframe> and PDF.js requests cannot carry the
    Authorization header. The frontend fetches this token with authFetch and
    appends it as ``?vt=``, so those requests are still access-checked. The
    token is an HMAC over (material id, expiry) derived from the server-side
    service-role key — it never contains the user's JWT and cannot be replayed
    against other materials.
    """
    admin = get_admin_client()

    try:
        mat_resp = with_retry(
            lambda c: c.table("materials")
            .select("id, course_id")
            .eq("id", material_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query material: {exc}")

    mat_data = getattr(mat_resp, "data", []) or []
    if not mat_data:
        raise HTTPException(status_code=404, detail="Material not found.")
    material = mat_data[0]

    _check_course_access(admin, user, material["course_id"])

    return {
        "token": _sign_view_token(material_id),
        "expires_in": VIEW_TOKEN_TTL_SECONDS,
        "expires_at": int(time.time()) + VIEW_TOKEN_TTL_SECONDS,
    }


@router.get("/view/{material_id}")
def view_material(
    material_id: str,
    request: Request,
    variant: str = "content",
    vt: str = "",
    user: dict | None = Depends(optional_current_user),
):
    """
    Serve a material file inline (Content-Disposition: inline) for embedded
    viewing — PDF.js, <video>, <img> and iframes. Range requests are forwarded
    so video seeking works.

    Auth: when ``vt`` (a material-scoped HMAC token from /view-token/{id}) is
    present it is verified against this material; otherwise the request must
    carry the user's bearer token and pass the course access check (enrolled
    students, same-department staff). Either way the file is fetched from the
    private bucket via a short-lived signed URL, so no public URL is exposed.
    ``variant`` selects the rendering copy: ``render`` (server PDF twin) or
    ``content`` (original upload).
    """
    admin = get_admin_client()

    try:
        mat_resp = with_retry(
            lambda c: c.table("materials")
            .select("id, course_id, title, content_url, render_url, content_type")
            .eq("id", material_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query material: {exc}")

    mat_data = getattr(mat_resp, "data", []) or []
    if not mat_data:
        raise HTTPException(status_code=404, detail="Material not found.")
    material = mat_data[0]

    if vt:
        if not _verify_view_token(material_id, vt):
            raise HTTPException(status_code=401, detail="Invalid or expired view token")
    else:
        if user is None:
            raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
        _check_course_access(admin, user, material["course_id"])

    path = _storage_path(material.get("render_url") if variant == "render" else material.get("content_url"))
    if not path:
        raise HTTPException(status_code=404, detail="No viewable file for this material.")
    url = _signed_url(path)
    if not url:
        raise HTTPException(status_code=502, detail="Failed to sign material file.")

    upstream_headers = {}
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    try:
        r = httpx.get(url, headers=upstream_headers, follow_redirects=True, timeout=30)
        r.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch file: {exc}")

    content_type = material.get("content_type") or r.headers.get("content-type", "application/octet-stream")
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
