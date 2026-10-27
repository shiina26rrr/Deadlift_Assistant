"""训练/运行时共享的特征契约常量与几何计算（与 TypeScript 运行时镜像）。

**必须与以下 TS 源保持一致**（任一变更需同步，并递增 FEATURE_VERSION）：
- src/renderer/src/analysis/geometry.ts   （角度定义与有效性规则）
- src/renderer/src/analysis/actionModelRuntime.ts （FEATURE_ORDER / 统计聚合 / 缺失掩码）
- src/renderer/src/analysis/bodyProportion.ts （比例定义）
- src/shared/config.ts                     （阈值/版本常量）

维度：23 维，顺序见 FEATURE_ORDER。
"""
from __future__ import annotations

import math

# ---- 与 config.ts 一致的常量 -------------------------------------------------
DEFAULT_MIN_CONFIDENCE = 0.5          # geometry.ts DEFAULT_MIN_CONFIDENCE
PROPORTION_FEATURE_VERSION = "prop-1"  # config.ts
MODEL_FEATURE_VERSION = "feat-3"       # 特征规范版本（动作分段协议，运行时按产物读取）

# 比例估计参数（config.ts proportion）
PROPORTION_WINDOW_MS = 3000
PROPORTION_MIN_VALID_FRAMES = 12
PROPORTION_MAX_DISPERSION = 0.08
PROPORTION_MIN_SEGMENT_CONFIDENCE = 10.0

EPS = 1e-6

# MediaPipe Pose 33 点索引（geometry.ts LANDMARK_INDEX）
LANDMARK_INDEX = {
    "left": {"shoulder": 11, "elbow": 13, "wrist": 15, "hip": 23, "knee": 25, "ankle": 27},
    "right": {"shoulder": 12, "elbow": 14, "wrist": 16, "hip": 24, "knee": 26, "ankle": 28},
}

# 特征列顺序（actionModelRuntime.ts FEATURE_ORDER）
FEATURE_ORDER = [
    "armGroundAngle_mean",
    "armGroundAngle_min",
    "armGroundAngle_max",
    "armGroundAngle_std",
    "elbowInnerAngle_mean",
    "elbowInnerAngle_min",
    "elbowInnerAngle_max",
    "elbowInnerAngle_std",
    "kneeInnerAngle_mean",
    "kneeInnerAngle_min",
    "kneeInnerAngle_max",
    "kneeInnerAngle_std",
    "trunkLeanAngle_mean",
    "trunkLeanAngle_min",
    "trunkLeanAngle_max",
    "trunkLeanAngle_std",
    "displacementShoulder",
    "displacementHip",
    "durationSec",
    "validRatio",
    "proportionThighToShin",
    "proportionTrunkToLeg",
    "proportionArmToTrunk",
]

FEATURE_UNITS = {
    "armGroundAngle": "deg",
    "elbowInnerAngle": "deg",
    "kneeInnerAngle": "deg",
    "trunkLeanAngle": "deg",
    "displacementShoulder": "fraction_of_body_height",
    "displacementHip": "fraction_of_body_height",
    "durationSec": "s",
    "validRatio": "ratio_0_1",
    "proportionThighToShin": "ratio",
    "proportionTrunkToLeg": "ratio",
    "proportionArmToTrunk": "ratio",
}


# ---- 向量与角度（镜像 geometry.ts） -----------------------------------------
def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def _length(v):
    return math.hypot(v[0], v[1])


def angle_between(v1, v2):
    m1 = _length(v1)
    m2 = _length(v2)
    if m1 < EPS or m2 < EPS:
        return float("nan")
    cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (m1 * m2)
    cos = max(-1.0, min(1.0, cos))
    return math.acos(cos) * 180.0 / math.pi


def angle_at(a, b, c):
    """顶点 b 处，b→a 与 b→c 的内角（度）。"""
    return angle_between(_sub(a, b), _sub(c, b))


def arm_ground_angle(shoulder, wrist):
    """手臂与水平线锐角（0–90°）。"""
    v = _sub(wrist, shoulder)
    return math.atan2(abs(v[1]), abs(v[0])) * 180.0 / math.pi


def trunk_lean_angle(hip, shoulder):
    """躯干（髋→肩）与竖直线夹角（0–90°）。"""
    v = _sub(shoulder, hip)
    return math.atan2(abs(v[0]), abs(v[1])) * 180.0 / math.pi


