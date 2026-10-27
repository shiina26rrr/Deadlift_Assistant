"""生成"训练端 vs 运行端预测一致性"固件（T11）。

读取导出的模型产物与若干固定输入特征向量，用**与运行时 predict 完全相同的算法**计算
期望输出，写入 tests/fixtures/model-consistency.json；由 TS 测试
tests/modelRuntimeConsistency.test.ts 加载模型产物后重建同一预测并比对。

用法（项目根目录）：
  py training/make_consistency_fixture.py
"""
from __future__ import annotations

import glob
import json
import math
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, "resources", "models", "action-model.json")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "model-consistency.json")
FEAT_DIR = os.path.join(ROOT, "dataset", "features")


def predict(features, model):
    """镜像 actionModelRuntime.predict（标准化 → 线性 → softmax → 阈值拒判）。"""
    base = {"available": True, "modelVersion": model["modelVersion"]}
    order = model["featureSpec"]["order"]
    dim = len(order)
    if not features:
        return {**base, "rejected": True, "reason": "FEATURE_MISSING"}
    if len(features) != dim:
        return {**base, "rejected": True, "reason": "MODEL_INCOMPATIBLE"}

    missing = sum(1 for v in features if v is None or not math.isfinite(v))
    if missing > dim / 2:
        return {**base, "rejected": True, "reason": "FEATURE_MISSING"}

    mean = model["normalization"]["mean"]
    std = model["normalization"]["std"]
    x = []
    for i, v in enumerate(features):
        filled = v if (v is not None and math.isfinite(v)) else mean[i]
        x.append((filled - mean[i]) / std[i] if std[i] > 0 else 0.0)

    W = model["params"]["W"]
    b = model["params"].get("b", [])
    classes = model["classes"]
    scores = []
    for c in range(len(classes)):
        acc = b[c] if c < len(b) else 0.0
        for j in range(dim):
            acc += W[c * dim + j] * x[j]
        scores.append(acc)
    mx = max(scores)
    exps = [math.exp(s - mx) for s in scores]
    total = sum(exps) or 1.0
    probs = {classes[i]: exps[i] / total for i in range(len(classes))}
    best = max(range(len(classes)), key=lambda i: exps[i])
    if probs[classes[best]] < model["rejectThreshold"]:
        return {**base, "rejected": True, "reason": "LOW_CONFIDENCE", "probabilities": probs}
    return {**base, "rejected": False, "predictedClass": classes[best], "probabilities": probs}


def main() -> int:
    model = json.load(open(MODEL, encoding="utf-8"))

    # 选取若干真实特征向量（每个类别一条），保留原始 NaN(None)。
    cases = []
    picked = {}
    for path in sorted(glob.glob(os.path.join(FEAT_DIR, "*.json"))):
        rec = json.load(open(path, encoding="utf-8"))
        label = rec.get("label")
        if label in picked:
            continue
        rec_order = rec.get("featureOrder") or []
        raw = rec["features"]
        by_name = {name: raw[i] for i, name in enumerate(rec_order) if i < len(raw)}
        # 产物可能只使用特征子集（如不含比例），按产物 order 取列，避免维度不符。
        vec = [None if by_name.get(name) is None else float(by_name[name]) for name in model["featureSpec"]["order"]]
        picked[label] = True
        cases.append({"id": f"real-{label}-{rec['video']}", "features": vec, "expected": predict(vec, model)})

    # 合成：超半数缺失 → FEATURE_MISSING
    dim = len(model["featureSpec"]["order"])
    half_missing = [None] * (dim // 2 + 2) + [1.0] * (dim - (dim // 2 + 2))
    cases.append({"id": "synthetic-half-missing", "features": half_missing, "expected": predict(half_missing, model)})

    # 合成：全缺失特征（非空数组）→ 标准化后全 0，检验是否 LOW_CONFIDENCE
    all_nan = [None] * dim
    cases.append({"id": "synthetic-all-nan", "features": all_nan, "expected": predict(all_nan, model)})

    out = {"modelPath": "resources/models/action-model.json", "cases": cases}
    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    with open(FIXTURE, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"已写出 {FIXTURE}（{len(cases)} 个用例）")
    for c in cases:
        e = c["expected"]
        print(f"  {c['id']}: rejected={e.get('rejected')} reason={e.get('reason')} "
              f"pred={e.get('predictedClass')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
