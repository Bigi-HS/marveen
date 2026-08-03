#!/usr/bin/env python3
"""
auto-thumbnail.py -- Generate a thumbnail from a video file (or a batch).

Extracts the most representative frame using ffmpeg's thumbnail filter,
scales to 1280x720, and optionally adds a text overlay via ImageMagick.

Usage (single):
    python3 auto-thumbnail.py --video INPUT.mp4 --out thumb.jpg
    python3 auto-thumbnail.py --video INPUT.mp4 --out thumb.jpg --title "My Video"
    python3 auto-thumbnail.py --video INPUT.mp4 --out thumb.jpg --title "My Video" --seek 00:01:30

Usage (batch):
    python3 auto-thumbnail.py --batch-dir /path/to/videos/
    python3 auto-thumbnail.py --batch-dir /path/to/videos/ --out-dir /path/to/thumbs/ --workers 6
    python3 auto-thumbnail.py --batch-dir /path/to/videos/ --title-from-filename --seek 00:00:30
"""

import argparse
import subprocess
import sys
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed

FFMPEG = "/home/domin/marveen/store/whisper-env/env/bin/ffmpeg"


def extract_frame(video_path: str, out_path: str, seek: str | None, scan_frames: int) -> bool:
    cmd = [FFMPEG, "-y"]
    if seek:
        cmd += ["-ss", seek]
    cmd += ["-i", video_path]
    cmd += ["-vf", f"thumbnail={scan_frames},scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720"]
    cmd += ["-frames:v", "1", out_path, "-loglevel", "error"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[auto-thumbnail] ffmpeg error:\n{result.stderr[-800:]}", file=sys.stderr)
        return False
    return True


def add_text_overlay(img_path: str, out_path: str, title: str, subtitle: str | None) -> bool:
    """Add text overlay using ImageMagick convert."""
    cmd = ["convert", img_path,
           "-font", "DejaVu-Sans-Bold",
           "-pointsize", "64",
           "-fill", "white",
           "-stroke", "black",
           "-strokewidth", "3",
           "-gravity", "South",
           "-annotate", "+0+50", title]
    if subtitle:
        cmd += [
            "-pointsize", "40",
            "-gravity", "South",
            "-annotate", "+0+10", subtitle,
        ]
    cmd.append(out_path)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[auto-thumbnail] ImageMagick error:\n{result.stderr[-400:]}", file=sys.stderr)
        return False
    return True


VIDEO_EXTENSIONS = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".ts"}


def process_single(video_path: str, out_path: str, title: str, subtitle: str,
                   seek: str, scan_frames: int) -> tuple[str, bool, str]:
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    if title:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            raw_path = tmp.name
        try:
            if not extract_frame(video_path, raw_path, seek or None, scan_frames):
                return video_path, False, "ffmpeg failed"
            if not add_text_overlay(raw_path, out_path, title, subtitle or None):
                os.rename(raw_path, out_path)
                return video_path, True, f"{out_path} (no overlay, ImageMagick failed)"
        finally:
            if os.path.exists(raw_path):
                os.unlink(raw_path)
    else:
        if not extract_frame(video_path, out_path, seek or None, scan_frames):
            return video_path, False, "ffmpeg failed"
    size_kb = os.path.getsize(out_path) // 1024
    return video_path, True, f"{out_path} ({size_kb} KB)"


def run_batch(batch_dir: str, out_dir: str, title_from_filename: bool,
              workers: int, seek: str, scan_frames: int, subtitle: str) -> int:
    videos = sorted(
        p for p in (os.path.join(batch_dir, f) for f in os.listdir(batch_dir))
        if os.path.isfile(p) and os.path.splitext(p)[1].lower() in VIDEO_EXTENSIONS
    )
    if not videos:
        print(f"[auto-thumbnail] No video files found in: {batch_dir}", file=sys.stderr)
        return 1

    os.makedirs(out_dir, exist_ok=True)
    print(f"[auto-thumbnail] Batch: {len(videos)} videos, {workers} workers -> {out_dir}")

    tasks = []
    for vp in videos:
        stem = os.path.splitext(os.path.basename(vp))[0]
        out_path = os.path.join(out_dir, stem + "_thumb.jpg")
        title = stem.replace("_", " ").replace("-", " ") if title_from_filename else ""
        tasks.append((vp, out_path, title, subtitle, seek, scan_frames))

    ok_count = 0
    fail_count = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(process_single, *t): t[0] for t in tasks}
        for fut in as_completed(futures):
            vp, ok, msg = fut.result()
            name = os.path.basename(vp)
            if ok:
                ok_count += 1
                print(f"  [ok] {name} -> {msg}")
            else:
                fail_count += 1
                print(f"  [FAIL] {name}: {msg}", file=sys.stderr)

    print(f"[auto-thumbnail] Batch done: {ok_count} ok, {fail_count} failed")
    return 0 if fail_count == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate thumbnail from video (single or batch)")
    ap.add_argument("--video", default="", help="Input video file (single mode)")
    ap.add_argument("--out", default="", help="Output JPEG path (single mode)")
    ap.add_argument("--batch-dir", default="", help="Directory of videos to process (batch mode)")
    ap.add_argument("--out-dir", default="", help="Output directory for batch (default: batch-dir)")
    ap.add_argument("--workers", type=int, default=4,
                    help="Parallel workers for batch mode (default: 4)")
    ap.add_argument("--title-from-filename", action="store_true",
                    help="Batch: derive title text overlay from video filename")
    ap.add_argument("--title", default="", help="Title text overlay (optional)")
    ap.add_argument("--subtitle", default="", help="Subtitle text (optional, smaller)")
    ap.add_argument("--seek", default="", help="Seek position before scanning (HH:MM:SS)")
    ap.add_argument("--scan-frames", type=int, default=300,
                    help="Number of frames to scan for best thumbnail (default: 300)")
    args = ap.parse_args()

    if args.batch_dir:
        if not os.path.isdir(args.batch_dir):
            print(f"[auto-thumbnail] batch-dir not found: {args.batch_dir}", file=sys.stderr)
            return 1
        out_dir = args.out_dir or args.batch_dir
        return run_batch(args.batch_dir, out_dir, args.title_from_filename,
                         args.workers, args.seek, args.scan_frames, args.subtitle)

    if not args.video or not args.out:
        print("[auto-thumbnail] Either --batch-dir or both --video and --out are required",
              file=sys.stderr)
        return 1

    if not os.path.exists(args.video):
        print(f"[auto-thumbnail] Input not found: {args.video}", file=sys.stderr)
        return 1

    _, ok, msg = process_single(args.video, args.out, args.title, args.subtitle,
                                args.seek, args.scan_frames)
    if ok:
        print(f"[auto-thumbnail] Done: {msg}")
        return 0
    else:
        print(f"[auto-thumbnail] Failed: {msg}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
