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

from app.database import get_admin_client, get_anon_client, with_retry
from app.schemas.auth import (
    ALLOWED_ROLES,
    AuthResponse,
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    UserOut,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _profile_from_auth_user(auth_user) -> UserOut | None:
    """Build the user profile from Supabase user_metadata (no DB round trip).

    Returns None when metadata lacks any profile field (legacy accounts
    created before department/avatar landed in metadata), so the caller can
    fall back to the public.users table.
    """
    meta = getattr(auth_user, "user_metadata", None) or {}
    required = ("full_name", "role", "department", "avatar_url")
    if not all(k in meta for k in required):
        return None
    return UserOut(
        id=auth_user.id,
        full_name=meta["full_name"],
        email=auth_user.email,
        role=meta["role"],
        department=meta.get("department"),
        avatar_url=meta.get("avatar_url"),
    )


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
                    "department": payload.department,
                    "avatar_url": None,
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

    # 2. Build the profile from the signed-in user's metadata. For accounts
    #    created before department/avatar landed in metadata (or with empty
    #    metadata), fall back to the public.users table.
    profile = _profile_from_auth_user(auth_user)
    if profile is None:
        admin = get_admin_client()
        row = with_retry(lambda c: c.table("users").select("*").eq("id", auth_user.id).execute())
        if not row.data:
            raise HTTPException(status_code=404, detail="User profile not found")
        profile = UserOut(**row.data[0])

    return AuthResponse(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        user=profile,
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

    profile = _profile_from_auth_user(auth_user)
    if profile is None:
        admin = get_admin_client()
        row = with_retry(lambda c: c.table("users").select("*").eq("id", auth_user.id).execute())
        if not row.data:
            raise HTTPException(status_code=404, detail="User profile not found")
        profile = UserOut(**row.data[0])

    return AuthResponse(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        user=profile,
    )
