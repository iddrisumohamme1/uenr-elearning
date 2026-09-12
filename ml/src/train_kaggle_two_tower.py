"""Fine-tune the Two-Tower engagement/comprehension model on the Kaggle
student-learning-interaction-logs-dataset (local run).

Research-grounded correction pass (2026-09-13):
  - comprehension label mirrors PRODUCTION semantics: the MOST RECENT scored
    quiz (>=80 Good / >=50 Moderate / else Low), as `comprehension_from_scores`
    - class-balanced (effective-number-of-samples, Cui et al.) weights folded into
    a focal loss (gamma=1.5) applied to the comprehension head only
  - small ordinal penalty (adjacent mislabels cost less than skip errors)
  - task-specific comprehension branch (own Dense(16)) off the shared trunk so
    the comprehension head no longer competes with the engagement head
  - adjacent-vs-skip error statistics reported for honest evaluation

Leakage guard preserved: quiz/assessment-derived signals stay OUT of X; only
the target label changes. Input contract (5 student + 7 interaction features)
and output names are unchanged.

Produces new ml/models artifacts:
  - best_two_tower_model.keras
  - oulad_preprocessor.json   (scaler mean/scale fit on the new features)
  - oulad_feature_contract.json
  - training_report.txt
  - model_evaluation_results.json
  - training_curves.png
"""
import json
import os

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score, classification_report
import tensorflow as tf

np.random.seed(42)
tf.random.set_seed(42)

BASE = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "models"))
CSV_PATH = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data", "student_learning_interaction_dataset.csv"))

FEATURES = [
    "total_activities", "unique_materials", "active_days", "avg_daily_activity",
    "activity_per_registered_day", "days_since_last_activity", "assessment_count",
]

ENG_COLS = ["At-Risk", "Moderate", "Highly Engaged"]
COMP_COLS = ["Low Comprehension", "Moderate Comprehension", "Good Comprehension"]

MODEL_PATH = os.path.join(BASE, "best_two_tower_model.keras")
PREPROC_PATH = os.path.join(BASE, "oulad_preprocessor.json")
CONTRACT_PATH = os.path.join(BASE, "oulad_feature_contract.json")
REPORT_PATH = os.path.join(BASE, "training_report.txt")
METRICS_PATH = os.path.join(BASE, "model_evaluation_results.json")
CURVES_PATH = os.path.join(BASE, "training_curves.png")
HISTORY_PATH = os.path.join(BASE, "training_history.png")

FOCAL_GAMMA = 1.5
CB_BETA = 0.999
ORDINAL_LAMBDA = 0.1


def const_student(n):
    return np.tile(np.array([[1.0, 1.0, 1.0, 5.0, 0.0]], dtype=np.float32), (n, 1))


def minmax(s):
    lo, hi = s.min(), s.max()
    return (s - lo) / (hi - lo) if hi > lo else pd.Series(0.0, index=s.index)


def sample_weights(y):
    cls, counts = np.unique(y, return_counts=True)
    w = {int(c): float(len(y)) / (len(cls) * int(n)) for c, n in zip(cls, counts)}
    return np.array([w.get(int(v), 1.0) for v in y])


def class_balanced_weights(y, beta=CB_BETA):
    """Cui et al. (CVPR 2019) effective-number-of-samples class weights.

    w_i = (1 - beta) / (1 - beta**n_i), normalized so mean weight == 1.
    Smoother than naive inverse frequency for severe long tails.
    """
    cls, counts = np.unique(y, return_counts=True)
    n_map = {int(c): int(n) for c, n in zip(cls, counts)}
    raw = {}
    for i in range(3):
        n = n_map.get(i, 0)
        raw[i] = (1.0 - beta) / max(1.0 - beta ** n, 1e-8) if n > 0 else 0.0
    mean_w = sum(raw.values()) / 3 if raw else 1.0
    return {i: raw[i] / mean_w for i in range(3)}


