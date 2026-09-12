# File: ml/src/generate_training_report.py
# Purpose: Builds the FYP report's model section from the REAL OULAD training
#          artifacts produced by the Colab notebooks (ml/notebooks/):
#            - ml/models/model_evaluation_results.json  (holdout metrics)
#            - ml/models/training_history.png           (real learning curves)
#          It does NOT synthesize curves. Run from any directory.
#
# Run:
#   .\venv\Scripts\python.exe ml/src/generate_training_report.py

import json
import os
import shutil
import sys

BASE = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "models"))

METRICS_JSON  = os.path.join(BASE, "model_evaluation_results.json")
CURVES_PNG    = os.path.join(BASE, "training_history.png")
OUT_CURVES    = os.path.join(BASE, "training_curves.png")


def main():
    report_lines = []
    print("=" * 62)
    print("OULAD TWO-TOWER MODEL  -  REAL EVALUATION REPORT")
    print("=" * 62)

    # ── Metrics ───────────────────────────────────────────────────────────────
    if not os.path.exists(METRICS_JSON):
        print(f"[WARN] metrics not found: {METRICS_JSON}")
        print("Run the Colab notebook 02_train_oulad.ipynb and export "
              "model_evaluation_results.json into ml/models/.")
        sys.exit(1)

    with open(METRICS_JSON, "r", encoding="utf-8") as fh:
        metrics = json.load(fh)

    rows = [
        ("Engagement    accuracy", metrics.get("engagement_accuracy")),
        ("Engagement    macro-F1", metrics.get("engagement_f1_macro")),
        ("Comprehension accuracy", metrics.get("comprehension_accuracy")),
        ("Comprehension macro-F1", metrics.get("comprehension_f1_macro")),
    ]
    print(f"\nHoldout set: 2014J (newest module-presentation, temporal split)")
    print(f"{'metric':<26} {'value':>8}")
    print("-" * 38)
    for label, value in rows:
        if value is None:
            print(f"{label:<26} {'missing':>8}")
            continue
        print(f"{label:<26} {float(value):>8.4f}")
        report_lines.append(f"{label}: {float(value):.4f}")

    # ── Learning curves ───────────────────────────────────────────────────────
    print("\nLearning curves:")
    if os.path.exists(CURVES_PNG):
        shutil.copyfile(CURVES_PNG, OUT_CURVES)
        print(f"  [OK] real curves copied to   {OUT_CURVES}")
        report_lines.append(f"curves: {OUT_CURVES}")
    else:
        print(f"  [WARN] real curves not found: {CURVES_PNG}")

    # ── Report note ───────────────────────────────────────────────────────────
    print("\nNOTE: macro-F1 < accuracy reflects class imbalance (the At-Risk /")
    print("Withdrawn-Fail class is the majority). Both figures are reported so")
    print("the numbers are not cherry-picked. Dataset: OULAD (CC BY 4.0);")
    print("citation: Kuzilek, Hlosta & Zdrahal (2017), Sci. Data 4:170171.")

    report_path = os.path.join(BASE, "training_report.txt")
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(report_lines))
    print(f"\n[SUCCESS] report written to {report_path}")


if __name__ == "__main__":
    main()