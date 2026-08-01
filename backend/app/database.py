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
import sys
import time

from supabase import create_client, Client

from app.core.config import settings


# Transient network failures (killed pooled connections on flaky networks,
# e.g. PostgREST <ConnectionTerminated error_code:9 ...>). We retry these and
# rebuild the cached client so the next attempt opens a fresh connection pool.
_CONNECTION_ERROR_MARKERS = (
    "connectionterminated",
    "connectionerror",
    "connecttimeout",
    "readtimeout",
    "writetimeout",
    "remoteprotocolerror",
    "serviceunavailable",
    "connection reset",
    "connection closed",
    "broken pipe",
    "peer reset",
    "stream error",
    "max retries exceeded",
    "failed to establish a new connection",
    "connectionterminated error_code",
    # Windows WSAEWOULDBLOCK (WinError 10035) — socket resource exhaustion
    # under concurrent requests. Transient; retrying with a fresh client works.
    "non-blocking socket operation could not be completed",
    "would block",
    "socket operation",
)


def _is_connection_error(exc: Exception) -> bool:
    text = f"{type(exc).__name__} {exc}".lower()
    return any(marker in text for marker in _CONNECTION_ERROR_MARKERS)


def with_retry(fn, retries: int = 5, delay: float = 0.4):
    """Run ``fn(get_admin_client())``, retrying transient connection failures.

    Each attempt fetches the *current* admin client, so when a pooled
    connection dies the cache is cleared and the next attempt builds a fresh
    client (new connection pool) before retrying.
    """
    for attempt in range(1, retries + 1):
        try:
            return fn(get_admin_client())
        except Exception as exc:
            if not _is_connection_error(exc) or attempt >= retries:
                raise
            print(
                f"[DB] retry {attempt}/{retries - 1} after {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            get_admin_client.cache_clear()
            time.sleep(delay * attempt)
    raise RuntimeError("with_retry exhausted")  # pragma: no cover


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
