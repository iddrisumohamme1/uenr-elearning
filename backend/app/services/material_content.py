# File: backend/app/services/material_content.py
# Purpose: Shared helpers for downloading material files and extracting text,
#          used by AI quiz generation, study resource generation and study insights.

import io
import re

import httpx
from pypdf import PdfReader


def fetch_material_content(content_url: str) -> bytes | None:
    """Download a material file from Supabase storage."""
    if not content_url:
        return None
    try:
        with httpx.Client(timeout=30, follow_redirects=True, verify=False) as client:
            r = client.get(content_url)
            r.raise_for_status()
            return r.content
    except Exception as exc:
        print(f"[material_content] Failed to download material: {exc}")
        return None


def extract_pdf_text(content: bytes) -> str:
    """Extract readable text from a PDF byte stream."""
    try:
        reader = PdfReader(io.BytesIO(content))
        pages = []
        for page in reader.pages:
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            if text:
                pages.append(text)
        return re.sub(r"\s+", " ", " ".join(pages)).strip()
    except Exception as exc:
        print(f"[material_content] PDF text extraction failed: {exc}")
        return ""


def material_text_from_url(content_url: str, content_type: str) -> str:
    """Download a material and return its readable text, or '' on failure."""
    if not content_url:
        return ""
    raw = fetch_material_content(content_url)
    if not raw:
        return ""
    ctype = (content_type or "").lower()
    if "pdf" in ctype:
        return extract_pdf_text(raw)
    if "text" in ctype or "markdown" in ctype or "json" in ctype:
        return raw.decode("utf-8", errors="ignore")
    return ""
