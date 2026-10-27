"""复核训练端分析协议与夹具 expected 一致（CR06）。

用法（项目根目录）：
  py training/check_protocol_parity.py
读取 tests/fixtures/protocol-parity.json（由 make_protocol_parity_fixture.py 生成），
用 training/analysis_protocol.py 重算动作分段与统计值；不一致时退出码 1。
"""
from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analysis_protocol import analyze_frames  # noqa: E402
from make_protocol_parity_fixture import expected_of  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "protocol-parity.json")
TOL = 1e-6


def close(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, float) and not math.isfinite(a):
        return isinstance(b, float) and not math.isfinite(b)
    return abs(float(a) - float(b)) <= TOL


def compare(expected, actual, path: str, errors: list[str]) -> None:
    if isinstance(expected, dict):
        for key, value in expected.items():
            compare(value, actual.get(key), f"{path}.{key}", errors)
    elif isinstance(expected, list):
        if len(expected) != len(actual):
            errors.append(f"{path}: 长度 {len(actual)} != {len(expected)}")
            return
        for i, (e, a) in enumerate(zip(expected, actual)):
            compare(e, a, f"{path}[{i}]", errors)
    elif not close(expected, actual):
        errors.append(f"{path}: {actual!r} != {expected!r}")


def main() -> int:
    with open(FIXTURE, "r", encoding="utf-8") as fh:
        fixture = json.load(fh)
    frame_size = fixture["frameSize"]
    errors: list[str] = []

    for case in fixture["cases"]:
        frames = [
            (
                f["timestamp"],
                [tuple(p) for p in f["landmarks"]],
                frame_size["width"],
                frame_size["height"],
                f["hasPose"],
            )
            for f in case["frames"]
        ]
        actual = expected_of(analyze_frames(frames))
        compare(case["expected"], actual, case["id"], errors)
        print(f"{case['id']}: segments={len(actual['segments'])}")

    if errors:
        print("\n不一致：")
        for err in errors[:50]:
            print(" -", err)
        return 1
    print("训练端协议与夹具一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
