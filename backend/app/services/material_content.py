# File: backend/app/services/material_content.py
# Purpose: Shared helpers for downloading material files and extracting text,
#          used by AI quiz generation, study resource generation and study insights.

import io
import re
from pathlib import Path
from urllib.parse import unquote

import httpx
from pypdf import PdfReader

from app.database import get_storage_client, with_retry
from app.services.doc_converter import convert_to_pdf, is_office_file


def _storage_path(value: str) -> str | None:
    """Derive a storage object path from a stored reference.

    Accepts the modern bare-path form (``<course>/<file>``) and legacy public
    URLs (``…/storage/v1/object/public/materials/<course>/<file>``). URL
    escapes are decoded because Supabase object keys hold literal characters.
    """
    if not value:
        return None
    value = value.strip()
    marker = "/materials/"
    if marker in value:
        value = value.split(marker, 1)[-1]
    path = unquote(value.split("?")[0]).strip("/")
    return path or None


def fetch_material_content(content_url: str) -> bytes | None:
    """Download a material file from Supabase storage.

    Files live in a private bucket, so reads go through the service-role
    Storage client (path form). Legacy rows that still store a public URL
    fall back to an HTTP fetch, then to the Storage client in case the
    bucket was already made private.
    """
    if not content_url:
        return None
    path = _storage_path(content_url)
    if path:
        try:
            downloaded = with_retry(
                lambda c: c.storage.from_("materials").download(path)
            )
            return downloaded
        except Exception as exc:
            print(f"[material_content] Storage download failed for '{path}': {exc}")
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
    """Download a material and return its readable text, or '' on failure.

    Supports PDFs, plain text formats, and Office documents (Word/Excel/ODF
    via python-docx/openpyxl, remaining formats via LibreOffice → PDF) so AI
    quiz/assignment generation is always grounded in the real course content.
    """
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

    # Office documents: route fast, library-free paths first so LibreOffice
    # (a heavier dependency) is only consulted for formats the pure-Python
    # parsers cannot read.
    filename = Path(unquote((content_url or "").split("?")[0])).name
    suffix = Path(filename).suffix.lower()

    if "wordprocessingml" in ctype or suffix == ".docx":
        return _extract_docx_text(raw)
    if "spreadsheet" in ctype or suffix == ".xlsx":
        return _extract_xlsx_text(raw)

    probe = f"material{suffix or '.docx'}"
    if is_office_file(probe):
        pdf = convert_to_pdf(raw, probe)
        if pdf:
            return extract_pdf_text(pdf)

    return ""


def _extract_docx_text(raw: bytes) -> str:
    """Read a .docx byte stream as plain text (paragraphs + table cells)."""
    try:
        import docx

        doc = docx.Document(io.BytesIO(raw))
        parts = [p.text for p in doc.paragraphs if p.text and p.text.strip()]
        for table in doc.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return re.sub(r"\s+", " ", " ".join(parts)).strip()
    except Exception as exc:
        print(f"[material_content] DOCX text extraction failed: {exc}")
        return ""


def _extract_xlsx_text(raw: bytes) -> str:
    """Read an .xlsx workbook as plain text, cell values row by row."""
    try:
        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        parts = []
        try:
            for ws in wb.worksheets:
                for row in ws.iter_rows(values_only=True):
                    vals = [str(v).strip() for v in row if v is not None and str(v).strip()]
                    if vals:
                        parts.append(" ".join(vals))
        finally:
            wb.close()
        return re.sub(r"\s+", " ", " ".join(parts)).strip()
    except Exception as exc:
        print(f"[material_content] XLSX text extraction failed: {exc}")
        return ""
