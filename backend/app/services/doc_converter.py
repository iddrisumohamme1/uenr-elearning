# File: backend/app/services/doc_converter.py
# Purpose: Convert Office documents (Word/PowerPoint/Excel/ODF) to PDF using
#          LibreOffice headless so they can be rendered by PDF.js in-app.
#
# Why: Office files can only be previewed in a cross-origin iframe, which
# swallows every pointer event — engagement tracking and text highlighting
# are impossible inside it. The converted PDF renders on our own page where
# clicks/scrolls/highlights are observable.
#
# Design contract: conversion is a best-effort enhancement. Every failure
# path returns None and the caller stores the material without a render_url,
# falling back to today's embedded-viewer behaviour. An upload NEVER fails
# because conversion failed.

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from app.core.config import settings

# Windows install locations probed in order; Linux/macOS rely on PATH.
_SOFFICE_CANDIDATES = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Programs\LibreOffice\program\soffice.exe"),
]

OFFICE_EXTS = {".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp", ".ods"}

_CONVERT_TIMEOUT_SECONDS = 90


def find_soffice() -> str | None:
    """Locate the LibreOffice executable, or None when unavailable."""
    if not settings.DOC_CONVERSION_ENABLED:
        return None
    override = os.environ.get("SOFFICE_PATH")
    if override and Path(override).is_file():
        return override
    for cand in _SOFFICE_CANDIDATES:
        if cand and Path(cand).is_file():
            return cand
    return shutil.which("soffice")


def is_office_file(filename: str) -> bool:
    return Path(filename or "").suffix.lower() in OFFICE_EXTS


def convert_to_pdf(data: bytes, filename: str, timeout: int = _CONVERT_TIMEOUT_SECONDS) -> bytes | None:
    """
    Convert an Office document to PDF bytes via `soffice --headless`.

    Returns the PDF bytes, or None when LibreOffice is missing or anything
    goes wrong (timeout, bad document, crash) — callers treat None as
    "no conversion available".
    """
    soffice = find_soffice()
    if not soffice:
        return None

    workdir = tempfile.mkdtemp(prefix="docconv-")
    try:
        src = Path(workdir) / f"input{Path(filename or 'document').suffix.lower() or '.bin'}"
        src.write_bytes(data)

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        result = subprocess.run(
            [
                soffice,
                "--headless",
                "--norestore",
                "--nolockcheck",
                "--convert-to",
                "pdf",
                "--outdir",
                workdir,
                str(src),
            ],
            capture_output=True,
            timeout=timeout,
            creationflags=creationflags,
        )

        pdf_path = src.with_suffix(".pdf")
        if result.returncode != 0 or not pdf_path.is_file():
            print(
                f"[doc-converter] Conversion failed for '{filename}': "
                f"rc={result.returncode}, stderr={result.stderr[:200]!r}"
            )
            return None
        return pdf_path.read_bytes()
    except subprocess.TimeoutExpired:
        print(f"[doc-converter] Timed out converting '{filename}' after {timeout}s.")
        return None
    except Exception as exc:
        print(f"[doc-converter] Unexpected error converting '{filename}': {exc}")
        return None
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
