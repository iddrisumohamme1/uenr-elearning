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


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserOut


class RefreshRequest(BaseModel):
    refresh_token: str
