# File: backend/scripts/backfill_engagement.py
# Purpose: Reconciles HISTORICAL engagement_logs with the new OULAD Two-Tower
#          model. Rows recorded before the model replacement were classified by
#          the old 9+6 UCI model and store no values in the new OULAD feature
#          columns (they default to 0). This script recomputes the 7 OULAD
#          interaction features from real platform telemetry, runs the new
#          model, and OVERWRITES those old classification rows in place so the
#          whole history now follows the new engagement + comprehension model.
#
# Run from the project root with the venv active:
#   python backend/scripts/backfill_engagement.py            # all (student, course) pairs
#   python backend/scripts/backfill_engagement.py --dry-run  # show plan, change nothing
#   python backend/scripts/backfill_engagement.py --limit 5
#   python backend/scripts/backfill_engagement.py --student <id>
#   python backend/scripts/backfill_engagement.py --course  <id>
#   python backend/scripts/backfill_engagement.py --force   # reclassify ALL rows
#                                                           # (not just untouched ones)
#
# Prerequisite: supabase/migrations/20260912000000_engagement_logs_oulad_columns.sql
# must be applied, otherwise the new feature columns do not exist.

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import get_admin_client, with_retry  # noqa: E402
from app.services.engagement_features import compute_classification  # noqa: E402

# New-model feature columns written to old rows during the backfill.
OULAD_FEATURE_COLS = [
    "total_activities",
    "unique_materials",
    "active_days",
    "avg_daily_activity",
    "activity_per_registered_day",
    "days_since_last_activity",
    "assessment_count",
]


def collect_pairs(admin, student_id=None, course_id=None):
    """Distinct (student_id, course_id) pairs that hold a classification row."""
    query = (
        admin.table("engagement_logs")
        .select("student_id, course_id")
        .not_.is_("engagement_class", "null")
    )
    if student_id:
        query = query.eq("student_id", student_id)
    if course_id:
        query = query.eq("course_id", course_id)
    resp = query.limit(5000).execute()
    pairs = set()
    for row in resp.data or []:
        sid, cid = row.get("student_id"), row.get("course_id")
        if sid and cid:
            pairs.add((sid, cid))
    return sorted(pairs)


def old_classification_rows(admin, student_id, course_id, force=False):
    """ids of classification rows for this pair eligible for reclassification.

    Without ``force``, only rows whose OULAD feature columns are still at the
    schema default (total_activities == 0) are returned - the original
    idempotency guard that prevents clobbering rows already reconciled with the
    new model. With ``force``, ALL classified rows are returned so the whole
    history can be recalculated (useful when the classification logic changes,
    e.g. when platform-aware calibration was introduced).
    """
    resp = with_retry(
        lambda c: c.table("engagement_logs")
        .select("id, total_activities")
        .eq("student_id", student_id)
        .eq("course_id", course_id)
        .not_.is_("engagement_class", "null")
        .limit(5000)
        .execute()
    )
    ids = []
    for row in resp.data or []:
        ta = row.get("total_activities")
        if force or ta is None or float(ta or 0) == 0:
            ids.append(row["id"])
    return ids


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reclassify historical engagement_logs with the new OULAD Two-Tower model."
    )
    parser.add_argument("--dry-run", action="store_true", help="Show the plan without writing.")
    parser.add_argument("--limit", type=int, default=0, help="Max (student, course) pairs to process (0 = all).")
    parser.add_argument("--student", type=str, default="", help="Only this student id.")
    parser.add_argument("--course", type=str, default="", help="Only this course id.")
    parser.add_argument("--force", action="store_true", help="Reclassify ALL classified rows, not just untouched ones.")
    args = parser.parse_args()

    admin = get_admin_client()
    pairs = collect_pairs(admin, student_id=args.student or None, course_id=args.course or None)
    print(f"{len(pairs)} (student, course) pair(s) with classification rows.")

    if args.limit > 0:
        pairs = pairs[: args.limit]

    ok = skipped = failed = updated_rows = 0
    for sid, cid in pairs:
        old_ids = old_classification_rows(admin, sid, cid, force=args.force)
        if not old_ids:
            skipped += 1
            print(f"  [skip] {sid} / {cid}   (no rows to reclassify)")
            continue

        try:
            result, record = compute_classification(admin, sid, cid)
        except Exception as exc:
            failed += 1
            print(f"  [FAIL] {sid} / {cid} -> {exc}")
            continue

        payload = {k: record[k] for k in OULAD_FEATURE_COLS}
        payload.update(
            {
                "engagement_class": record["engagement_class"],
                "engagement_label": record["engagement_label"],
                "comprehension_class": record["comprehension_class"],
                "comprehension_label": record["comprehension_label"],
                "low_confidence": record["low_confidence"],
                "engagement_probabilities": record["engagement_probabilities"],
                "comprehension_probabilities": record["comprehension_probabilities"],
            }
        )

        label = (
            f"eng={result['engagement_label']} "
            f"comp={result['comprehension_label']} "
            f"(low_confidence={record['low_confidence']})"
        )
        if args.dry_run:
            print(f"  [dry-run] {sid} / {cid}  {len(old_ids)} old row(s) -> {label}")
            continue

        try:
            admin.table("engagement_logs").update(payload).in_(
                "id", old_ids
            ).execute()
            updated_rows += len(old_ids)
            ok += 1
            print(f"  [ok]  {sid} / {cid}  updated {len(old_ids)} row(s) -> {label}")
        except Exception as exc:
            failed += 1
            print(f"  [FAIL] {sid} / {cid} DB update -> {exc}")

    print(
        f"\nDone. Pairs: ok={ok}, skipped={skipped}, failed={failed}, "
        f"rows_updated={updated_rows}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())