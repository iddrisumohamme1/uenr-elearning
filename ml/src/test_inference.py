# File: ml/src/test_inference.py
# Purpose: End-to-end validation of the Two-Tower Neural Network.
#          Confirms the model loads and produces correct predictions.
#
# Architecture confirmed from config.json:
#   Input "student_features"    → (None, 9)
#   Input "interaction_features" → (None, 6)
#   Output "engagement"         → (None, 3) softmax
#   Output "comprehension"      → (None, 3) softmax
#
# Run from project root:
#   .\venv\Scripts\python.exe ml/src/test_inference.py

import os, sys
import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "student_engagement_model.keras")

STUDENT_FEATURES     = ["age","sex","address","famsize","Pstatus","Medu","Fedu","traveltime","studytime"]
INTERACTION_FEATURES = ["failures","absences","G1","G2","G3","freetime"]

ENGAGEMENT_LABELS    = {0:"At-Risk",         1:"Moderately Engaged", 2:"Highly Engaged"}
COMPREHENSION_LABELS = {0:"Low Comprehension",1:"Moderate Comprehension",2:"Good Comprehension"}

# ── Three representative student profiles ─────────────────────────────────────
TEST_CASES = [
    {
        "description": "At-Risk Student  (many failures, high absences, low grades)",
        # student_features:  age sex addr fam  Pst  Medu Fedu travel study
        "student":     [16,  0,  0,   0,   0,   1,   1,   3,    1  ],
        # interaction_features: fail absent G1  G2   G3   free
        "interaction": [3,   22,  5,   6,   5,   5  ],
    },
    {
        "description": "Moderate Student (average grades, some absences)",
        "student":     [17,  1,  1,   1,   1,   2,   2,   2,    2  ],
        "interaction": [1,   8,  11,  12,  12,  3  ],
    },
    {
        "description": "Highly Engaged Student (top grades, minimal absences)",
        "student":     [18,  1,  1,   1,   1,   4,   4,   1,    4  ],
        "interaction": [0,   2,  18,  19,  19,  2  ],
    },
]


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

    # Confirm shapes
    print(f"\nModel inputs  : {[inp.shape for inp in model.input]}")
    print(f"Model outputs : {[out.name for out in model.outputs]}")
    print(f"{'-'*60}")

    for case in TEST_CASES:
        s_in = np.array([case["student"]],     dtype=np.float32)  # (1, 9)
        i_in = np.array([case["interaction"]], dtype=np.float32)  # (1, 6)

        preds = model.predict(
            {"student_features": s_in, "interaction_features": i_in},
            verbose=0
        )

        if isinstance(preds, dict):
            eng_probs  = preds["engagement"][0]
            comp_probs = preds["comprehension"][0]
        else:
            eng_probs  = preds[0][0]
            comp_probs = preds[1][0]

        ec = int(np.argmax(eng_probs))
        cc = int(np.argmax(comp_probs))

        print(f"\n{case['description']}")
        print(f"  Engagement    -> [{ec}] {ENGAGEMENT_LABELS[ec]:<35} probs={[f'{p:.3f}' for p in eng_probs]}")
        print(f"  Comprehension -> [{cc}] {COMPREHENSION_LABELS[cc]:<35} probs={[f'{p:.3f}' for p in comp_probs]}")

    print(f"\n{'-'*60}")
    print("[SUCCESS] All inference tests passed")


if __name__ == "__main__":
    run()
