# File: backend/app/services/engagement_analyzer.py
# Purpose: Two-Tower Neural Network inference service.
#
# CONFIRMED ARCHITECTURE (from model config.json):
#   Input  1 → "student_features"    shape=(None, 9)  — Student Tower
#   Input  2 → "interaction_features" shape=(None, 6) — Interaction Tower
#   Hidden:  Dense(64,relu) → BN → Dense(32,relu)  [per tower]
#             Concatenate → Dense(32,relu) → Dropout
#   Output 1 → "engagement"    Dense(3, softmax)  — 0=At-Risk,1=Moderate,2=Highly Engaged
#   Output 2 → "comprehension" Dense(3, softmax)  — 0=Low,1=Moderate,2=Good
#
# STUDENT TOWER — 9 features (UCI Student Performance Dataset mapping):
#   age, sex (M=1/F=0), address (U=1/R=0), famsize (GT3=1/LE3=0),
#   Pstatus (T=1/A=0), Medu (0-4), Fedu (0-4), traveltime (1-4), studytime (1-4)
#
# INTERACTION TOWER — 6 features:
#   failures (0-4), absences, G1 (0-20), G2 (0-20), G3 (0-20), freetime (1-5)

import os
import numpy as np

from app.core.config import settings

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)
))))  # FYP root
MODEL_PATH = os.path.join(BASE_DIR, "ml", "models", "student_engagement_model.keras")

# ── Feature ordering (MUST match Colab training order exactly) ────────────────
STUDENT_FEATURES     = ["age", "sex", "address", "famsize",
                         "Pstatus", "Medu", "Fedu", "traveltime", "studytime"]  # 9

INTERACTION_FEATURES = ["failures", "absences", "G1", "G2", "G3", "freetime"]   # 6

# ── Class label maps ──────────────────────────────────────────────────────────
ENGAGEMENT_LABELS = {
    0: "At-Risk with Low Comprehension",
    1: "Moderately Engaged",
    2: "Highly Engaged with Good Comprehension",
}
COMPREHENSION_LABELS = {
    0: "Low Comprehension",
    1: "Moderate Comprehension",
    2: "Good Comprehension",
}


