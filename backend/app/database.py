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
from io import BytesIO
import sys
import time
from urllib.parse import urlparse

import httpx
from supabase import create_client, Client
from supabase.lib.client_options import SyncClientOptions
from storage3 import SyncStorageClient
from tusclient import client as tus_client

from app.core.config import settings


# Timeouts for the underlying HTTP client. A short connect timeout makes
# transient network drops (see with_retry) fail fast so retries kick in
# quickly instead of stalling each attempt for the httpx default (5s).
_DB_TIMEOUT = httpx.Timeout(15.0, connect=3.0)

# Storage (blob) uploads move large binaries (up to 50 MB), which legitimately
# take much longer than the fast DB queries. Give the storage client its own
# generous timeout so big material files upload cleanly instead of dying on the
# shared PostgREST WriteTimeout.
_STORAGE_TIMEOUT = httpx.Timeout(500.0, connect=15.0)

# Max material file size, enforced server-side (mirrors the frontend 50 MB cap).
MATERIAL_MAX_BYTES = 50 * 1024 * 1024

# Supabase recommends the standard single-request upload only for files below
# 6 MB. Everything larger goes through the TUS resumable protocol instead,
# which splits the blob into 6 MB chunks (a Supabase requirement) and resumes
# from the server-reported offset after transient drops.
STANDARD_UPLOAD_MAX_BYTES = 6 * 1024 * 1024
TUS_CHUNK_SIZE = 6 * 1024 * 1024

# tuspy retries a failing chunk (HEAD to learn the offset, then re-PATCH) up
# to this many times before surfacing the error to the caller's retry loop.
_TUS_CHUNK_RETRIES = 5
_TUS_CHUNK_RETRY_DELAY_SECONDS = 1.0


def _build_client(url: str, key: str) -> Client:
    return create_client(
        url,
        key,
        options=SyncClientOptions(
            httpx_client=httpx.Client(timeout=_DB_TIMEOUT),
        ),
    )


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
    # DNS / name-resolution failures (e.g. `getaddrinfo failed`), which on
    # flaky networks surface as ConnectError and must be retried like any
    # other transient connection drop.
    "getaddrinfo failed",
    "nodename nor servname provided",
    "temporary failure in name resolution",
    "gaierror",
    "connecterror",
    # Windows WSAEWOULDBLOCK (WinError 10035) — socket resource exhaustion
    # under concurrent requests. Transient; retrying with a fresh client works.
    "non-blocking socket operation could not be completed",
    "would block",
    "socket operation",
    # Windows WSAEACCES (WinError 10013) — the OS refused the connect itself,
    # usually a security-suite (AVG/Reason/Defender) per-process block on
    # python.exe outbound sockets rather than poor credentials or settings.
    # Retrying is still correct: transient blocks clear, and a fresh client
    # skips any poisoned connection pool.
    "wsaeacces",
    "access a socket in a way forbidden",
    "forbidden by its access permissions",
    "[winerror 10013]",
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
    return _build_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


@lru_cache(maxsize=1)
def get_storage_client() -> SyncStorageClient:
    """Service-role Storage client with a long (500s) timeout for blob uploads.

    Uses its own httpx client so Material/avatar file uploads of up to 50 MB do
    not inherit the fast PostgREST timeout (which would raise a WriteTimeout on
    large files). The header set matches what the supabase client sends
    (apiKey + Authorization) with the service-role key.
    """
    if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError(
            "Supabase admin credentials missing. Set SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY in backend/.env"
        )
    storage_url = f"{settings.SUPABASE_URL.rstrip('/')}/storage/v1/"
    headers = {
        "apiKey": settings.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
    }
    return SyncStorageClient(
        storage_url,
        headers,
        http_client=httpx.Client(timeout=_STORAGE_TIMEOUT),
    )


def with_retry_storage(fn, retries: int = 3, delay: float = 0.6):
    """Run ``fn(get_storage_client())`` with the same transient-failure retry
    semantics as ``with_retry``, but against the long-timeout Storage client so
    large uploads are not cut short."""
    for attempt in range(1, retries + 1):
        try:
            return fn(get_storage_client())
        except Exception as exc:
            if not _is_connection_error(exc) or attempt >= retries:
                raise
            print(
                f"[DB] storage retry {attempt}/{retries - 1} after {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            get_storage_client.cache_clear()
            time.sleep(delay * attempt)
    raise RuntimeError("with_retry_storage exhausted")  # pragma: no cover


def _tus_endpoint() -> str:
    """Supabase TUS endpoint on the direct ``<ref>.storage.supabase.co``
    hostname, which Supabase recommends for large uploads (better throughput
    than the project URL)."""
    host = urlparse(settings.SUPABASE_URL).hostname or ""
    ref = host.split(".")[0]
    return f"https://{ref}.storage.supabase.co/storage/v1/upload/resumable"


def tus_upload_blob(bucket: str, path: str, data: bytes, content_type: str, cache_control: str = "3600") -> str:
    """Upload ``data`` to Supabase storage using the TUS resumable protocol.

    The blob is split into 6 MB chunks (a Supabase requirement) and each chunk
    is acknowledged before the next is sent, so a dropped connection resumes
    from the last confirmed offset instead of restarting the whole file.
    Returns ``path`` so the caller can build the public URL.
    """
    for attempt in range(1, 4):
        try:
            uploader = tus_client.TusClient(
                _tus_endpoint(),
                headers={
                    "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
                    "x-upsert": "true",
                },
            ).uploader(
                file_stream=BytesIO(data),
                chunk_size=TUS_CHUNK_SIZE,
                metadata={
                    "bucketName": bucket,
                    "objectName": path,
                    "contentType": content_type,
                    "cacheControl": cache_control,
                },
                retries=_TUS_CHUNK_RETRIES,
                retry_delay=_TUS_CHUNK_RETRY_DELAY_SECONDS,
            )
            uploader.upload()
            return path
        except Exception as exc:
            if attempt >= 3:
                raise
            print(
                f"[storage] TUS attempt {attempt}/3 failed after {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(0.8 * attempt)
    raise RuntimeError("tus_upload_blob exhausted")  # pragma: no cover


def upload_blob(bucket: str, path: str, data: bytes, content_type: str, cache_control: str = "3600") -> str:
    """Upload a blob to Supabase storage, returning ``path``.

    The proven single-request standard upload is used for files at or below the
    standard-upload threshold; larger files use the TUS resumable protocol so
    they survive mid-upload connection drops.
    """
    if len(data) <= STANDARD_UPLOAD_MAX_BYTES:
        options = {"content-type": content_type} if content_type else None
        with_retry_storage(
            lambda c: c.from_(bucket).upload(path, data, options)
        )
    else:
        tus_upload_blob(bucket, path, data, content_type, cache_control)
    return path


@lru_cache(maxsize=1)
def get_anon_client() -> Client:
    """Anon client (RLS applies). Used for user sign-in."""
    if not settings.SUPABASE_URL or not settings.SUPABASE_ANON_KEY:
        raise RuntimeError(
            "Supabase anon credentials missing. Set SUPABASE_URL and "
            "SUPABASE_ANON_KEY in backend/.env"
        )
    return _build_client(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY)
