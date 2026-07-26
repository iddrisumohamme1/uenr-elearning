# File: backend/app/database.py
# Purpose: Supabase client factories for the FastAPI backend.
#
# Two clients are provided:
#   - admin  : built with the SERVICE ROLE key. Bypasses Row Level Security.
#              Use for trusted server-side operations (creating users, reading
#              any profile, writing engagement scores, etc.).
#   - anon   : built with the ANON public key. Respects RLS. Used for actions
#              performed "as the user", e.g. signing in with email/password.
#
# Clients are cached so we don't rebuild them on every request.

from functools import lru_cache

from supabase import create_client, Client

from app.core.config import settings


@lru_cache(maxsize=1)
def get_admin_client() -> Client:
    """Service-role client (bypasses RLS). Server-side use only."""
    if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError(
            "Supabase admin credentials missing. Set SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY in backend/.env"
        )
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


@lru_cache(maxsize=1)
def get_anon_client() -> Client:
    """Anon client (RLS applies). Used for user sign-in."""
    if not settings.SUPABASE_URL or not settings.SUPABASE_ANON_KEY:
        raise RuntimeError(
            "Supabase anon credentials missing. Set SUPABASE_URL and "
            "SUPABASE_ANON_KEY in backend/.env"
        )
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY)
