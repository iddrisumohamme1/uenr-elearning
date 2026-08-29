# File: backend/app/routes/users.py
# Purpose: User lookup and self-served profile endpoints.

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import List
from pathlib import Path
from uuid import uuid4

from app.core.security import get_current_user, invalidate_user_cache, require_role
from app.database import get_admin_client, with_retry
from app.schemas.auth import ProfileUpdate

router = APIRouter(prefix="/api/users", tags=["users"])

AVATAR_BUCKET = "avatars"


class LecturerOut(BaseModel):
    id: str
    full_name: str
    email: str
    department: str | None = None


@router.get("/lecturers", response_model=List[LecturerOut])
def list_department_lecturers(user=Depends(require_role("hod"))):
    """Return lecturers (and teaching HODs) in the HOD's department."""
    if not user.get("department"):
        raise HTTPException(status_code=400, detail="HOD department is not configured.")

    admin = get_admin_client()
    try:
        response = with_retry(
            lambda c: c.table("users")
            .select("id, full_name, email, department")
            .eq("department", user["department"])
            .in_("role", ["lecturer", "hod"])
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query lecturers: {exc}")

    return getattr(response, "data", []) or []


class StudentOut(BaseModel):
    id: str
    full_name: str
    email: str
    index_number: str | None = None


@router.get("/students", response_model=List[StudentOut])
def list_department_students(user=Depends(require_role("hod"))):
    """Return all students registered in the HOD's department."""
    if not user.get("department"):
        raise HTTPException(status_code=400, detail="HOD department is not configured.")

    admin = get_admin_client()
    try:
        response = with_retry(
            lambda c: c.table("users")
            .select("id, full_name, email, index_number")
            .eq("department", user["department"])
            .eq("role", "student")
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query students: {exc}")

    return getattr(response, "data", []) or []


@router.get("/me")
def get_my_profile(user=Depends(get_current_user)):
    """Return the logged-in user's full profile row."""
    return user


@router.put("/me")
def update_my_profile(payload: ProfileUpdate, user=Depends(get_current_user)):
    """Update the logged-in user's self-editable profile fields.

    index_number is only accepted for students; staff_id only for
    lecturers/hods. Both are UNIQUE columns, so a conflicting value
    surfaces a 409 with a friendly message.
    """
    admin = get_admin_client()
    role = user.get("role")

    updates: dict = {}
    if payload.full_name is not None:
        name = payload.full_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Full name cannot be empty.")
        updates["full_name"] = name

    if payload.date_of_birth is not None:
        dob = (payload.date_of_birth or "").strip()
        updates["date_of_birth"] = dob or None

    if payload.phone is not None:
        phone = (payload.phone or "").strip()
        updates["phone"] = phone or None

    # Identify the role-appropriate ID field.
    if role == "student":
        if payload.index_number is not None:
            index = (payload.index_number or "").strip()
            updates["index_number"] = index or None
        if payload.staff_id is not None:
            raise HTTPException(status_code=403, detail="Students cannot set a staff ID.")
    else:
        if payload.staff_id is not None:
            staff = (payload.staff_id or "").strip()
            updates["staff_id"] = staff or None
        if payload.index_number is not None:
            raise HTTPException(status_code=403, detail="Only students can set an index number.")

    if not updates:
        return user

    try:
        response = (
            admin.table("users")
            .update(updates)
            .eq("id", user["id"])
            .select("*")
            .execute()
        )
    except Exception as exc:
        # A UNIQUE violation means the index number / staff ID is taken.
        detail = str(exc).lower()
        if "duplicate key" in detail or "unique" in detail:
            if "index" in detail and "staff" not in detail:
                raise HTTPException(status_code=409, detail="That index number is already in use.")
            if "staff" in detail:
                raise HTTPException(status_code=409, detail="That staff ID is already in use.")
        raise HTTPException(status_code=500, detail=f"Failed to update profile: {exc}")

    if not response.data:
        raise HTTPException(status_code=404, detail="User profile not found")

    # Drop the short-lived auth cache entry so future reads are fresh.
    invalidate_user_cache(user["id"])

    return response.data[0]


@router.post("/profile/avatar")
def upload_avatar(
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    """Upload a profile avatar image and update the user's avatar_url."""
    admin = get_admin_client()

    # Validate file type
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed.")

    # Validate file size (max 2MB)
    file_bytes = file.file.read()
    if len(file_bytes) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image must be under 2MB.")

    file_name = Path(file.filename).name
    storage_path = f"{user['id']}/{uuid4().hex}-{file_name}"

    try:
        admin.storage.create_bucket(AVATAR_BUCKET, options={"public": True})
    except Exception as exc:
        if "already exists" not in str(exc).lower():
            raise HTTPException(status_code=500, detail=f"Failed to verify storage bucket: {exc}")

    try:
        bucket = admin.storage.from_(AVATAR_BUCKET)
        file.file.seek(0)
        bucket.upload(storage_path, file_bytes)
        public_url = bucket.get_public_url(storage_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to upload avatar: {exc}")

    # Update user profile with avatar URL
    try:
        admin.table("users").update({"avatar_url": public_url}).eq("id", user["id"]).execute()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to update profile: {exc}")

    # Mirror the avatar into the user's metadata (merged, not replaced) so
    # future logins can build the profile without a DB round trip.
    try:
        admin.auth.admin.update_user_by_id(user["id"], {"user_metadata": {"avatar_url": public_url}})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to update profile metadata: {exc}")

    return {"avatar_url": public_url}
