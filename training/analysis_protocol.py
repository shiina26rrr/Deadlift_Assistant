"""训练端分析协议：镜像运行时 滤波 → 选侧 → 阶段 → 动作分段。

**必须与以下 TS 源保持一致**（任一变更需同步，并递增 MODEL_FEATURE_VERSION）：
- src/renderer/src/analysis/filter.ts
- src/renderer/src/analysis/sideSelector.ts
- src/renderer/src/analysis/phaseRecognizer.ts
- src/renderer/src/analysis/orchestrator.ts （数据有效性、分段边界、位移与覆盖率）
- src/shared/config.ts （filter/side/phase 默认参数）

学习单位 = PULLING→稳定 STANDING 的完整动作，并在收尾时把起点重定位到最低点
（躯干前倾最大）之后的上升段；训练与运行时使用同一窗口计算特征。
缺失/退化分支与运行时一致：动作中数据失效会丢弃未完成分段，不补造边界。
"""
from __future__ import annotations

import math

from common import LANDMARK_INDEX, all_angles_valid, compute_angles_from_pixels, side_confidence

# ---- 与 config.ts 一致 ------------------------------------------------------
FILTER_WINDOW_SIZE = 5
FILTER_CONFIDENCE_THRESHOLD = 0.5
FILTER_EXPIRY_MS = 800

SIDE_MIN_CONFIDENCE = 0.4
SIDE_SWITCH_HYSTERESIS = 0.15
SIDE_MANUAL = None

READY_STABLE_MS = 500
STAND_STABLE_MS = 400
LEAN_THRESHOLD = 12.0
LONG_INTERRUPT_MS = 3000
KNEE_EXTENDED_DEG = 160.0
TRUNK_UPRIGHT_DEG = 12.0
TRUNK_LEANING_DEG = 30.0
DISPLACEMENT_THRESHOLD = 0.06
ASCENT_PLATEAU_DEG = 1.0

DATA_INSUFFICIENT = "DATA_INSUFFICIENT"
IDLE, READY, PULLING, STANDING, LOWERING = "IDLE", "READY", "PULLING", "STANDING", "LOWERING"


class SlidingFilter:
    """filter.ts 的逐点滑动平均；低置信点不纳入窗口，过期样本丢弃。"""

    def __init__(self, count: int = 33):
        self.count = count
        self.windows: list[list[tuple[float, float, float, float]]] = [[] for _ in range(count)]
        self.last_timestamp = 0.0

    def reset(self) -> None:
        self.windows = [[] for _ in range(self.count)]
        self.last_timestamp = 0.0

    def update(self, points: list[tuple[float, float, float]], timestamp: float):
        if self.last_timestamp != 0 and timestamp - self.last_timestamp > FILTER_EXPIRY_MS:
            self.reset()
        self.last_timestamp = timestamp

        output = []
        for i in range(self.count):
            point = points[i] if i < len(points) else None
            window = self.windows[i]
            while window and timestamp - window[0][3] > FILTER_EXPIRY_MS:
                window.pop(0)

            if point is not None:
                x, y, visibility = point
                if (
                    math.isfinite(x)
                    and math.isfinite(y)
                    and visibility >= FILTER_CONFIDENCE_THRESHOLD
                ):
                    window.append((x, y, visibility, timestamp))
                    while len(window) > FILTER_WINDOW_SIZE:
                        window.pop(0)

            if not window:
                output.append((float("nan"), float("nan"), 0.0))
            else:
                sx = sum(s[0] for s in window)
                sy = sum(s[1] for s in window)
                sv = sum(s[2] for s in window)
                n = len(window)
                output.append((sx / n, sy / n, sv / n))
        return output


