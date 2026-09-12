# File: backend/app/services/engagement_analyzer.py
# Purpose: Two-Tower Neural Network inference service.
#
# CONFIRMED ARCHITECTURE (from model config.json):
#   Input  1 → "student_input"       shape=(None, 5)  — Student Tower
#   Input  2 → "interaction_input"   shape=(None, 7)  — Interaction Tower
#   Hidden:  Dense(64,relu) → BN → Dense(32,relu)  [per tower]
#             Concatenate → Dense(32,relu) → Dropout
#   Output 1 → "engagement_output"    Dense(3, softmax) — 0=At-Risk,1=Moderate,2=Highly Engaged
#   Output 2 → "comprehension_output" Dense(3, softmax) — 0=Low,1=Moderate,2=Good
#
# Model trained on OULAD (Open University Learning Analytics Dataset) features.
# Inference contract below MUST match ml/models/oulad_feature_contract.json.
#
# STUDENT TOWER — 5 features (raw, NOT standardized):
#   gender (F=0/M=1), age_band (0-35=0,35-55=1,55+=2),
#   highest_education (NoFormal=0,LowerA=1,ALevel=2,Higher=3),
#   imd_band (0-9), disability (0/1)
#
# INTERACTION TOWER — 7 features (STANDARDIZED by oulad_preprocessor.json):
#   total_activities, unique_materials, active_days, avg_daily_activity,
#   activity_per_registered_day, days_since_last_activity, assessment_count

import os
import json
import numpy as np

from app.core.config import settings

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)
))))  # FYP root
MODEL_PATH = os.path.join(BASE_DIR, "ml", "models", "best_two_tower_model.keras")
PREPROCESSOR_PATH = os.path.join(BASE_DIR, "ml", "models", "oulad_preprocessor.json")

# ── Feature ordering (MUST match the OULAD training order) ───────────────────
STUDENT_FEATURES = ["gender", "age_band", "highest_education", "imd_band", "disability"]  # 5

INTERACTION_FEATURES = [
    "total_activities",
    "unique_materials",
    "active_days",
    "avg_daily_activity",
    "activity_per_registered_day",
    "days_since_last_activity",
    "assessment_count",
]  # 7

# ── Class label maps ──────────────────────────────────────────────────────────
ENGAGEMENT_LABELS = {
    0: "At-Risk",
    1: "Moderate",
    2: "Highly Engaged",
}
COMPREHENSION_LABELS = {
    0: "Low Comprehension",
    1: "Moderate Comprehension",
    2: "Good Comprehension",
}


class TwoTowerAnalyzer:
    """
    Loads the pre-trained OULAD Two-Tower Keras model and runs real-time
    engagement + comprehension classification.
    Interaction features are standardized with the scaler serialized alongside
    the model (oulad_preprocessor.json). Falls back to a heuristic rule engine
    if TensorFlow is unavailable.
    """

    def __init__(self):
        self.model      = None
        self._tf_loaded = False
        self._prep      = None
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
            self._load_preprocessor()
        except ImportError:
            print("[TwoTower] WARN  TensorFlow not installed - heuristic fallback active.")
        except Exception as exc:
            print(f"[TwoTower] WARN  Load error: {exc} - heuristic fallback active.")

    def _load_preprocessor(self):
        """Load the per-feature mean/std used to standardize interaction inputs.

        Student features are fed to the model raw. When the preprocessor is
        missing the model still runs (with unscaled inputs) but predictions are
        unreliable, so a clear warning is printed.
        """
        self._prep = {"mean": {}, "scale": {}}
        if not os.path.exists(PREPROCESSOR_PATH):
            print(f"[TwoTower] WARN  Preprocessor not found: {PREPROCESSOR_PATH} "
                  "- interaction features will NOT be standardized.")
            return
        try:
            with open(PREPROCESSOR_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            names = data.get("feature_names", [])
            means = data.get("mean", [])
            scales = data.get("scale", [])
            for name, m, s in zip(names, means, scales):
                self._prep["mean"][name] = float(m)
                self._prep["scale"][name] = float(s) if float(s) != 0 else 1.0
            print(f"[TwoTower] OK Preprocessor loaded  ({PREPROCESSOR_PATH}) "
                  f"[{len(names)} interaction features]")
        except Exception as exc:
            self._prep = None
            print(f"[TwoTower] WARN  Preprocessor load error: {exc}")

    # ── Public API ────────────────────────────────────────────────────────────

    def classify(self, student: dict, interaction: dict) -> dict:
        """
        Parameters
        ----------
        student     : dict  — 5 demographic keys (see STUDENT_FEATURES)
        interaction : dict  — 7 behavioural keys  (see INTERACTION_FEATURES)

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
            s_in = self._vec(student,     STUDENT_FEATURES)        # (1, 5)  raw
            i_in = self._standardize(self._vec(interaction, INTERACTION_FEATURES))  # (1, 7)

            # Predict positionally: model.inputs order is fixed at
            # [student_input, interaction_input]; outputs order is
            # [engagement_output, comprehension_output].
            preds = self.model.predict([s_in, i_in], verbose=0)

            if isinstance(preds, dict):
                eng_probs  = preds["engagement_output"][0].tolist()
                comp_probs = preds["comprehension_output"][0].tolist()
            elif isinstance(preds, (list, tuple)):
                eng_probs  = np.asarray(preds[0])[0].tolist()
                comp_probs = np.asarray(preds[1])[0].tolist()
            else:
                eng_probs = comp_probs = np.asarray(preds)[0].tolist()

            return self._format(eng_probs, comp_probs, fallback=False)

        except Exception as exc:
            print(f"[TwoTower] WARN  Inference error: {exc}  - heuristic fallback.")
            return self._heuristic(student, interaction)

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _vec(data: dict, keys: list) -> "np.ndarray":
        return np.array([[float(data.get(k, 0.0)) for k in keys]], dtype=np.float32)

    def _standardize(self, row: "np.ndarray") -> "np.ndarray":
        """Apply (x - mean) / scale to the 7 interaction features in order."""
        if self._prep is None or not self._prep["mean"]:
            return row
        out = row.copy()
        for i, name in enumerate(INTERACTION_FEATURES):
            mean = self._prep["mean"].get(name)
            scale = self._prep["scale"].get(name)
            if mean is None or scale is None:
                continue
            out[0, i] = (out[0, i] - mean) / scale
        return out

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
        """Simple behavioural rule engine used when TensorFlow is unavailable."""
        acts   = float(interaction.get("total_activities", 0))
        uniq   = float(interaction.get("unique_materials", 0))
        avg    = float(interaction.get("avg_daily_activity", 0))
        recent = float(interaction.get("days_since_last_activity", 30))
        cnt    = float(interaction.get("assessment_count", 0))

        score = acts + uniq * 2.0 + avg * 3.0 + cnt * 2.0 - recent * 0.5

        if score < 30 or (acts == 0 and cnt == 0 and recent > 30):
            ec, cc = 0, 0
        elif score < 60:
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