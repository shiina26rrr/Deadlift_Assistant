"""MyDeadlift 数据集获取脚本（开发阶段，非发行包内容）。

数据来源：MyDeadlift Dataset, Mendeley Data, DOI 10.17632/w5prmmxyt9.1, CC BY 4.0
数据集页面：https://data.mendeley.com/datasets/w5prmmxyt9/1
许可：CC BY 4.0 —— 仅用于开发阶段训练/评估，不随发行包分发；使用须注明来源。

用法（在项目根目录，用 `py` 而非 `python`）：
  py scripts/fetch-mydedlift.py                # 下载 root 文件 + 已登记的 GB 文件夹
  py scripts/fetch-mydedlift.py --list         # 只列出已登记文件夹内容，不下载
  py scripts/fetch-mydedlift.py --folder ID    # 额外下载指定 folder_id 的内容
  py scripts/fetch-mydedlift.py --zip          # 下载整包 zip 并解压（一次性拿全 191 段，推荐）

说明：
- **整包 zip 端点（已实测可用，避免逐文件夹反查 folder_id）**：
  GET https://data.mendeley.com/public-api/zip/w5prmmxyt9/download/1  （302 → S3 预签名）
  返回 `w5prmmxyt9-1.zip`（约 127 MB），内含 191 段 mp4（GB/PB/LLK 三个子目录）+ Extracted_keypoints.csv。
  推荐用 `--zip`（或本文件旁附的并行下载思路），一次拿全；GB 之外无公开文件夹列表 API。
- 逐文件夹方式：root 只暴露 Extracted_keypoints.csv；GB 文件夹 id 已确认，
  PB/LLK 的 folder_id 未在公开 API 中列出（需从页面 Network 反查后用 --folder 传入）。
- 下载写入 dataset/raw/<filename>，已存在且 sha256 匹配则跳过（逐文件模式）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.request
import zipfile

DATASET_ID = "w5prmmxyt9"
DOIVERSION = "1"
API_HOST = "https://data.mendeley.com"
BASE = f"{API_HOST}/public-api/datasets/{DATASET_ID}"
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT_DIR, "dataset", "raw")

# 已确认可用的文件夹（filename 前缀 -> folder_id）
KNOWN_FOLDERS = {
    "GB": "7c1966fa-99c0-4b7a-b76f-72ce1386c9f4",
}
# 待补：PB/LLK 的 folder_id 需从数据集页面获取后填入
PENDING_FOLDERS = ("PB", "LLK")


def http_get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "deadlift-assistant-dev/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def list_folder(folder_id: str) -> list[dict]:
    url = f"{BASE}/files?version={DOIVERSION}&folder_id={folder_id}&limit=500"
    return http_get_json(url)


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(item: dict) -> str:
    os.makedirs(RAW_DIR, exist_ok=True)
    name = item["filename"]
    detail = item.get("content_details") or {}
    url = detail.get("download_url") or item.get("download_url")
    expect = detail.get("sha256_hash") or item.get("sha256")
    dst = os.path.join(RAW_DIR, name)

    if os.path.exists(dst) and expect and sha256_of(dst) == expect:
        print(f"  skip (ok)   {name}")
        return "skip"

    if not url:
        print(f"  ERROR no url {name}")
        return "error"

    tmp = dst + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "deadlift-assistant-dev/1.0"})
    with urllib.request.urlopen(req, timeout=180) as resp, open(tmp, "wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    if expect:
        got = sha256_of(tmp)
        if got != expect:
            os.remove(tmp)
            print(f"  ERROR sha256 mismatch {name}")
            return "error"
    os.replace(tmp, dst)
    print(f"  ok          {name}")
    return "ok"


def download_zip() -> int:
    """下载整包 zip 并扁平解压 mp4/csv 到 dataset/raw/（已存在的 mp4 跳过）。"""
    url = f"{API_HOST}/public-api/zip/{DATASET_ID}/download/{DOIVERSION}"
    tmp = os.path.join(ROOT_DIR, "dataset", "_full.zip")
    os.makedirs(RAW_DIR, exist_ok=True)
    print(f"下载整包：{url}")
    req = urllib.request.Request(url, headers={"User-Agent": "deadlift-assistant-dev/1.0"})
    with urllib.request.urlopen(req, timeout=600) as resp, open(tmp, "wb") as fh:
        shutil.copyfileobj(resp, fh, length=1 << 20)
    print(f"已下载 {os.path.getsize(tmp) / 1048576:.1f} MB，解压中…")
    n = 0
    with zipfile.ZipFile(tmp) as z:
        for info in z.infolist():
            base = os.path.basename(info.filename)
            if not base or not (base.lower().endswith(".mp4") or base.lower().endswith(".csv")):
                continue
            dst = os.path.join(RAW_DIR, base)
            if base.lower().endswith(".mp4") and os.path.exists(dst):
                n += 1
                continue
            with z.open(info) as src, open(dst, "wb") as out:
                shutil.copyfileobj(src, out)
            n += 1
    os.remove(tmp)
    mp4 = [f for f in os.listdir(RAW_DIR) if f.lower().endswith(".mp4")]
    print(f"解压 {n} 项；dataset/raw 现有 {len(mp4)} 段 mp4")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只列出内容，不下载")
    ap.add_argument("--folder", action="append", default=[], help="额外下载的 folder_id（可多次）")
    ap.add_argument("--skip-videos", action="store_true", help="只下载 root 的 CSV/元数据")
    ap.add_argument("--zip", action="store_true", help="下载整包 zip 并解压（推荐，一次拿全 191 段）")
    args = ap.parse_args()

    if args.zip:
        return download_zip()

    print("MyDeadlift 获取（CC BY 4.0, DOI 10.17632/w5prmmxyt9.1）")
    print(f"输出目录：{RAW_DIR}")

    groups: list[tuple[str, str]] = [("root", "root")]
    for name, fid in KNOWN_FOLDERS.items():
        groups.append((name, fid))
    for fid in args.folder:
        groups.append((f"extra:{fid[:8]}", fid))

    stats = {"ok": 0, "skip": 0, "error": 0}
    for name, fid in groups:
        try:
            items = list_folder(fid)
        except Exception as exc:  # noqa: BLE001
            print(f"[{name}] 列表失败：{exc}")
            continue
        total = sum(i.get("size", 0) for i in items)
        print(f"[{name}] {len(items)} 个文件，共 {total / 1048576:.1f} MB")
        for item in items:
            if args.skip_videos and item["filename"].lower().endswith(".mp4"):
                continue
            if args.list:
                print(f"  - {item['filename']} ({item.get('size', 0)} B)")
                continue
            stats[download(item)] += 1

    if not args.list:
        print(f"完成：ok={stats['ok']} skip={stats['skip']} error={stats['error']}")
    if PENDING_FOLDERS:
        print(f"注意：{', '.join(PENDING_FOLDERS)} 文件夹的 folder_id 未登记，"
              f"需从数据集页面获取后用 --folder 传入。")
    return 0 if stats["error"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