class SideSelector:
    """sideSelector.ts：带滞回与切换标记的可见侧选择。"""

    def __init__(self):
        self.current: str | None = None

    def reset(self) -> None:
        self.current = None

    def select(self, left_confidence: float, right_confidence: float) -> tuple[str, bool]:
        if SIDE_MANUAL:
            switched = self.current is not None and self.current != SIDE_MANUAL
            self.current = SIDE_MANUAL
            return SIDE_MANUAL, switched

        left_ok = left_confidence >= SIDE_MIN_CONFIDENCE
        right_ok = right_confidence >= SIDE_MIN_CONFIDENCE
        if not left_ok and not right_ok:
            side = self.current or "left"
            return side, False

        if self.current is None:
            side = "right" if right_confidence > left_confidence else "left"
            self.current = side
            return side, False

        current_conf = left_confidence if self.current == "left" else right_confidence
        other = "right" if self.current == "left" else "left"
        other_conf = left_confidence if other == "left" else right_confidence

        if current_conf < SIDE_MIN_CONFIDENCE and other_conf >= SIDE_MIN_CONFIDENCE:
            self.current = other
            return other, True
        if other_conf > current_conf + SIDE_SWITCH_HYSTERESIS:
            self.current = other
            return other, True
        return self.current, False


class PhaseRecognizer:
    """phaseRecognizer.ts 的状态机（仅保留训练端需要的转移与中断语义）。"""

    def __init__(self):
        self.current = IDLE
        self.since = 0.0
        self.reference: dict | None = None
        self.upright_since: float | None = None
        self.stand_since: float | None = None
        self.lean_since: float | None = None
        self.insufficient_since: float | None = None
        self.pull_peak_lean: float | None = None
        self.pull_rise_floor: float | None = None
        self.pull_rising = False

    def reset(self) -> None:
        self.current = IDLE
        self.since = 0.0
        self.reference = None
        self.upright_since = None
        self.stand_since = None
        self.lean_since = None
        self.insufficient_since = None
        self.pull_peak_lean = None
        self.pull_rise_floor = None
        self.pull_rising = False

    def transition(
        self,
        angles: dict,
        valid: bool,
        shoulder_y: float,
        hip_y: float,
        timestamp: float,
    ) -> str:
        ts = timestamp

        if not valid:
            if self.current != DATA_INSUFFICIENT:
                self.insufficient_since = ts
                self._set_state(DATA_INSUFFICIENT, ts)
            return self.current

        if self.current == DATA_INSUFFICIENT:
            gap = ts - (self.insufficient_since if self.insufficient_since is not None else ts)
            self.upright_since = None
            self.stand_since = None
            self.lean_since = None
            if gap >= LONG_INTERRUPT_MS:
                self.reference = None
                self._set_state(IDLE, ts)
            elif self.reference is None:
                # 无站立参考时 READY 无法判定起拉，回到 IDLE 重新建立。
                self._set_state(IDLE, ts)
            else:
                self._set_state(READY, ts)
            return self.current

        trunk = angles.get("trunkLeanAngle")
        knee = angles.get("kneeInnerAngle")
        trunk_val = trunk if trunk is not None else None
        knee_val = knee if knee is not None else None
        hip_drop = (hip_y - self.reference["hipY"]) if self.reference else 0.0

        if self.current == IDLE:
            # 站直只看躯干回正；膝关节不设统一合格角度（仅用于识别下放）。
            upright = trunk_val is not None and trunk_val <= TRUNK_UPRIGHT_DEG
            if upright:
                self.lean_since = None
                if self.upright_since is None:
                    self.upright_since = ts
                if ts - self.upright_since >= READY_STABLE_MS:
                    self.reference = {
                        "shoulderY": shoulder_y,
                        "hipY": hip_y,
                        "trunkLean": trunk_val if trunk_val is not None else 0.0,
                    }
                    self.upright_since = None
                    self._set_state(READY, ts)
            else:
                self.upright_since = None
                # 冷启动：录像/回放从最低点开始，持续俯身即视为起拉开始。
                leaned = (
                    trunk_val is not None
                    and knee_val is not None
                    and trunk_val >= TRUNK_LEANING_DEG
                )
                if leaned:
                    if self.lean_since is None:
                        self.lean_since = ts
                    if ts - self.lean_since >= READY_STABLE_MS:
                        self.lean_since = None
                        self._set_state(PULLING, ts)
                else:
                    self.lean_since = None

        elif self.current == READY:
            trunk_increase = (
                trunk_val - self.reference["trunkLean"]
                if trunk_val is not None and self.reference
                else 0.0
            )
            if trunk_val is not None and (
                trunk_increase >= LEAN_THRESHOLD or hip_drop >= DISPLACEMENT_THRESHOLD
            ):
                self._set_state(PULLING, ts)

        elif self.current == PULLING:
            standing = trunk_val is not None and trunk_val <= TRUNK_UPRIGHT_DEG
            if standing:
                if self.stand_since is None:
                    self.stand_since = ts
                if ts - self.stand_since >= STAND_STABLE_MS:
                    self.stand_since = None
                    self._set_state(STANDING, ts)
            else:
                self.stand_since = None
                if trunk_val is not None:
                    if self.pull_peak_lean is None or trunk_val >= self.pull_peak_lean:
                        self.pull_peak_lean = trunk_val
                        self.pull_rise_floor = trunk_val
                        self.pull_rising = False
                    else:
                        if (
                            not self.pull_rising
                            and self.pull_peak_lean - trunk_val >= LEAN_THRESHOLD
                        ):
                            self.pull_rising = True
                            self.pull_rise_floor = trunk_val
                        elif self.pull_rising:
                            floor = self.pull_rise_floor if self.pull_rise_floor is not None else trunk_val
                            self.pull_rise_floor = min(floor, trunk_val)
                        if (
                            self.pull_rising
                            and self.pull_rise_floor is not None
                            and trunk_val >= self.pull_rise_floor + LEAN_THRESHOLD
                        ):
                            self._set_state(LOWERING, ts)

        elif self.current == STANDING:
            if trunk_val is not None and trunk_val >= TRUNK_LEANING_DEG:
                self._set_state(LOWERING, ts)
            elif knee_val is not None and knee_val < KNEE_EXTENDED_DEG - 15:
                self._set_state(LOWERING, ts)

        elif self.current == LOWERING:
            # 站直只看躯干回正；膝关节不设统一合格角度（仅用于识别下放）。
            upright = trunk_val is not None and trunk_val <= TRUNK_UPRIGHT_DEG
            if upright:
                if self.upright_since is None:
                    self.upright_since = ts
                if ts - self.upright_since >= READY_STABLE_MS:
                    self.upright_since = None
                    self.reference = {
                        "shoulderY": shoulder_y,
                        "hipY": hip_y,
                        "trunkLean": trunk_val if trunk_val is not None else 0.0,
                    }
                    self._set_state(READY, ts)
            else:
                self.upright_since = None

        return self.current

    def _set_state(self, next_state: str, timestamp: float) -> None:
        if next_state == self.current:
            self.since = timestamp
            return
        if next_state == PULLING:
            self.pull_peak_lean = None
            self.pull_rise_floor = None
            self.pull_rising = False
        self.current = next_state
        self.since = timestamp


