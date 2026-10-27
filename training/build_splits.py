"""按参与者划分训练/测试集（T11：subject-wise split）。

Mendeley 数据集官方划分：训练 5 人（S01,S02,S03,S05,S06）、测试 2 人（S04,S07）。
本脚本从数据集 CSV 复算该映射并落盘，保证可复现，**不使用随机划分**。

用法（项目根目录）：
  py training/build_splits.py
输出：dataset/splits/participants.json
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "dataset", "raw", "Extracted_keypoints.csv")
OUT_DIR = os.path.join(ROOT, "dataset", "splits")
OUT_PATH = os.path.join(OUT_DIR, "participants.json")


def participant_of(video: str) -> str:
    m = re.search(r"_(S\d+)_", video)
    return m.group(1) if m else "S??"


def main() -> int:
    if not os.path.exists(CSV_PATH):
        print(f"缺少数据集 CSV：{CSV_PATH}")
        return 1

    video_split: dict[str, str] = {}
    video_label: dict[str, str] = {}
    with open(CSV_PATH, "r", encoding="utf-8") as fh:
        for row in csv.reader(fh, delimiter=";"):
            if len(row) < 3 or row[0] == "Split":
                continue
            split, label, video = row[0], row[1], row[2]
            video_split.setdefault(video, split)
            video_label.setdefault(video, label)

    part_split: dict[str, set] = {}
    for video, split in video_split.items():
        part_split.setdefault(participant_of(video), set()).add(split)

    train_parts = sorted(p for p, s in part_split.items() if s == {"training"})
    test_parts = sorted(p for p, s in part_split.items() if s == {"testing"})
    mixed = sorted(p for p, s in part_split.items() if len(s) > 1)

    summary = {
        "source": "Mendeley MyDeadlift, DOI 10.17632/w5prmmxyt9.1 (CC BY 4.0)",
        "protocol": "subject-wise (official dataset split)",
        "trainParticipants": train_parts,
        "testParticipants": test_parts,
        "mixedParticipants": mixed,
        "counts": {
            "trainVideos": sum(1 for s in video_split.values() if s == "training"),
            "testVideos": sum(1 for s in video_split.values() if s == "testing"),
        },
        "videos": {v: {"split": s, "label": video_label[v], "participant": participant_of(v)}
                   for v, s in sorted(video_split.items())},
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=1)

    print(f"训练参与者 {train_parts}（{summary['counts']['trainVideos']} 段）")
    print(f"测试参与者 {test_parts}（{summary['counts']['testVideos']} 段）")
    if mixed:
        print(f"警告：以下参与者的视频跨划分，需人工检查：{mixed}")
    print(f"已写出 {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