def make_comp_loss(alpha, gamma=FOCAL_GAMMA, lam=ORDINAL_LAMBDA):
    """Comprehension-head loss = class-balanced focal term + ordinal penalty.

    The focal term down-weights easy examples and uses class-balanced alpha
    (so NO separate sample_weight is passed for this output). The ordinal term
    penalizes expected |pred_class - true_class| so adjacent mislabels (Low<->Moderate)
    cost less than skip errors (Low<->Good).
    """
    alpha_t = tf.constant([alpha.get(i, 1.0) for i in range(3)], dtype="float32")
    p_range = tf.constant([[0.0, 1.0, 2.0]], dtype="float32")

    def comp_loss(y_true, y_pred):
        y_pred = tf.clip_by_value(y_pred, 1e-7, 1.0 - 1e-7)
        y_true = tf.cast(y_true, tf.int32)
        y_onehot = tf.one_hot(y_true, 3)

        alpha_sel = tf.reduce_sum(y_onehot * alpha_t, axis=-1)
        pt = tf.reduce_sum(y_onehot * y_pred, axis=-1)
        focal = -alpha_sel * tf.pow(1.0 - pt, gamma) * tf.math.log(pt)

        t_f = tf.reduce_sum(y_onehot * tf.constant([0.0, 1.0, 2.0]), axis=-1)
        exp_d = tf.reduce_sum(y_pred * tf.abs(p_range - t_f[:, None]), axis=-1)

        return tf.reduce_mean(focal) + lam * tf.reduce_mean(exp_d)

    return comp_loss


def build_from_scratch():
    from tensorflow.keras import layers, Model

    def tower(inp):
        x = layers.Dense(64, activation="relu")(inp)
        x = layers.BatchNormalization()(x)
        x = layers.Dense(32, activation="relu")(x)
        return x

    student = layers.Input(shape=(5,), name="student_input")
    interaction = layers.Input(shape=(7,), name="interaction_input")
    x = layers.Concatenate()([tower(student), tower(interaction)])
    x = layers.Dense(32, activation="relu")(x)
    x = layers.Dropout(0.3)(x)
    eng = layers.Dense(3, activation="softmax", name="engagement_output")(x)
    comp = layers.Dense(16, activation="relu", name="comp_branch")(x)
    comp = layers.Dense(3, activation="softmax", name="comprehension_output")(comp)
    return Model(inputs=[student, interaction], outputs=[eng, comp])


def build_comp_branch_model(base):
    """Rebuild with a task-specific comprehension branch while keeping all
    shared-trunk + engagement weights from the loaded model. The old
    comprehension head (directly on the trunk) is discarded - it is the head
    we are retraining anyway."""
    from tensorflow.keras import layers, Model as KModel

    shared = base.get_layer("engagement_output").input
    comp = layers.Dense(16, activation="relu", name="comp_branch")(shared)
    comp = layers.Dense(3, activation="softmax", name="comprehension_output")(comp)
    return KModel(inputs=base.inputs,
                  outputs=[base.get_layer("engagement_output").output, comp])