def _span(values: list[float]) -> float:
    finite = [v for v in values if math.isfinite(v)]
    if not finite:
        return float("nan")
    return max(finite) - min(finite)


def _ascent_start_index(frames: list[dict]) -> int:
    """最低点（躯干前倾最大）之后的上升段起点；无有效值或全程平台时退回整段。"""
    max_index = -1
    max_value = float("-inf")
    for i, angles in enumerate(frames):
        value = angles["trunkLeanAngle"]
        if value is None or not math.isfinite(value):
            continue
        if value > max_value:
            max_value = value
            max_index = i
    if max_index < 0:
        return 0
    index = max_index
    while index + 1 < len(frames):
        nxt = frames[index + 1]["trunkLeanAngle"]
        if nxt is None or not math.isfinite(nxt) or nxt < max_value - ASCENT_PLATEAU_DEG:
            break
        index += 1
    return index if index < len(frames) - 1 else 0


def _close_action(open_action: dict, end_ms: float) -> dict:
    start = _ascent_start_index(open_action["frames"])
    frames = open_action["frames"][start:]
    shoulder_y = open_action["shoulderY"][start:]
    hip_y = open_action["hipY"][start:]
    ankle_y = open_action["ankleY"][start:]

    heights = [
        a - s
        for a, s in zip(ankle_y, shoulder_y)
        if math.isfinite(a) and math.isfinite(s)
    ]
    body_height = max(heights) if heights else 0.0

    shoulder_span = _span(shoulder_y)
    hip_span = _span(hip_y)
    normalize = lambda v: v / body_height if body_height > 0 and math.isfinite(v) else float("nan")

    valid_count = sum(1 for a in frames if all_angles_valid(a))
    return {
        "index": open_action["index"],
        "side": open_action["side"],
        "startMs": open_action["timestamps"][start],
        "endMs": end_ms,
        "frames": frames,
        "displacement": {
            "shoulder": normalize(shoulder_span),
            "hip": normalize(hip_span),
        },
        "validRatio": (valid_count / len(frames)) if frames else 0.0,
    }


