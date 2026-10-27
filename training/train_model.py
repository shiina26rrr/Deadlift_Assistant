"""训练轻量本地动作模型并导出运行时产物（T11/T12）。

- 特征来自 training/extract_features.py（与运行时同一契约，23 维）。
- 划分按参与者（training/build_splits.py）：训练侧 5 人内部做留一参与者开发验证；
  最终测试侧 2 人只用于一次评估，不参与调参。
- 对比"含/不含身体比例特征"两组模型，按开发集 macro-F1 选型。
- 导出 resources/models/action-model.json（逻辑回归线性参数，可被 TypeScript 直接执行）。

用法（项目根目录）：
  py training/train_model.py
输出：resources/models/action-model.json、dataset/metrics.json、training/MODEL_CARD.md
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import FEATURE_ORDER, FEATURE_UNITS, MODEL_FEATURE_VERSION, PROPORTION_FEATURE_VERSION  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEAT_DIR = os.path.join(ROOT, "dataset", "features")
SPLITS_PATH = os.path.join(ROOT, "dataset", "splits", "participants.json")
OUT_MODEL = os.path.join(ROOT, "resources", "models", "action-model.json")
OUT_METRICS = os.path.join(ROOT, "dataset", "metrics.json")

LABEL_MAP = {
    "gerakan_benar": "GB",
    "punggung_bungkuk": "PB",
    "lutut_lebih_jari_kaki": "LLK",
}
CLASSES = ["GB", "PB", "LLK"]
PROP_FEATURES = {"proportionThighToShin", "proportionTrunkToLeg", "proportionArmToTrunk"}
RANDOM_SEED = 20261015
TARGET_VALIDATION = "EXPERIMENTAL"

# 选型标准（开发侧预先约定，测试集不参与）：在**全部**候选配置（含/不含身体比例）中取
# 开发集 macro-F1 最高者；若最高分与次优分相差小于 SELECTION_TIE_EPS，则视为噪声，
# 优先选特征更少的配置（奥卡姆）。不再强制使用含比例特征集。
SELECTION_TIE_EPS = 0.01
MODEL_VERSION = "dl-action-v3"
# 拒判阈值：取开发集 OOF 最大类别概率的分位数（拒绝最不自信的一部分），并夹在 [0.34, 0.95]。
# 分位数越小越保守（拒绝更多）。这里取第 30 百分位。
REJECT_PERCENTILE = 30
REJECT_MIN = 0.34
REJECT_MAX = 0.95


def load_dataset():
    splits = {}
    if os.path.exists(SPLITS_PATH):
        with open(SPLITS_PATH, "r", encoding="utf-8") as fh:
            splits = json.load(fh)

    records = []
    for path in sorted(glob.glob(os.path.join(FEAT_DIR, "*.json"))):
        with open(path, "r", encoding="utf-8") as fh:
            rec = json.load(fh)
        label = rec.get("label")
        if label not in LABEL_MAP:
            continue
        feats = rec.get("features")
        if not feats or len(feats) != len(FEATURE_ORDER):
            print(f"跳过（维度不符）：{rec.get('video')}")
            continue
        # feat-3：学习单位是完整动作分段；没有 PULLING→STANDING 分段的视频不进入训练。
        if rec.get("diagnostics", {}).get("actionSegments", 1) == 0:
            print(f"跳过（无完整动作分段）：{rec.get('video')}")
            continue
        records.append({
            "video": rec["video"],
            "participant": rec["participant"],
            "split": rec.get("split"),
            "y": CLASSES.index(LABEL_MAP[label]),
            "x": np.array([np.nan if v is None else float(v) for v in feats], dtype=float),
        })
    return records


def standardize_fit(X):
    """按列拟合 mean/std（忽略 NaN）；std<=0 → 1。与运行时归一化口径一致。"""
    with np.errstate(invalid="ignore"):
        mean = np.nanmean(X, axis=0)
        std = np.nanstd(X, axis=0)
    mean = np.where(np.isfinite(mean), mean, 0.0)
    std = np.where(np.isfinite(std) & (std > 1e-8), std, 1.0)
    return mean, std


def transform(X, mean, std):
    """NaN → 列均值，再标准化（NaN 因此映射为 0，与运行时一致）。"""
    Xf = np.where(np.isfinite(X), X, mean)
    return (Xf - mean) / std


def fit_logreg(Xs, y, C, class_weight):
    from sklearn.linear_model import LogisticRegression
    clf = LogisticRegression(
        C=C, max_iter=2000, class_weight=class_weight, solver="lbfgs", random_state=RANDOM_SEED
    )
    clf.fit(Xs, y)
    return clf


def metrics_from_confusion(cm):
    cm = np.asarray(cm, dtype=float)
    n = cm.sum()
    per_class = {}
    for i, c in enumerate(CLASSES):
        tp = cm[i, i]
        fp = cm[:, i].sum() - tp
        fn = cm[i, :].sum() - tp
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        rec = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
        per_class[c] = {"precision": prec, "recall": rec, "f1": f1, "support": int(cm[i, :].sum())}
    macro_f1 = float(np.mean([per_class[c]["f1"] for c in CLASSES]))
    recalls = [per_class[c]["recall"] for c in CLASSES]
    balanced_acc = float(np.mean(recalls))
    acc = float(np.trace(cm) / n) if n else 0.0
    return {
        "accuracy": acc,
        "macroF1": macro_f1,
        "balancedAccuracy": balanced_acc,
        "perClass": per_class,
        "confusion": cm.astype(int).tolist(),
    }


def macro_f1(y_true, y_pred):
    cm = np.zeros((len(CLASSES), len(CLASSES)), dtype=float)
    for t, p in zip(y_true, y_pred):
        cm[t, p] += 1
    return metrics_from_confusion(cm)["macroF1"], cm


def grouped_cv(records, idx, feature_indices, C, class_weight):
    """留一参与者交叉验证（开发验证）；返回 OOF 概率与真值。"""
    parts = sorted({records[i]["participant"] for i in idx})
    oof_prob = np.full((len(idx), len(CLASSES)), np.nan)
    pos = {i: k for k, i in enumerate(idx)}
    for held in parts:
        tr = [i for i in idx if records[i]["participant"] != held]
        te = [i for i in idx if records[i]["participant"] == held]
        Xtr = np.stack([records[i]["x"][feature_indices] for i in tr])
        ytr = np.array([records[i]["y"] for i in tr])
        Xte = np.stack([records[i]["x"][feature_indices] for i in te])
        mean, std = standardize_fit(Xtr)
        clf = fit_logreg(transform(Xtr, mean, std), ytr, C, class_weight)
        prob = clf.predict_proba(transform(Xte, mean, std))
        for k, i in enumerate(te):
            oof_prob[pos[i]] = prob[k]
    return oof_prob


def choose_threshold(oof_prob, y_true, coverage_floor=0.6):
    """在 OOF 概率上选拒判阈值：满足覆盖率下限时，接受样本准确率最大。"""
    maxp = np.nanmax(oof_prob, axis=1)
    pred = np.nanargmax(oof_prob, axis=1)
    best_t, best = 0.0, (-1.0, 0.0)
    for t in np.linspace(0.0, 0.9, 19):
        keep = maxp >= t
        cov = keep.mean()
        if cov < coverage_floor or keep.sum() == 0:
            continue
        acc = float((pred[keep] == y_true[keep]).mean())
        if acc > best[0] + 1e-9:
            best, best_t = (acc, cov), float(t)
    return best_t, best[0], best[1]


def main() -> int:
    if not os.path.exists(SPLITS_PATH):
        print("请先运行：py training/build_splits.py")
        return 1

    records = load_dataset()
    if not records:
        print("无可用特征，请先运行：py training/extract_features.py")
        return 1

    train_idx = [i for i, r in enumerate(records) if r["split"] == "training"]
    test_idx = [i for i, r in enumerate(records) if r["split"] == "testing"]
    print(f"样本 {len(records)}：训练 {len(train_idx)}、测试 {len(test_idx)}")

    all_idx = list(range(len(FEATURE_ORDER)))
    noprop_idx = [i for i, name in enumerate(FEATURE_ORDER) if name not in PROP_FEATURES]

    # ---- 开发集（训练侧留一参与者）选型：特征集 × C × class_weight ----
    grid = []
    y_train = np.array([records[i]["y"] for i in train_idx])
    for feat_name, fidx in (("with_proportion", all_idx), ("no_proportion", noprop_idx)):
        for C in (0.1, 1.0, 10.0):
            for cw in (None, "balanced"):
                oof = grouped_cv(records, train_idx, fidx, C, cw)
                pred = np.nanargmax(oof, axis=1)
                f1, _ = macro_f1(y_train, pred)
                grid.append({"features": feat_name, "C": C, "classWeight": str(cw),
                             "macroF1": f1, "oof": oof, "fidx": fidx})
                print(f"  dev {feat_name:16s} C={C:<4} cw={str(cw):8s} macroF1={f1:.3f}")

    # 选型：全部配置按 dev macro-F1 降序；分数相同或差距在噪声范围内时优先更少特征。
    grid.sort(key=lambda g: (-g["macroF1"], len(g["fidx"])))
    best = grid[0]
    if len(grid) > 1:
        runner_up = grid[1]
        if (
            abs(best["macroF1"] - runner_up["macroF1"]) < SELECTION_TIE_EPS
            and len(runner_up["fidx"]) < len(best["fidx"])
        ):
            best = runner_up
    print(f"选型（按开发集宏平均 F1）：features={best['features']} C={best['C']} "
          f"classWeight={best['classWeight']} (dev macroF1={best['macroF1']:.3f})")
    for g in grid:
        tag = " <-主" if g is best else ""
        print(f"  compare {g['features']:16s} C={g['C']:<4} cw={g['classWeight']:8s} "
              f"devMacroF1={g['macroF1']:.3f}{tag}")

    # 拒判阈值：开发集 OOF 最大类别概率的分位数（夹在 [REJECT_MIN, REJECT_MAX]）。
    oof_maxp = np.nanmax(best["oof"], axis=1)
    thr = float(np.clip(np.percentile(oof_maxp, REJECT_PERCENTILE), REJECT_MIN, REJECT_MAX))
    oof_pred = np.nanargmax(best["oof"], axis=1)
    dev_keep = oof_maxp >= thr
    thr_cov = float(dev_keep.mean()) if len(dev_keep) else 0.0
    thr_acc = float((oof_pred[dev_keep] == y_train[dev_keep]).mean()) if dev_keep.sum() else 0.0
    print(f"拒判阈值={thr:.2f}（dev 覆盖 {thr_cov:.2f}、接受准确率 {thr_acc:.3f}）")

    # ---- 用全部训练侧拟合最终模型 ----
    fidx = best["fidx"]
    Xtr = np.stack([records[i]["x"][fidx] for i in train_idx])
    ytr = np.array([records[i]["y"] for i in train_idx])
    mean, std = standardize_fit(Xtr)
    clf = fit_logreg(transform(Xtr, mean, std), ytr, best["C"], None if best["classWeight"] == "None" else best["classWeight"])

    # ---- 测试侧一次性评估 ----
    Xte = np.stack([records[i]["x"][fidx] for i in test_idx])
    yte = np.array([records[i]["y"] for i in test_idx])
    prob_te = clf.predict_proba(transform(Xte, mean, std))
    pred_te = clf.predict(transform(Xte, mean, std))

    cm = np.zeros((len(CLASSES), len(CLASSES)), dtype=int)
    for t, p in zip(yte, pred_te):
        cm[t, p] += 1
    test_metrics = metrics_from_confusion(cm)
    majority = np.bincount(yte, minlength=len(CLASSES)).max() / len(yte)

    maxp = prob_te.max(axis=1)
    keep = maxp >= thr
    accepted_acc = float((pred_te[keep] == yte[keep]).mean()) if keep.sum() else 0.0

    print("\n=== 测试侧（2 人 / 每类 20）===")
    print(f"accuracy={test_metrics['accuracy']:.3f} macroF1={test_metrics['macroF1']:.3f} "
          f"balancedAcc={test_metrics['balancedAccuracy']:.3f} 多数类基线={majority:.3f}")
    for c in CLASSES:
        m = test_metrics["perClass"][c]
        print(f"  {c}: P={m['precision']:.3f} R={m['recall']:.3f} F1={m['f1']:.3f} n={m['support']}")
    print(f"拒判阈值 {thr:.2f} 下：接受 {int(keep.sum())}/{len(yte)}，接受准确率 {accepted_acc:.3f}")
    print("混淆矩阵（行=真值 GB,PB,LLK；列=预测）:")
    for row in cm:
        print("  ", list(map(int, row)))

    # ---- 组装产物 ----
    used_feature_order = [FEATURE_ORDER[i] for i in fidx]
    units = {}
    for name in used_feature_order:
        base = name
        for suf in ("_mean", "_min", "_max", "_std"):
            if name.endswith(suf):
                base = name[: -len(suf)]
                break
        units[name] = FEATURE_UNITS.get(base, FEATURE_UNITS.get(name, "ratio"))

    W = clf.coef_.reshape(-1).tolist()  # 类数×维数，行主序
    b = clf.intercept_.tolist()

    bundle = {
        "modelVersion": MODEL_VERSION,
        "featureSpec": {
            "version": MODEL_FEATURE_VERSION,
            "order": used_feature_order,
            "units": units,
            "missingMaskRule": "NaN",
            "window": {"actionStatsMs": 0, "normalizationRef": "train-5-participants"},
        },
        "normalization": {"mean": mean.tolist(), "std": std.tolist()},
        "classes": CLASSES,
        "rejectThreshold": round(float(thr), 4),
        "checksum": "",
        "validationStatus": TARGET_VALIDATION,
        "params": {"W": W, "b": b},
    }
    payload = json.dumps(bundle, sort_keys=True, ensure_ascii=False)
    bundle["checksum"] = hashlib.sha256(payload.encode("utf-8")).hexdigest()

    os.makedirs(os.path.dirname(OUT_MODEL), exist_ok=True)
    with open(OUT_MODEL, "w", encoding="utf-8") as fh:
        json.dump(bundle, fh, ensure_ascii=False, indent=1)

    report = {
        "modelVersion": bundle["modelVersion"],
        "featureSpecVersion": MODEL_FEATURE_VERSION,
        "proportionFeatureVersion": PROPORTION_FEATURE_VERSION,
        "selectedConfig": {"features": best["features"], "C": best["C"],
                           "classWeight": best["classWeight"], "devMacroF1": best["macroF1"]},
        "rejectThreshold": bundle["rejectThreshold"],
        "devThreshold": {"coverage": thr_cov, "acceptedAccuracy": thr_acc},
        "testMetrics": test_metrics,
        "testMajorityBaseline": float(majority),
        "testAccepted": {"count": int(keep.sum()), "total": int(len(yte)), "accuracy": accepted_acc},
        "featureComparison": [{"features": g["features"], "C": g["C"], "classWeight": g["classWeight"],
                               "devMacroF1": g["macroF1"]} for g in grid],
        "counts": {"train": len(train_idx), "test": len(test_idx), "total": len(records)},
        "classes": CLASSES,
    }
    with open(OUT_METRICS, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)

    print(f"\n已导出模型 {OUT_MODEL}（checksum {bundle['checksum'][:12]}…）")
    print(f"已导出指标 {OUT_METRICS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