def main():
    df = pd.read_csv(CSV_PATH)
    df["date"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values("timestamp")
    end = pd.to_datetime(df["timestamp"]).max()

    agg = df.groupby(["student_id", "module_id"]).agg(
        total_activities=("time_spent_minutes", "sum"),
        unique_materials=("pages_visited", "sum"),
        active_days=("date", lambda s: s.dt.date.nunique()),
        success_rate=("success_label", "mean"),
        attention_avg=("attention_score", "mean"),
        learning_trend=("learning_trend", "mean"),
        sessions=("session_id", "count"),
        latest_quiz=("quiz_score", "last"),
        first_ts=("timestamp", "min"),
        last_ts=("timestamp", "max"),
    ).reset_index()

    agg["avg_daily_activity"] = agg["total_activities"] / agg["active_days"].clip(lower=1)
    span = (pd.to_datetime(agg["last_ts"]) - pd.to_datetime(agg["first_ts"])).dt.days.add(1)
    agg["activity_per_registered_day"] = agg["total_activities"] / span.clip(lower=1)
    agg["days_since_last_activity"] = (end - pd.to_datetime(agg["last_ts"])).dt.days
    agg["assessment_count"] = agg["sessions"]

    composite = (0.30 * minmax(agg["total_activities"])
                 + 0.20 * agg["success_rate"]
                 + 0.20 * minmax(agg["attention_avg"])
                 + 0.15 * minmax(agg["learning_trend"]))
    q1, q2 = composite.quantile([0.40, 0.80])
    eng = np.select([composite < q1, composite > q2], [0, 2], default=1)
    agg["engagement_class"] = eng.astype(int)

    latest_q = agg["latest_quiz"].fillna(0)
    comp = np.select([latest_q >= 80, latest_q >= 50], [2, 1], default=0)
    agg["comprehension_class"] = comp.astype(int)

    X = agg[FEATURES].astype(float).values
    y_e = agg["engagement_class"].values.astype(int)
    y_c = agg["comprehension_class"].values.astype(int)

    scaler = StandardScaler()
    X_s = scaler.fit_transform(X)

    X_tr, X_te, ye_tr, ye_te, yc_tr, yc_te = train_test_split(
        X_s, y_e, y_c, test_size=0.30, random_state=42, stratify=y_e)
    X_tr, X_va, ye_tr, ye_va, yc_tr, yc_va = train_test_split(
        X_tr, ye_tr, yc_tr, test_size=0.2142, random_state=42, stratify=ye_tr)

    print("train/val/test:", len(X_tr), len(X_va), len(X_te))
    print("engagement train dist:", {ENG_COLS[i]: int((ye_tr == i).sum()) for i in range(3)})
    print("comprehension train dist:", {COMP_COLS[i]: int((yc_tr == i).sum()) for i in range(3)})

    pretrained = os.path.exists(MODEL_PATH)
    if pretrained:
        base = tf.keras.models.load_model(MODEL_PATH)
        model = build_comp_branch_model(base)
        print("Loaded deployed model -> fine-tuning (new task-specific comprehension branch)")
    else:
        model = build_from_scratch()
        print("Deployed model missing -> training from scratch (same contract)")
    model.summary()

    deployed_counts = None
    if pretrained:
        try:
            with open(PREPROC_PATH, "r", encoding="utf-8") as fh:
                dep = json.load(fh)
            X_old = (X - np.array(dep["mean"])) / np.array(dep["scale"])
            pe0, _ = model.predict([const_student(len(X)), X_old.astype(np.float32)], verbose=0)
            deployed_counts = {ENG_COLS[i]: int((pe0.argmax(1) == i).sum()) for i in range(3)}
            print("deployed model on kaggle rows (before fine-tune):", deployed_counts)
        except FileNotFoundError:
            print("old preprocessor missing - skipping before/after contrast")

    sw_e = sample_weights(ye_tr)
    alpha = class_balanced_weights(yc_tr)
    print("class-balanced weights (effective number, beta=%.3f): %s" % (CB_BETA, {i: round(w, 3) for i, w in alpha.items()}))
    comp_loss = make_comp_loss(alpha)

    model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate=1e-3),
                  loss={
                      "engagement_output": "sparse_categorical_crossentropy",
                      "comprehension_output": comp_loss,
                  },
                  metrics={"engagement_output": "accuracy", "comprehension_output": "accuracy"})

    callbacks = [
        tf.keras.callbacks.EarlyStopping(patience=15, restore_best_weights=True, monitor="val_loss"),
        tf.keras.callbacks.ReduceLROnPlateau(patience=5, factor=0.5, min_lr=1e-6),
    ]

    history = model.fit(
        [const_student(len(X_tr)), X_tr.astype(np.float32)],
        [ye_tr, yc_tr],
        validation_data=([const_student(len(X_va)), X_va.astype(np.float32)], [ye_va, yc_va]),
        sample_weight=[sw_e, np.ones(len(yc_tr))],
        epochs=120, batch_size=32, callbacks=callbacks, verbose=1)

    pe, pc = model.predict([const_student(len(X_te)), X_te.astype(np.float32)], verbose=0)
    p_e, p_c = pe.argmax(1), pc.argmax(1)

    eng_acc = float(accuracy_score(ye_te, p_e))
    eng_f1 = float(f1_score(ye_te, p_e, average="macro"))
    comp_acc = float(accuracy_score(yc_te, p_c))
    comp_f1 = float(f1_score(yc_te, p_c, average="macro"))

    diff_c = np.abs(p_c - yc_te)
    comp_adjacent = int((diff_c == 1).sum())
    comp_skip = int((diff_c == 2).sum())
    comp_errors = int((diff_c > 0).sum())

    print("\nEngagement    accuracy: %.4f   macro-F1: %.4f" % (eng_acc, eng_f1))
    print("Comprehension accuracy: %.4f   macro-F1: %.4f" % (comp_acc, comp_f1))
    print("Comprehension errors: %d total | %d adjacent | %d skip" % (comp_errors, comp_adjacent, comp_skip))
    print("\nEngagement report:\n", classification_report(ye_te, p_e, target_names=ENG_COLS, zero_division=0))
    print("Comprehension report:\n", classification_report(yc_te, p_c, target_names=COMP_COLS, zero_division=0))

    pe_all, pc_all = model.predict([const_student(len(X)), X_s.astype(np.float32)], verbose=0)
    new_counts = {ENG_COLS[i]: int((pe_all.argmax(1) == i).sum()) for i in range(3)}
    new_comp_counts = {COMP_COLS[i]: int((pc_all.argmax(1) == i).sum()) for i in range(3)}
    print("fine-tuned model distribution:", new_counts)
    print("fine-tuned comprehension distribution:", new_comp_counts)

    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    h = history.history
    axes[0].plot(h["loss"], label="train")
    axes[0].plot(h["val_loss"], label="val")
    axes[0].set_title("Loss")
    axes[0].legend()
    axes[1].plot(h.get("engagement_output_accuracy", []), label="eng acc")
    axes[1].plot(h.get("val_engagement_output_accuracy", []), label="val eng acc")
    axes[1].set_title("Engagement accuracy")
    axes[1].legend()
    fig.tight_layout()
    fig.savefig(CURVES_PATH)
    fig.savefig(HISTORY_PATH)

    prep = {
        "mean": [float(m) for m in scaler.mean_],
        "scale": [float(s) for s in scaler.scale_],
        "feature_names": FEATURES,
    }
    with open(PREPROC_PATH, "w", encoding="utf-8") as fh:
        json.dump(prep, fh, indent=4)

    contract = {
        "student_features": ["gender", "age_band", "highest_education", "imd_band", "disability"],
        "interaction_features": FEATURES,
        "targets": {"engagement": ENG_COLS, "comprehension": COMP_COLS},
    }
    with open(CONTRACT_PATH, "w", encoding="utf-8") as fh:
        json.dump(contract, fh, indent=4)

    model.compile(optimizer=tf.keras.optimizers.Adam(),
                  loss=["sparse_categorical_crossentropy", "sparse_categorical_crossentropy"],
                  metrics={"engagement_output": "accuracy", "comprehension_output": "accuracy"})
    model.save(MODEL_PATH)

    lines = [
        "Engagement    accuracy: %.4f" % eng_acc,
        "Engagement    macro-F1: %.4f" % eng_f1,
        "Comprehension accuracy: %.4f" % comp_acc,
        "Comprehension macro-F1: %.4f" % comp_f1,
        "Comprehension errors: %d total | %d adjacent | %d skip" % (comp_errors, comp_adjacent, comp_skip),
        "comprehension label: latest quiz score (>=80 Good, >=50 Moderate, else Low) - matches production comprehension_from_scores",
        "comprehension loss: class-balanced focal (gamma=%.1f) + ordinal (lam=%.1f)" % (FOCAL_GAMMA, ORDINAL_LAMBDA),
        "class-balanced beta: %.3f" % CB_BETA,
        "curves: training_curves.png",
        "source: Kaggle student-learning-interaction-logs-dataset (simulated, 300 students)",
        "method: fine-tuned from deployed best_two_tower_model.keras",
    ]
    with open(REPORT_PATH, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    metrics = {
        "engagement_accuracy": eng_acc,
        "engagement_f1_macro": eng_f1,
        "comprehension_accuracy": comp_acc,
        "comprehension_f1_macro": comp_f1,
        "comprehension_errors": comp_errors,
        "comprehension_adjacent_errors": comp_adjacent,
        "comprehension_skip_errors": comp_skip,
        "loss_params": {"focal_gamma": FOCAL_GAMMA, "class_balanced_beta": CB_BETA, "ordinal_lambda": ORDINAL_LAMBDA},
        "comprehension_label_source": "latest_quiz",
        "train_rows": int(len(X_tr)),
        "val_rows": int(len(X_va)),
        "test_rows": int(len(X_te)),
        "classes_engagement": new_counts,
        "classes_comprehension": new_comp_counts,
    }
    with open(METRICS_PATH, "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, indent=4)

    print("\nartifacts written to", BASE)


if __name__ == "__main__":
    main()