def analyze_frames(frames) -> dict:
    """处理 [(timestamp_ms, landmarks[(x,y,vis)], width, height, has_pose), ...]。

    返回 {"frames": 逐帧分析结果, "segments": 完整动作分段}；
    动作起始/结束、位移归一化与运行时 processFrame/closeOpenAction 完全一致。
    has_pose=False 对应运行时 invalidateFrame：清滤波、进入数据不足，但不计入帧数。
    """
    sliding = SlidingFilter()
    side_selector = SideSelector()
    phase = PhaseRecognizer()
    segments: list[dict] = []
    open_action: dict | None = None
    per_frame: list[dict] = []
    empty_angles = {
        "armGroundAngle": None,
        "elbowInnerAngle": None,
        "kneeInnerAngle": None,
        "trunkLeanAngle": None,
    }

    for timestamp, landmarks, width, height, has_pose in frames:
        if not has_pose:
            sliding.reset()
            prev_state = phase.current
            next_state = phase.transition(empty_angles, False, 0.0, 0.0, timestamp)
            if next_state != prev_state and prev_state == PULLING and next_state != STANDING:
                open_action = None
            per_frame.append(
                {
                    "timestamp": timestamp,
                    "side": None,
                    "filtered": [],
                    "angles": empty_angles,
                    "valid": False,
                    "phase": next_state,
                }
            )
            continue

        points = [(p[0] * width, p[1] * height, p[2]) for p in landmarks]
        filtered = sliding.update(points, timestamp)

        left_conf = side_confidence(landmarks, "left")
        right_conf = side_confidence(landmarks, "right")
        side, switched = side_selector.select(left_conf, right_conf)
        if switched:
            sliding.reset()
            phase.reset()
            open_action = None

        angles = compute_angles_from_pixels(filtered, side, FILTER_CONFIDENCE_THRESHOLD)
        valid = angles["trunkLeanAngle"] is not None and angles["kneeInnerAngle"] is not None

        idx = LANDMARK_INDEX[side]
        shoulder_y = landmarks[idx["shoulder"]][1] if idx["shoulder"] < len(landmarks) else 0.0
        hip_y = landmarks[idx["hip"]][1] if idx["hip"] < len(landmarks) else 0.0

        prev_state = phase.current
        next_state = phase.transition(angles, valid, shoulder_y, hip_y, timestamp)

        if next_state != prev_state:
            if next_state == PULLING and prev_state != PULLING:
                open_action = {
                    "index": len(segments) + 1,
                    "side": side,
                    "startMs": timestamp,
                    "frames": [],
                    "timestamps": [],
                    "shoulderY": [],
                    "hipY": [],
                    "ankleY": [],
                }
            elif prev_state == PULLING and next_state != STANDING:
                open_action = None

        if open_action is not None:
            open_action["frames"].append(angles)
            open_action["timestamps"].append(timestamp)
            open_action["shoulderY"].append(
                landmarks[idx["shoulder"]][1] if idx["shoulder"] < len(landmarks) else float("nan")
            )
            open_action["hipY"].append(
                landmarks[idx["hip"]][1] if idx["hip"] < len(landmarks) else float("nan")
            )
            open_action["ankleY"].append(
                landmarks[idx["ankle"]][1] if idx["ankle"] < len(landmarks) else float("nan")
            )

        if prev_state == PULLING and next_state == STANDING:
            segments.append(_close_action(open_action, timestamp))
            open_action = None

        per_frame.append(
            {
                "timestamp": timestamp,
                "side": side,
                "filtered": filtered,
                "angles": angles,
                "valid": valid,
                "phase": next_state,
            }
        )

    return {"frames": per_frame, "segments": segments}
