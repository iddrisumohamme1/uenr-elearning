# File: backend/app/core/security.py
# Purpose: Reusable FastAPI dependency that authenticates a request using the
# Supabase access token sent by the frontend (Authorization: Bearer <token>).
#
# Protected routes can depend on `get_current_user` to require a valid session,
# and `require_role(...)` to restrict access to specific roles.

from fastapi import Depends, Header, HTTPException

from app.database import get_admin_client


def get_current_user(authorization: str = Header(default="")):
    """Validate the bearer token and return the user's profile row."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.split(" ", 1)[1].strip()
    admin = get_admin_client()

    # Ask Supabase who this token belongs to.
    try:
        result = admin.auth.get_user(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    auth_user = getattr(result, "user", None)
    if auth_user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Attach the profile (role/department) for convenience.
    profile = admin.table("users").select("*").eq("id", auth_user.id).execute()
    if not profile.data:
        raise HTTPException(status_code=404, detail="User profile not found")

    return profile.data[0]


def require_role(*roles: str):
    """Dependency factory: allow only the given roles."""

    def checker(user=Depends(get_current_user)):
        if user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user

    return checker
