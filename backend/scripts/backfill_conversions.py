# File: backend/scripts/backfill_conversions.py
# Purpose: One-time utility that converts LEGACY Office materials (uploaded
#          before server-side conversion existed) into PDF twins and records
#          their render_url.
#
# Run from the project root with the venv active:
#   python backend/scripts/backfill_conversions.py            # convert all pending
#   python backend/scripts/backfill_conversions.py --limit 5  # first 5 only
#   python backend/scripts/backfill_conversions.py --dry-run  # list, don't touch
#
# Requires LibreOffice on this machine (soffice). Materials already carrying a
# render_url are skipped. Non-Office files are skipped.

import argparse
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import get_admin_client  # noqa: E402
from app.routes.materials import BUCKET_NAME  # noqa: E402
from app.services.doc_converter import (  # noqa: E402
    OFFICE_EXTS,
    convert_to_pdf,
    find_soffice,
)

URL_PREFIX = f"/storage/v1/object/public/{BUCKET_NAME}/"


def storage_path_from_url(url: str) -> str | None:
    path = urlparse(url).path
    idx = path.find(URL_PREFIX)
    if idx == -1:
        return None
    return path[idx + len(URL_PREFIX):]


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert legacy Office materials to PDF.")
    parser.add_argument("--limit", type=int, default=0, help="Max materials to process (0 = all)")
    parser.add_argument("--dry-run", action="store_true", help="List candidates without converting")
    args = parser.parse_args()

    soffice = find_soffice()
    if not soffice:
        print("LibreOffice not found on this machine - nothing to do.")
        print("Install LibreOffice or set SOFFICE_PATH, then rerun.")
        return 1
    print(f"Using LibreOffice: {soffice}")

    admin = get_admin_client()
    resp = admin.table("materials").select("id, title, content_url, render_url").is_("render_url", "null").execute()
    rows = resp.data or []

    candidates = [
        r for r in rows
        if Path(urlparse(r.get("content_url") or "").path).suffix.lower() in OFFICE_EXTS
        and storage_path_from_url(r["content_url"])
    ]
    print(f"{len(candidates)} Office material(s) without a PDF version.")

    if args.dry_run:
        for r in candidates:
            print(f"  [dry-run] {r['title']}")
        return 0

    if args.limit > 0:
        candidates = candidates[: args.limit]

    ok = failed = 0
    for r in candidates:
        title = r["title"]
        url = r["content_url"]
        spath = storage_path_from_url(url)
        try:
            file_bytes = httpx.get(url, follow_redirects=True, timeout=60).content
            pdf_bytes = convert_to_pdf(file_bytes, Path(spath).name)
            if not pdf_bytes:
                raise RuntimeError("conversion returned no data")
            pdf_path = f"{Path(spath).stem}.pdf"
            bucket = admin.storage.from_(BUCKET_NAME)
            bucket.upload(pdf_path, pdf_bytes, {"content-type": "application/pdf"})
            render_url = bucket.get_public_url(pdf_path)
            admin.table("materials").update({"render_url": render_url}).eq("id", r["id"]).execute()
            ok += 1
            print(f"  converted: {title}")
        except Exception as exc:
            failed += 1
            print(f"  FAILED:    {title} -> {exc}")

    print(f"\nDone. Converted {ok}, failed {failed}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
