# File: backend/scripts/verify_engagement.py
# Purpose: READ-ONLY verification that stored engagement_logs classifications
#          match a FRESH compute_classification() run against the two-tower model
#          currently on disk (ml/models/best_two_tower_model.keras).
#
#          Comprehension labels are validated against the rule-based
#          comprehension_from_scores (production source of truth, derived from the
#          student's real quiz/assignment scores), not the model head.
#
# Run from the project root with the venv active:
#   python backend/scripts/verify_engagement.py          # writes verify_output.txt
#   python backend/scripts/verify_engagement.py --no-file
#
# Exit code 0 if every classified row matches, 1 otherwise.

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import get_admin_client, with_retry  # noqa: E402
from app.services.engagement_features import compute_classification  # noqa: E402
from app.services.engagement_analyzer import get_analyzer, MODEL_PATH  # noqa: E402

FIELDS = [
    "engagement_class",
    "engagement_label",
    "comprehension_class",
    "comprehension_label",
    "low_confidence",
]


def collect_pairs(admin):
    query = (
        admin.table("engagement_logs")
        .select("student_id, course_id")
        .not_.is_("engagement_class", "null")
    )
    resp = query.limit(5000).execute()
    pairs = set()
    for row in resp.data or []:
        sid, cid = row.get("student_id"), row.get("course_id")
        if sid and cid:
            pairs.add((sid, cid))
    return sorted(pairs)


def stored_rows(admin):
    resp = with_retry(
        lambda c: c.table("engagement_logs")
        .select(
            "student_id, course_id, created_at, engagement_class, engagement_label,"
            " comprehension_class, comprehension_label, low_confidence,"
            " engagement_probabilities, comprehension_probabilities"
        )
        .not_.is_("engagement_class", "null")
        .limit(5000)
        .execute()
    )
    grouped = {}
    for row in resp.data or []:
        key = (row.get("student_id"), row.get("course_id"))
        grouped.setdefault(key, []).append(row)
    return grouped


def _probs(v):
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except Exception:
            return None
    if not v:
        return None
    return [round(float(x), 3) for x in v]


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify stored engagement classifications vs a fresh run.")
    parser.add_argument("--no-file", action="store_true", help="Do not write verify_output.txt")
    args = parser.parse_args()

    admin = get_admin_client()
    engine = get_analyzer()
    output_names = [o.name for o in engine.model.outputs]

    pairs = collect_pairs(admin)
    stored = stored_rows(admin)

    out = []
    out.append("=" * 78)
    out.append("Engagement + comprehension verification vs fresh compute (read-only)")
    out.append("Model      : %s" % MODEL_PATH)
    out.append("Model out  : %s" % output_names)
    out.append("Pairs      : %d" % len(pairs))
    out.append("=" * 78)

    total_rows = 0
    ok_pairs = 0
    diff_pairs = 0
    report_lines = []

    for sid, cid in pairs:
        rows = stored.get((sid, cid)) or []
        rep = max(rows, key=lambda r: r.get("created_at") or "", default={})
        n_rows = len(rows)
        total_rows += n_rows

        result, record = compute_classification(admin, sid, cid)

        diffs = []
        for f in FIELDS:
            if rep.get(f) != record.get(f):
                diffs.append((f, rep.get(f), record.get(f)))

        sp_e, cp_e = _probs(rep.get("engagement_probabilities")), _probs(rep.get("comprehension_probabilities"))
        rp_e, rp_c = _probs(record.get("engagement_probabilities")), _probs(record.get("comprehension_probabilities"))
        if sp_e != rp_e:
            diffs.append(("engagement_probabilities", sp_e, rp_e))
        if cp_e != rp_c:
            diffs.append(("comprehension_probabilities", cp_e, rp_c))

        ok = not diffs
        ok_pairs += ok
        diff_pairs += (not ok)

        status = "PASS" if ok else "DIFF"
        comp_src = "rule" if result["comprehension_class"] is not None else "rule(none)"
        report_lines.append(
            "[%s] %s / %s  (%d row(s))\n"
            "      stored  eng=%-15s comp=%-22s conf=%s\n"
            "      fresh   eng=%-15s comp=%-22s conf=%s\n"
            "      comprehension source: %s"
            % (
                status, sid, cid, n_rows,
                rep.get("engagement_label"), rep.get("comprehension_label"), rep.get("low_confidence"),
                record.get("engagement_label"), record.get("comprehension_label"), record.get("low_confidence"),
                comp_src,
            )
        )
        for label, sv, cv in diffs:
            report_lines.append("      ! %-28s stored=%s  fresh=%s" % (label, sv, cv))
        out.append("")

    out.extend(report_lines)
    out.append("")
    out.append("=" * 78)
    out.append("SUMMARY: pairs=%d  PASS=%d  DIFF=%d  classified_rows=%d"
               % (len(pairs), ok_pairs, diff_pairs, total_rows))
    out.append("%s" % ("ALL MATCH - stored classifications consistent with the new model."
                       if diff_pairs == 0 else
                       "MISMATCH FOUND - run: python backend/scripts/backfill_engagement.py --force"))
    out.append("=" * 78)

    text = "\n".join(out)
    print(text)

    if not args.no_file:
        dest = Path(__file__).resolve().parent / "verify_output.txt"
        dest.write_text(text + "\n", encoding="utf-8")
        print("\nwrote %s" % dest)

    return 1 if diff_pairs else 0


if __name__ == "__main__":
    raise SystemExit(main())