# File: backend/app/routes/users.py
# Purpose: User lookup endpoints for HOD and lecturer workflows.

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import List
from pathlib import Path
from uuid import uuid4

from app.core.security import get_current_user, require_role
from app.database import get_admin_client

router = APIRouter(prefix="/api/users", tags=["users"])

AVATAR_BUCKET = "avatars"


class LecturerOut(BaseModel):
    id: str
    full_name: str
    email: str
    department: str | None = None


@router.get("/lecturers", response_model=List[LecturerOut])
def list_department_lecturers(user=Depends(require_role("hod"))):
    """Return lecturers in the HOD's department."""
    if not user.get("department"):
        raise HTTPException(status_code=400, detail="HOD department is not configured.")

    admin = get_admin_client()
    try:
        response = (
            admin.table("users")
            .select("id, full_name, email, department")
            .eq("department", user["department"])
            .eq("role", "lecturer")
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query lecturers: {exc}")

    return getattr(response, "data", []) or []


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

    return {"avatar_url": public_url}
