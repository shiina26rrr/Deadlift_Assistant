"""从 MyDeadlift 原视频提取与运行时一致的特征（T11/T12）。

用法（项目根目录，用 `py`）：
  py training/extract_features.py                 # 处理 dataset/raw 下全部 mp4
  py training/extract_features.py --limit 3       # 只处理前 3 条（调试）
  py training/extract_features.py --video GB_S01_R01.mp4

输出：dataset/features/<video>.json，字段含 label/split/participant/features/diagnostics。
- 学习单位 = 一次完整动作（PULLING→稳定 STANDING）内、从最低点（躯干前倾最大）起的上升段；
  分段起点重定位与运行时 AnalysisOrchestrator 完全一致。
- 滤波、选侧、阶段状态机与动作分段全部交给 analysis_protocol.analyze_frames。
- 每条视频使用独立 landmarker（避免跨视频跟踪状态污染），时间轴从 0 开始。
- 缺失以 null 表示（导出特征向量时按 NaN 掩码）。
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    FEATURE_ORDER,
    LANDMARK_INDEX,
    PROPORTION_FEATURE_VERSION,
    PROPORTION_MAX_DISPERSION,
    PROPORTION_MIN_SEGMENT_CONFIDENCE,
    PROPORTION_MIN_VALID_FRAMES,
    angle_stats,
    median,
    relative_mad,
)
from analysis_protocol import analyze_frames  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "dataset", "raw")
FEAT_DIR = os.path.join(ROOT, "dataset", "features")
MODEL = os.path.join(ROOT, "resources", "models", "pose_landmarker_lite.task")
CSV_PATH = os.path.join(RAW_DIR, "Extracted_keypoints.csv")

# 站立帧判定：躯干接近竖直（度）。仅用于比例估计的帧筛选。
STANDING_TRUNK_DEG = 25.0


def load_labels() -> dict:
    """从数据集 CSV 读取每个视频的 split/label（分号分隔，前 3 列为 split;label;video）。"""
    meta = {}
    with open(CSV_PATH, "r", encoding="utf-8") as fh:
        for row in csv.reader(fh, delimiter=";"):
            if len(row) < 3 or row[0] == "Split":
                continue
            split, label, video = row[0], row[1], row[2]
            if video not in meta:
                meta[video] = {"split": split, "label": label}
    return meta


def participant_of(video: str) -> str:
    """文件名形如 GB_S01_R01.mp4 → S01。"""
    stem = os.path.splitext(video)[0]
    parts = stem.split("_")
    for p in parts:
        if p.startswith("S") and p[1:].isdigit():
            return p
    return "S??"


def estimate_proportion(standing_frames):
    """镜像 bodyProportion.ts estimate()：稳健中位数 + 相对 MAD 质量。"""
    thigh_to_shin, trunk_to_leg, arm_to_trunk = [], [], []
    valid_frames = 0
    for points, side in standing_frames:
        idx = LANDMARK_INDEX[side]

        def at(i):
            return points[i] if i < len(points) else None

        def seg(a, b):
            pa, pb = at(a), at(b)
            if not pa or not pb:
                return None
            if not (np.isfinite(pa[0]) and np.isfinite(pa[1]) and np.isfinite(pb[0]) and np.isfinite(pb[1])):
                return None
            d = float(np.hypot(pa[0] - pb[0], pa[1] - pb[1]))
            return d if d >= PROPORTION_MIN_SEGMENT_CONFIDENCE else None

        thigh = seg(idx["hip"], idx["knee"])
        shin = seg(idx["knee"], idx["ankle"])
        trunk = seg(idx["shoulder"], idx["hip"])
        upper_arm = seg(idx["shoulder"], idx["elbow"])
        forearm = seg(idx["elbow"], idx["wrist"])

        contributed = False
        if thigh is not None and shin is not None and shin > 0:
            thigh_to_shin.append(thigh / shin)
            contributed = True
        if trunk is not None and thigh is not None and shin is not None and (thigh + shin) > 0:
            trunk_to_leg.append(trunk / (thigh + shin))
            contributed = True
        if upper_arm is not None and forearm is not None and trunk is not None and trunk > 0:
            arm_to_trunk.append((upper_arm + forearm) / trunk)
            contributed = True
        if contributed:
            valid_frames += 1

    thigh_med = median(thigh_to_shin)
    trunk_med = median(trunk_to_leg)
    arm_med = median(arm_to_trunk)
    disps = [
        relative_mad(thigh_to_shin, thigh_med) if thigh_med is not None else None,
        relative_mad(trunk_to_leg, trunk_med) if trunk_med is not None else None,
        relative_mad(arm_to_trunk, arm_med) if arm_med is not None else None,
    ]
    disps = [d for d in disps if d is not None]
    dispersion = max(disps) if disps else 0.0

    has_any = thigh_med is not None or trunk_med is not None or arm_med is not None
    if not has_any:
        quality = "MISSING"
    elif valid_frames >= PROPORTION_MIN_VALID_FRAMES and dispersion <= PROPORTION_MAX_DISPERSION:
        quality = "OK"
    else:
        quality = "LOW"

    return {
        "featureVersion": PROPORTION_FEATURE_VERSION,
        "ratios": {
            "thighToShin": thigh_med,
            "trunkToLeg": trunk_med,
            "armToTrunk": arm_med,
        },
        "validFrames": valid_frames,
        "dispersion": dispersion,
        "quality": quality,
    }


def process_video(landmarker, path, meta, ts_holder):
    """ts_holder 为 [int]；每条视频从 0 开始的时间轴（独立 landmarker，VIDEO 模式要求单调递增）。

    解码只负责得到原始关键点；滤波、选侧、阶段状态机与动作分段全部交给
    analysis_protocol.analyze_frames，保证与运行时处理同一关键点序列时结果一致。
    """
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    ts_base = ts_holder[0]

    raw_frames = []
    frame_idx = 0
    with_pose = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        ts_ms = ts_base + int(frame_idx * 1000.0 / fps)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        res = landmarker.detect_for_video(mp_img, ts_ms)
        if res.pose_landmarks:
            with_pose += 1
            lm = res.pose_landmarks[0]
            # 归一化坐标保留给位移；像素坐标由 analyze_frames 内部还原。
            pts = [(p.x, p.y, float(p.visibility)) for p in lm]
            raw_frames.append((float(ts_ms), pts, width, height, True))
        else:
            raw_frames.append((float(ts_ms), [], width, height, False))
        frame_idx += 1

    cap.release()
    ts_holder[0] = ts_base + int(frame_idx * 1000.0 / fps) + 1000

    analyzed = analyze_frames(raw_frames)
    segments = analyzed["segments"]
    segment = segments[0] if segments else None

    # 比例估计沿用站立帧（滤波后像素点、当前选侧），与运行时单目近似口径一致。
    standing_frames = []
    for f in analyzed["frames"]:
        if f["side"] is None or not f["filtered"]:
            continue
        trunk = f["angles"]["trunkLeanAngle"]
        if trunk is not None and trunk <= STANDING_TRUNK_DEG:
            standing_frames.append((f["filtered"], f["side"]))
    prop = estimate_proportion(standing_frames)

    if segment is None:
        valid_all4 = 0
        valid_ratio = 0.0
        duration_sec = None
        disp_shoulder = None
        disp_hip = None
        vector = [None for _ in FEATURE_ORDER]
    else:
        frames = segment["frames"]
        valid_all4 = sum(
            1 for a in frames if all(a[k] is not None for k in (
                "armGroundAngle", "elbowInnerAngle", "kneeInnerAngle", "trunkLeanAngle"
            ))
        )
        valid_ratio = segment["validRatio"]
        duration_sec = max(0.0, segment["endMs"] - segment["startMs"]) / 1000.0
        disp_shoulder = segment["displacement"]["shoulder"]
        disp_hip = segment["displacement"]["hip"]

        values = {}
        for base in ("armGroundAngle", "elbowInnerAngle", "kneeInnerAngle", "trunkLeanAngle"):
            values[f"{base}_mean"], values[f"{base}_min"], values[f"{base}_max"], values[f"{base}_std"] = \
                angle_stats([a[base] for a in frames])
        values["displacementShoulder"] = disp_shoulder
        values["displacementHip"] = disp_hip
        values["durationSec"] = duration_sec
        values["validRatio"] = valid_ratio
        # 比例特征仅在参考质量为 OK 时进入向量；LOW/MISSING 走缺失（NaN）分支。
        # 与运行时 actionModelRuntime.extractFeatures 的门控一致。
        if prop.get("quality") == "OK":
            values["proportionThighToShin"] = prop["ratios"]["thighToShin"]
            values["proportionTrunkToLeg"] = prop["ratios"]["trunkToLeg"]
            values["proportionArmToTrunk"] = prop["ratios"]["armToTrunk"]
        else:
            values["proportionThighToShin"] = None
            values["proportionTrunkToLeg"] = None
            values["proportionArmToTrunk"] = None
        vector = [values.get(name) for name in FEATURE_ORDER]

    return {
        "video": os.path.basename(path),
        "label": meta.get("label"),
        "split": meta.get("split"),
        "participant": participant_of(os.path.basename(path)),
        "featureOrder": FEATURE_ORDER,
        "features": vector,
        "proportion": prop,
        "diagnostics": {
            "frames": frame_idx,
            "withPose": with_pose,
            "actionSegments": len(segments),
            "segmentFrames": len(segment["frames"]) if segment else 0,
            "segmentStartMs": segment["startMs"] if segment else None,
            "segmentEndMs": segment["endMs"] if segment else None,
            "validAll4": valid_all4,
            "validRatio": valid_ratio,
            "durationSec": duration_sec,
            "fps": fps,
            "width": width,
            "height": height,
            "standingFrames": len(standing_frames),
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--video", action="append", default=[])
    ap.add_argument("--shards", type=int, default=1, help="分片总数（并行用）")
    ap.add_argument("--shard", type=int, default=0, help="当前分片序号（0 起）")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的特征文件")
    args = ap.parse_args()

    os.makedirs(FEAT_DIR, exist_ok=True)
    meta_all = load_labels()
    base = mp_python.BaseOptions(model_asset_path=MODEL)
    opts = vision.PoseLandmarkerOptions(base_options=base, running_mode=vision.RunningMode.VIDEO)

    videos = sorted(f for f in os.listdir(RAW_DIR) if f.lower().endswith(".mp4"))
    if args.video:
        videos = [v for v in videos if v in set(args.video)]
    if args.shards > 1:
        videos = [v for k, v in enumerate(videos) if k % args.shards == args.shard]
    if args.limit:
        videos = videos[: args.limit]

    print(f"待处理 {len(videos)} 条；输出 {FEAT_DIR}")
    t0 = time.time()
    for i, v in enumerate(videos, 1):
        out_path = os.path.join(FEAT_DIR, os.path.splitext(v)[0] + ".json")
        if os.path.exists(out_path) and not args.video and not args.force:
            print(f"[{i}/{len(videos)}] skip (exists) {v}")
            continue
        # 每条视频使用独立 landmarker：避免上一条视频的跟踪状态影响本条检测，
        # 也与运行时"每次会话从新状态开始"一致。
        landmarker = vision.PoseLandmarker.create_from_options(opts)
        try:
            rec = process_video(landmarker, os.path.join(RAW_DIR, v), meta_all.get(v, {}), [0])
        finally:
            landmarker.close()
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False, indent=1)
        valid = rec["diagnostics"]["validRatio"]
        print(f"[{i}/{len(videos)}] {v}  label={rec['label']} validRatio={valid:.3f} "
              f"prop={rec['proportion']['quality']}")

    print(f"完成，用时 {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
