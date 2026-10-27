"""生成训练端/运行端动作分段与特征一致性夹具（CR06）。

用法（项目根目录）：
  py training/make_protocol_parity_fixture.py
输出：tests/fixtures/protocol-parity.json

夹具中的 expected 由 Python 分析协议生成；vitest 用同一关键点序列驱动
AnalysisOrchestrator，逐项比较动作起止、帧数、覆盖率、位移与特征缺失标记。
"""
from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analysis_protocol import analyze_frames  # noqa: E402
from common import angle_stats  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "fixtures", "protocol-parity.json")

FRAME = {"width": 480, "height": 848}
STEP_MS = 1000.0 / 30.0
ANGLE_KEYS = ("armGroundAngle", "elbowInnerAngle", "kneeInnerAngle", "trunkLeanAngle")


def base_landmarks() -> list[list[float]]:
    return [[0.5, 0.5, 0.9] for _ in range(33)]


def standing_landmarks() -> list[list[float]]:
    pts = base_landmarks()
    pts[11] = [0.5, 0.30, 0.9]  # 左肩
    pts[13] = [0.5, 0.45, 0.9]  # 左肘
    pts[15] = [0.5, 0.60, 0.9]  # 左腕
    pts[23] = [0.5, 0.60, 0.9]  # 左髋
    pts[25] = [0.5, 0.75, 0.9]  # 左膝
    pts[27] = [0.5, 0.90, 0.9]  # 左踝
    return pts


def leaning_landmarks() -> list[list[float]]:
    pts = standing_landmarks()
    pts[11] = [0.75, 0.30, 0.9]
    return pts


def deep_leaning_landmarks() -> list[list[float]]:
    """躯干前倾约 33°，用于"从最低点开始"的冷启动用例。"""
    pts = standing_landmarks()
    pts[11] = [0.85, 0.30, 0.9]
    return pts


def hidden_hip_landmarks() -> list[list[float]]:
    pts = leaning_landmarks()
    pts[23] = [0.5, 0.60, 0.0]
    return pts


def frames_from(sequence) -> list[tuple]:
    frames = []
    ts = 0.0
    for landmarks, has_pose in sequence:
        frames.append((ts, landmarks, FRAME["width"], FRAME["height"], has_pose))
        ts += STEP_MS
    return frames


def clean(value):
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def expected_of(result) -> dict:
    segments = []
    for seg in result["segments"]:
        stats = {}
        for key in ANGLE_KEYS:
            mean, mn, mx, std = angle_stats([a[key] for a in seg["frames"]])
            stats[f"{key}_mean"] = clean(mean)
            stats[f"{key}_min"] = clean(mn)
            stats[f"{key}_max"] = clean(mx)
            stats[f"{key}_std"] = clean(std)
        segments.append(
            {
                "startMs": clean(seg["startMs"]),
                "endMs": clean(seg["endMs"]),
                "frameCount": len(seg["frames"]),
                "validRatio": clean(seg["validRatio"]),
                "displacement": {
                    "shoulder": clean(seg["displacement"]["shoulder"]),
                    "hip": clean(seg["displacement"]["hip"]),
                },
                "angles": stats,
                "durationSec": clean(max(0.0, seg["endMs"] - seg["startMs"]) / 1000.0),
            }
        )
    return {"segments": segments}


def main() -> int:
    cases = []

    complete = (
        [(standing_landmarks(), True)] * 16
        + [(leaning_landmarks(), True)] * 4
        + [(standing_landmarks(), True)] * 20
    )
    frames = frames_from(complete)
    cases.append(
        {
            "id": "complete-action",
            "frames": [
                {"timestamp": f[0], "landmarks": f[1], "hasPose": f[4]} for f in frames
            ],
            "expected": expected_of(analyze_frames(frames)),
        }
    )

    cold_start = (
        [(deep_leaning_landmarks(), True)] * 20
        + [(standing_landmarks(), True)] * 20
    )
    frames = frames_from(cold_start)
    cases.append(
        {
            "id": "starts-bent-at-bottom",
            "frames": [
                {"timestamp": f[0], "landmarks": f[1], "hasPose": f[4]} for f in frames
            ],
            "expected": expected_of(analyze_frames(frames)),
        }
    )

    interrupted = (
        [(standing_landmarks(), True)] * 16
        + [(leaning_landmarks(), True)] * 4
        + [(hidden_hip_landmarks(), True)] * 30
        + [(standing_landmarks(), True)] * 20
    )
    frames = frames_from(interrupted)
    cases.append(
        {
            "id": "missing-hip-during-pull",
            "frames": [
                {"timestamp": f[0], "landmarks": f[1], "hasPose": f[4]} for f in frames
            ],
            "expected": expected_of(analyze_frames(frames)),
        }
    )

    no_pose = (
        [(standing_landmarks(), True)] * 16
        + [(leaning_landmarks(), True)] * 4
        + [([], False)] * 2
        + [(standing_landmarks(), True)] * 20
    )
    frames = frames_from(no_pose)
    cases.append(
        {
            "id": "inference-missing-during-pull",
            "frames": [
                {"timestamp": f[0], "landmarks": f[1], "hasPose": f[4]} for f in frames
            ],
            "expected": expected_of(analyze_frames(frames)),
        }
    )

    payload = {
        "description": "CR06 训练端/运行端动作分段与特征一致性夹具（生成脚本 training/make_protocol_parity_fixture.py）",
        "frameSize": FRAME,
        "stepMs": STEP_MS,
        "cases": cases,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    for c in cases:
        print(c["id"], "segments=", len(c["expected"]["segments"]),
              "start=", c["expected"]["segments"][0]["startMs"] if c["expected"]["segments"] else None)
    print(f"已写入 {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