def _entry(value, lo, hi):
    """有效性规则（geometry.ts entry）：越界或非有限 → UNAVAILABLE。"""
    if value is None or not math.isfinite(value):
        return None
    if value < lo - 1e-3 or value > hi + 1e-3:
        return None
    return value


def visible(point, min_confidence=DEFAULT_MIN_CONFIDENCE):
    """point 为 (x, y, visibility)；低于置信阈值或非有限 → 不可见。"""
    if point is None:
        return False
    x, y, vis = point
    return vis >= min_confidence and math.isfinite(x) and math.isfinite(y)


def compute_angles_from_pixels(points, side, min_confidence=DEFAULT_MIN_CONFIDENCE):
    """由像素坐标点（(x,y,visibility) 三元组列表）计算四项角度。

    返回 dict：每项为 float 或 None（None 表示 UNAVAILABLE）。
    """
    idx = LANDMARK_INDEX[side]

    def at(i):
        return points[i] if i < len(points) else None

    shoulder, elbow, wrist = at(idx["shoulder"]), at(idx["elbow"]), at(idx["wrist"])
    hip, knee, ankle = at(idx["hip"]), at(idx["knee"]), at(idx["ankle"])

    def dist(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1]) if (a and b) else 0.0

    arm_vec_len = dist(shoulder, wrist)
    trunk_vec_len = dist(shoulder, hip)

    arm_valid = visible(shoulder, min_confidence) and visible(wrist, min_confidence) and arm_vec_len > EPS
    elbow_valid = visible(shoulder, min_confidence) and visible(elbow, min_confidence) and visible(wrist, min_confidence)
    knee_valid = visible(hip, min_confidence) and visible(knee, min_confidence) and visible(ankle, min_confidence)
    trunk_valid = visible(hip, min_confidence) and visible(shoulder, min_confidence) and trunk_vec_len > EPS

    out = {}
    out["armGroundAngle"] = (
        _entry(arm_ground_angle(shoulder, wrist), 0, 90) if arm_valid else None
    )
    out["elbowInnerAngle"] = (
        _entry(angle_at(shoulder, elbow, wrist), 0, 180) if elbow_valid else None
    )
    out["kneeInnerAngle"] = _entry(angle_at(hip, knee, ankle), 0, 180) if knee_valid else None
    out["trunkLeanAngle"] = _entry(trunk_lean_angle(hip, shoulder), 0, 90) if trunk_valid else None
    return out


def all_angles_valid(angles):
    """四项角度是否全部可用（geometry.ts allAnglesValid）。"""
    return all(angles.get(k) is not None for k in (
        "armGroundAngle", "elbowInnerAngle", "kneeInnerAngle", "trunkLeanAngle"
    ))


def side_confidence(landmarks, side):
    """该侧 6 点平均 visibility（landmarks 为 (x,y,vis) 三元组列表）。"""
    idx = LANDMARK_INDEX[side]
    keys = [idx["shoulder"], idx["elbow"], idx["wrist"], idx["hip"], idx["knee"], idx["ankle"]]
    total = 0.0
    for k in keys:
        p = landmarks[k] if k < len(landmarks) else None
        total += (p[2] if p else 0.0)
    return total / len(keys)


# ---- 统计聚合（镜像 actionModelRuntime.ts angleStats） ------------------------
def angle_stats(per_frame_values):
    """对一列（含 None）角度取 mean/min/max/std（总体标准差）；全缺失 → 全 NaN。"""
    vals = [v for v in per_frame_values if v is not None and math.isfinite(v)]
    if not vals:
        return (float("nan"), float("nan"), float("nan"), float("nan"))
    mean = sum(vals) / len(vals)
    variance = sum((v - mean) ** 2 for v in vals) / len(vals)
    return (mean, min(vals), max(vals), math.sqrt(variance))


def median(values):
    vals = sorted(v for v in values if v is not None and math.isfinite(v))
    if not vals:
        return None
    mid = len(vals) // 2
    if len(vals) % 2 == 0:
        return (vals[mid - 1] + vals[mid]) / 2.0
    return vals[mid]


def relative_mad(values, med):
    vals = [v for v in values if v is not None and math.isfinite(v)]
    if not vals or med is None or med <= 0:
        return 0.0
    dev = [abs(v - med) for v in vals]
    m = median(dev)
    return (m or 0.0) / med
