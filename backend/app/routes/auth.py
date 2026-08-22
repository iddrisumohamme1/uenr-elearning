# File: backend/app/routes/auth.py
# Purpose: Authentication endpoints backed by Supabase Auth.
#
# Flow (Frontend -> FastAPI -> Supabase):
#   POST /api/auth/register  ->  creates a Supabase auth user (auto-confirmed)
#                                and a matching row in the public.users table.
#   POST /api/auth/login     ->  signs in via Supabase, returns the access token
#                                and the user's profile (used by the frontend to
#                                redirect based on role).

import sys
import time
from typing import NoReturn

from fastapi import APIRouter, HTTPException

try:  # supabase-py >= 2.12 ships supabase_auth; older versions use gotrue
    from supabase_auth.errors import AuthApiError, AuthRetryableError
except ImportError:  # pragma: no cover
    from gotrue.errors import AuthApiError, AuthRetryableError

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


def _fail(status_code: int, detail: str) -> NoReturn:
    raise HTTPException(status_code=status_code, detail=detail)


def _classify_auth_error(
    exc: Exception,
    unauthorized_detail: str = "Invalid email or password",
) -> HTTPException:
    """Map a Supabase auth failure to an accurate, frontend-friendly error.

    The old behaviour swallowed every exception into a 401 "Invalid email or
    password", which hid outages and mislabelled transient failures as bad
    credentials.
    """
    if isinstance(exc, AuthApiError):
        text = str(exc).lower()
        code = getattr(exc, "code", None)
        if exc.status == 400 and (code == "invalid_credentials" or "invalid" in text):
            return HTTPException(status_code=401, detail=unauthorized_detail)
        if code == "email_not_confirmed" or "not confirmed" in text:
            return HTTPException(status_code=403, detail="Email address is not confirmed.")
        if exc.status == 429:
            return HTTPException(
                status_code=429,
                detail="Too many attempts. Please wait a moment and try again.",
            )
        return HTTPException(
            status_code=502, detail=f"Authentication service error: {exc}"
        )

    # Network / connection problems reaching Supabase are retryable blips,
    # not wrong passwords.
    text = f"{type(exc).__name__} {exc}".lower()
    markers = (
        "connect", "timeout", "connection", "unreachable",
        "failed to fetch", "max retries", "temporarily unavailable",
    )
    if isinstance(exc, AuthRetryableError) or any(m in text for m in markers):
        return HTTPException(
            status_code=503,
            detail="Authentication service unreachable. Please try again.",
        )

    return HTTPException(
        status_code=503, detail="Sign-in failed unexpectedly. Please try again."
    )


def _classified_failure(
    context: str,
    exc: Exception,
    unauthorized_detail: str = "Invalid email or password",
) -> HTTPException:
    """Log the underlying cause (so outages are diagnosable) and classify it."""
    print(
        f"[auth] {context} failed: {type(exc).__name__}: {exc}",
        file=sys.stderr,
        flush=True,
    )
    return _classify_auth_error(exc, unauthorized_detail=unauthorized_detail)


def _anon_client_or_503():
    try:
        return get_anon_client()
    except RuntimeError as exc:  # missing/invalid Supabase configuration
        print(f"[auth] anon client unavailable: {exc}", file=sys.stderr, flush=True)
        _fail(503, "Authentication service is not configured. Contact support.")


def _sign_in_with_retry(anon, email: str, password: str):
    """Sign in via Supabase, retrying briefly on transient network/service errors.

    The connection to Supabase from campus networks drops intermittently;
    a couple of quick retries rides out short blips without punishing real
    wrong-password attempts (those fail immediately).
    """
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            return anon.auth.sign_in_with_password(
                {"email": email, "password": password}
            )
        except Exception as exc:
            last_exc = exc
            classified = _classify_auth_error(exc)
            if attempt < 2 and classified.status_code == 503:
                time.sleep(1.0 * (attempt + 1))
                continue
            break
    assert last_exc is not None
    raise _classified_failure("login", last_exc)


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

    try:
        admin = get_admin_client()
    except RuntimeError as exc:
        print(f"[auth] admin client unavailable: {exc}", file=sys.stderr, flush=True)
        _fail(503, "Authentication service is not configured. Contact support.")

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
    anon = _anon_client_or_503()

    # 1. Verify credentials via Supabase Auth (retries transient failures).
    result = _sign_in_with_retry(anon, payload.email, payload.password)

    session = getattr(result, "session", None)
    auth_user = getattr(result, "user", None)
    if session is None or auth_user is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # 2. Build the profile from the signed-in user's metadata. For accounts
    #    created before department/avatar landed in metadata (or with empty
    #    metadata), fall back to the public.users table.
    profile = _profile_from_auth_user(auth_user)
    if profile is None:
        try:
            row = with_retry(lambda c: c.table("users").select("*").eq("id", auth_user.id).execute())
        except Exception as exc:
            print(f"[auth] profile lookup failed: {exc}", file=sys.stderr, flush=True)
            raise HTTPException(
                status_code=503,
                detail="Could not load your profile. Please try again.",
            )
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
    anon = _anon_client_or_503()

    try:
        result = anon.auth.refresh_session(payload.refresh_token)
    except Exception as exc:
        raise _classified_failure(
            "refresh", exc, unauthorized_detail="Session expired. Please sign in again."
        )

    session = getattr(result, "session", None)
    auth_user = getattr(result, "user", None)
    if session is None or auth_user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    profile = _profile_from_auth_user(auth_user)
    if profile is None:
        try:
            row = with_retry(lambda c: c.table("users").select("*").eq("id", auth_user.id).execute())
        except Exception as exc:
            print(f"[auth] profile lookup failed: {exc}", file=sys.stderr, flush=True)
            raise HTTPException(
                status_code=503,
                detail="Could not load your profile. Please try again.",
            )
        if not row.data:
            raise HTTPException(status_code=404, detail="User profile not found")
        profile = UserOut(**row.data[0])

    return AuthResponse(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        user=profile,
    )
