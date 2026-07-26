# File: backend/app/routes/auth.py
# Purpose: Authentication endpoints backed by Supabase Auth.
#
# Flow (Frontend -> FastAPI -> Supabase):
#   POST /api/auth/register  ->  creates a Supabase auth user (auto-confirmed)
#                                and a matching row in the public.users table.
#   POST /api/auth/login     ->  signs in via Supabase, returns the access token
#                                and the user's profile (used by the frontend to
#                                redirect based on role).

from fastapi import APIRouter, HTTPException

from app.database import get_admin_client, get_anon_client
from app.schemas.auth import (
    ALLOWED_ROLES,
    AuthResponse,
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    UserOut,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=201)
def register(payload: RegisterRequest):
    if payload.role not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role: {payload.role}")

    if payload.role in {"lecturer", "hod"} and not payload.department:
        raise HTTPException(status_code=400, detail="Department is required for lecturer and HOD accounts.")

    admin = get_admin_client()

    # 1. Create the auth user. email_confirm=True auto-confirms so the user can
    #    log in immediately (no email verification step needed for the demo).
    try:
        result = admin.auth.admin.create_user(
            {
                "email": payload.email,
                "password": payload.password,
                "email_confirm": True,
                "user_metadata": {
                    "full_name": payload.full_name,
                    "role": payload.role,
                },
            }
        )
    except Exception as exc:  # supabase raises on duplicate email, weak password, etc.
        raise HTTPException(status_code=400, detail=f"Could not create account: {exc}")

    auth_user = getattr(result, "user", None)
    if auth_user is None:
        raise HTTPException(status_code=400, detail="Registration failed")

    # 2. Create the matching profile row in public.users.
    profile = {
        "id": auth_user.id,
        "full_name": payload.full_name,
        "email": payload.email,
        "role": payload.role,
        "department": payload.department,
    }
    try:
        admin.table("users").insert(profile).execute()
    except Exception as exc:
        # Roll back the auth user so the account isn't left half-created.
        try:
            admin.auth.admin.delete_user(auth_user.id)
        except Exception:
            pass
        raise HTTPException(status_code=400, detail=f"Profile creation failed: {exc}")

    return UserOut(**profile)


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginRequest):
    anon = get_anon_client()

    # 1. Verify credentials via Supabase Auth.
    try:
        result = anon.auth.sign_in_with_password(
            {"email": payload.email, "password": payload.password}
        )
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    session = getattr(result, "session", None)
    auth_user = getattr(result, "user", None)
    if session is None or auth_user is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # 2. Load the profile (role, name) for the frontend redirect.
    admin = get_admin_client()
    profile = admin.table("users").select("*").eq("id", auth_user.id).execute()
    if not profile.data:
        raise HTTPException(status_code=404, detail="User profile not found")

    return AuthResponse(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        user=UserOut(**profile.data[0]),
    )


@router.post("/refresh", response_model=AuthResponse)
def refresh_session(payload: RefreshRequest):
    """Exchange a valid refresh token for a new access + refresh token pair."""
    anon = get_anon_client()

    try:
        result = anon.auth.refresh_session(payload.refresh_token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    session = getattr(result, "session", None)
    auth_user = getattr(result, "user", None)
    if session is None or auth_user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    admin = get_admin_client()
    profile = admin.table("users").select("*").eq("id", auth_user.id).execute()
    if not profile.data:
        raise HTTPException(status_code=404, detail="User profile not found")

    return AuthResponse(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        user=UserOut(**profile.data[0]),
    )
