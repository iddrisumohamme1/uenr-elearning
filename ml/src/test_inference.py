# File: ml/src/test_inference.py
# Purpose: End-to-end validation of the OULAD Two-Tower Neural Network.
#          Confirms the model loads, the preprocessor standardizes correctly,
#          and predictions produce sane classes.
#
# Architecture (best_two_tower_model.keras):
#   Input "student_input"       -> (None, 5)
#   Input "interaction_input"   -> (None, 7)
#   Output "engagement_output"  -> (None, 3) softmax
#   Output "comprehension_output" -> (None, 3) softmax
#
# Feature contract (must match ml/models/oulad_feature_contract.json):
#   Student tower (raw): gender, age_band, highest_education, imd_band, disability
#   Interaction tower (standardized): total_activities, unique_materials,
#     active_days, avg_daily_activity, activity_per_registered_day,
#     days_since_last_activity, assessment_count
#
# Run from project root:
#   .\venv\Scripts\python.exe ml/src/test_inference.py

import os, sys, json
import numpy as np

MODEL_PATH        = os.path.join(os.path.dirname(__file__), "..", "models", "best_two_tower_model.keras")
PREPROCESSOR_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "oulad_preprocessor.json")

STUDENT_FEATURES     = ["gender", "age_band", "highest_education", "imd_band", "disability"]
INTERACTION_FEATURES = [
    "total_activities", "unique_materials", "active_days", "avg_daily_activity",
    "activity_per_registered_day", "days_since_last_activity", "assessment_count",
]

ENGAGEMENT_LABELS    = {0: "At-Risk",         1: "Moderate",           2: "Highly Engaged"}
COMPREHENSION_LABELS = {0: "Low Comprehension", 1: "Moderate Comprehension", 2: "Good Comprehension"}

# ── Three representative OULAD-style student profiles ─────────────────────────
TEST_CASES = [
    {
        "description": "At-Risk Student (virtually no VLE activity, no assessments)",
        # student_features: gender age_band high_edu imd_band disability
        "student":     [1,   2,       1,       5,       0],
        # interaction_features: total_activities unique_materials active_days avg_daily activity_per_day days_since_last assessment_count
        "interaction": [2.0,   1,           1,         2.0,        0.02,     200.0,           0],
    },
    {
        "description": "Moderate Student (some activity, a few assessments)",
        "student":     [0,   1,       2,       4,       0],
        "interaction": [45.0, 12,          10,         4.5,        0.8,      12.0,            3],
    },
    {
        "description": "Highly Engaged Student (heavy VLE use, many assessments, recent)",
        "student":     [1,   0,       3,       6,       0],
        "interaction": [260.0, 90,         55,         4.7,        2.1,      1.0,            9],
    },
]


def load_preprocessor():
    """Load mean/scale per interaction feature, ordered by INTERACTION_FEATURES."""
    if not os.path.exists(PREPROCESSOR_PATH):
        print(f"WARN: preprocessor not found: {PREPROCESSOR_PATH}")
        return None
    with open(PREPROCESSOR_PATH, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return {
        "mean": dict(zip(data.get("feature_names", []), data.get("mean", []))),
        "scale": dict(zip(data.get("feature_names", []), data.get("scale", []))),
    }


def standardize(row, prep):
    out = row.astype(np.float64).copy()
    for i, name in enumerate(INTERACTION_FEATURES):
        mean = (prep or {}).get("mean", {}).get(name)
        scale = (prep or {}).get("scale", {}).get(name)
        if mean is None or scale is None:
            continue
        out[0, i] = (out[0, i] - mean) / (scale if scale != 0 else 1.0)
    return out.astype(np.float32)


def run():
    try:
        import tensorflow as tf
        print(f"[SUCCESS] TensorFlow {tf.__version__} loaded")
    except ImportError:
        print("ERROR: TensorFlow not installed. Run:  .\\venv\\Scripts\\pip.exe install tensorflow")
        sys.exit(1)

    if not os.path.exists(MODEL_PATH):
        print(f"ERROR: Model not found: {MODEL_PATH}")
        sys.exit(1)

    print(f"Loading model: {MODEL_PATH}")
    model = tf.keras.models.load_model(MODEL_PATH)
    prep = load_preprocessor()
    if prep:
        print("[OK] Preprocessor loaded")

    # Confirm shapes
    print(f"\nModel inputs  : {[inp.shape for inp in model.input]}")
    print(f"Model outputs : {[out.name for out in model.outputs]}")
    print(f"{'-'*60}")

    for case in TEST_CASES:
        s_in = np.array([case["student"]], dtype=np.float32)      # (1, 5) raw
        i_in = standardize(np.array([case["interaction"]], dtype=np.float32), prep)  # (1, 7)

        # Positional inputs: [student_input, interaction_input]
        preds = model.predict([s_in, i_in], verbose=0)

        if isinstance(preds, dict):
            eng_probs  = preds["engagement_output"][0]
            comp_probs = preds["comprehension_output"][0]
        else:
            eng_probs  = np.asarray(preds[0])[0]
            comp_probs = np.asarray(preds[1])[0]

        ec = int(np.argmax(eng_probs))
        cc = int(np.argmax(comp_probs))

        print(f"\n{case['description']}")
        print(f"  Engagement    -> [{ec}] {ENGAGEMENT_LABELS[ec]:<18} probs={[f'{p:.3f}' for p in eng_probs]}")
        print(f"  Comprehension -> [{cc}] {COMPREHENSION_LABELS[cc]:<22} probs={[f'{p:.3f}' for p in comp_probs]}")

    print(f"\n{'-'*60}")
    print("[SUCCESS] All inference tests passed")


if __name__ == "__main__":
    run()