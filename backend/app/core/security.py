# File: backend/app/core/security.py
# Purpose: Reusable FastAPI dependency that authenticates a request using the
# Supabase access token sent by the frontend (Authorization: Bearer <token>).
#
# Protected routes can depend on `get_current_user` to require a valid session,
# and `require_role(...)` to restrict access to specific roles.

from fastapi import Depends, Header, HTTPException

from app.database import get_admin_client, with_retry

# Short-lived cache of resolved users keyed by token hash. After login the
# dashboard fires several parallel requests with the same token; without this
# each one would make two Supabase round trips (get_user + profile query).
# Staleness is bounded by the TTL (<= _AUTH_CACHE_TTL_S for role/avatar/
# department changes), which is acceptable for this app.
import hashlib
import time

_AUTH_CACHE: dict[str, tuple[float, dict]] = {}
_AUTH_CACHE_TTL_S = 10


def invalidate_user_cache(user_id: str):
    """Drop cached profile rows for the given user.

    Called after a self-served profile update so a subsequent
    get_current_user returns fresh data instead of a stale row.
    """
    for key in list(_AUTH_CACHE.keys()):
        _, profile = _AUTH_CACHE[key]
        if profile and profile.get("id") == user_id:
            _AUTH_CACHE.pop(key, None)


def _resolve_user(token: str) -> dict | None:
    """Validate a bearer token and return the user's profile row, or None if
    the token is missing/invalid."""
    admin = get_admin_client()

    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    cached = _AUTH_CACHE.get(key)
    if cached and now - cached[0] < _AUTH_CACHE_TTL_S:
        return cached[1]

    # Ask Supabase who this token belongs to.
    try:
        result = with_retry(lambda c: c.auth.get_user(token))
    except Exception as exc:
        import sys
        print(f"[SECURITY] get_user failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return None

    auth_user = getattr(result, "user", None)
    if auth_user is None:
        return None

    # Attach the profile (role/department) for convenience.
    try:
        profile = with_retry(lambda c: c.table("users").select("*").eq("id", auth_user.id).execute())
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to load user profile")
    if not profile.data:
        raise HTTPException(status_code=404, detail="User profile not found")

    _AUTH_CACHE[key] = (now, profile.data[0])
    return profile.data[0]


def get_current_user(authorization: str = Header(default="")):
    """Validate the bearer token and return the user's profile row."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    user = _resolve_user(authorization.split(" ", 1)[1].strip())
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user


def optional_current_user(authorization: str = Header(default="")):
    """Like get_current_user, but returns None when no bearer token is sent.

    Used by read-only endpoints that also accept a scoped query token (e.g.
    media elements that cannot attach an Authorization header). An invalid
    *present* token still resolves to None so callers can reject explicitly.
    """
    if not authorization.startswith("Bearer "):
        return None
    return _resolve_user(authorization.split(" ", 1)[1].strip())


def require_role(*roles: str):
    """Dependency factory: allow only the given roles."""

    def checker(user=Depends(get_current_user)):
        if user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user

    return checker
