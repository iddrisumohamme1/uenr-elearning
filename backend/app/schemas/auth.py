# File: backend/app/schemas/auth.py
# Purpose: Request/response models for the auth endpoints.

from typing import Optional

from pydantic import BaseModel

# Roles allowed in the system (mirrors the DB CHECK constraint on users.role).
ALLOWED_ROLES = {"student", "lecturer", "hod"}


class RegisterRequest(BaseModel):
    full_name: str
    email: str
    password: str
    role: str
    department: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    id: str
    full_name: str
    email: str
    role: str
    department: Optional[str] = None
    avatar_url: Optional[str] = None
    date_of_birth: Optional[str] = None
    index_number: Optional[str] = None
    staff_id: Optional[str] = None
    phone: Optional[str] = None


class ProfileUpdate(BaseModel):
    """Self-served profile edits from the Settings page."""
    full_name: Optional[str] = None
    date_of_birth: Optional[str] = None  # ISO date (YYYY-MM-DD), cleared to null when empty
    index_number: Optional[str] = None   # students only
    staff_id: Optional[str] = None       # lecturers/hods only
    phone: Optional[str] = None


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserOut


class RefreshRequest(BaseModel):
    refresh_token: str