class TwoTowerAnalyzer:
    """
    Loads the pre-trained Two-Tower Keras model and runs real-time
    engagement + comprehension classification.
    Falls back to a heuristic rule engine if TensorFlow is unavailable.
    """

    def __init__(self):
        self.model      = None
        self._tf_loaded = False
        if settings.ENGAGEMENT_ML_ENABLED:
            self._load()
        else:
            print("[TwoTower] TensorFlow disabled by config - heuristic fallback active.")

    # ── Initialisation ────────────────────────────────────────────────────────

    def _load(self):
        try:
            # Silence TensorFlow's startup noise (CPU feature INFO, oneDNN,
            # GPU warning) before the import happens.
            os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
            os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
            try:
                import absl.logging as _absl_logging
                _absl_logging.set_verbosity(_absl_logging.ERROR)
            except Exception:
                pass
            import logging as _logging
            import tensorflow as tf
            _logging.getLogger("tensorflow").setLevel(_logging.ERROR)
            self._tf_loaded = True
            if not os.path.exists(MODEL_PATH):
                print(f"[TwoTower] WARN  Model not found: {MODEL_PATH}")
                return
            self.model = tf.keras.models.load_model(MODEL_PATH)
            print(f"[TwoTower] OK Model loaded  ({MODEL_PATH})")
            print(f"[TwoTower]   Student Tower   -> input shape {self.model.input[0].shape}")
            print(f"[TwoTower]   Interaction Tower -> input shape {self.model.input[1].shape}")
            print(f"[TwoTower]   Outputs: {[o.name for o in self.model.outputs]}")
        except ImportError:
            print("[TwoTower] WARN  TensorFlow not installed - heuristic fallback active.")
        except Exception as exc:
            print(f"[TwoTower] WARN  Load error: {exc} - heuristic fallback active.")

    # ── Public API ────────────────────────────────────────────────────────────

    def classify(self, student: dict, interaction: dict) -> dict:
        """
        Parameters
        ----------
        student     : dict  — 9 demographic keys (see STUDENT_FEATURES)
        interaction : dict  — 6 behavioural keys  (see INTERACTION_FEATURES)

        Returns
        -------
        dict with:
          engagement_class / engagement_label
          comprehension_class / comprehension_label
          engagement_probabilities / comprehension_probabilities  (list[float])
          fallback (bool)
        """
        if self.model is None:
            return self._heuristic(student, interaction)

        try:
            s_in = self._vec(student,     STUDENT_FEATURES)      # (1, 9)
            i_in = self._vec(interaction, INTERACTION_FEATURES)  # (1, 6)

            # The model accepts inputs by name: {"student_features": ..., "interaction_features": ...}
            preds = self.model.predict(
                {"student_features": s_in, "interaction_features": i_in},
                verbose=0
            )

            # preds is a dict keyed by output layer name when using named inputs
            if isinstance(preds, dict):
                eng_probs  = preds["engagement"][0].tolist()
                comp_probs = preds["comprehension"][0].tolist()
            elif isinstance(preds, (list, tuple)) and len(preds) >= 2:
                eng_probs  = preds[0][0].tolist()
                comp_probs = preds[1][0].tolist()
            else:
                eng_probs = comp_probs = preds[0].tolist()

            return self._format(eng_probs, comp_probs, fallback=False)

        except Exception as exc:
            print(f"[TwoTower] WARN  Inference error: {exc}  - heuristic fallback.")
            return self._heuristic(student, interaction)

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _vec(data: dict, keys: list) -> "np.ndarray":
        return np.array([[float(data.get(k, 0.0)) for k in keys]], dtype=np.float32)

    @staticmethod
    def _format(eng_probs: list, comp_probs: list, fallback: bool) -> dict:
        ec = int(np.argmax(eng_probs))
        cc = int(np.argmax(comp_probs))
        return {
            "engagement_class":              ec,
            "engagement_label":              ENGAGEMENT_LABELS[ec],
            "comprehension_class":           cc,
            "comprehension_label":           COMPREHENSION_LABELS[cc],
            "engagement_probabilities":      [round(p, 4) for p in eng_probs],
            "comprehension_probabilities":   [round(p, 4) for p in comp_probs],
            "fallback": fallback,
        }

    def _heuristic(self, student: dict, interaction: dict) -> dict:
        """Simple grade-based rule engine used when TensorFlow is unavailable."""
        g_avg = (float(interaction.get("G1", 10)) +
                 float(interaction.get("G2", 10)) +
                 float(interaction.get("G3", 10))) / 3.0
        absence  = float(interaction.get("absences", 5))
        failures = float(interaction.get("failures", 0))
        study    = float(student.get("studytime", 2))

        score = g_avg * 1.0 - absence * 0.4 - failures * 3.0 + study * 1.0

        if score < 9:
            ec, cc = 0, 0
        elif score < 15:
            ec, cc = 1, 1
        else:
            ec, cc = 2, 2

        fake_probs = [
            [0.70, 0.20, 0.10],
            [0.15, 0.70, 0.15],
            [0.10, 0.20, 0.70],
        ]
        return self._format(fake_probs[ec], fake_probs[cc], fallback=True)

    @property
    def is_ready(self) -> bool:
        return self.model is not None


# Singleton created lazily so importing this module never loads TensorFlow.
# TensorFlow is only imported on the first classification request, and only if
# ENGAGEMENT_ML_ENABLED is True (keeps 512 MB Render instances alive).
_analyzer = None


def get_analyzer() -> "TwoTowerAnalyzer":
    global _analyzer
    if _analyzer is None:
        _analyzer = TwoTowerAnalyzer()
    return _analyzer
