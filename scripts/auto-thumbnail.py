#!/usr/bin/env python3
"""
auto-thumbnail.py -- Generate a thumbnail from a video file.

Extracts the most representative frame using ffmpeg's thumbnail filter,
scales to 1280x720, and optionally adds a text overlay via ImageMagick.

Usage:
    python3 auto-thumbnail.py --video INPUT.mp4 --out thumb.jpg
    python3 auto-thumbnail.py --video INPUT.mp4 --out thumb.jpg --title "My Video"
    python3 auto-thumbnail.py --video INPUT.mp4 --out thumb.jpg --title "My Video" --seek 00:01:30
"""

import argparse
import subprocess
import sys
import os
import tempfile

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


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate thumbnail from video")
    ap.add_argument("--video", required=True, help="Input video file")
    ap.add_argument("--out", required=True, help="Output JPEG path")
    ap.add_argument("--title", default="", help="Title text overlay (optional)")
    ap.add_argument("--subtitle", default="", help="Subtitle text (optional, smaller)")
    ap.add_argument("--seek", default="", help="Seek position before scanning (HH:MM:SS)")
    ap.add_argument("--scan-frames", type=int, default=300,
                    help="Number of frames to scan for best thumbnail (default: 300)")
    args = ap.parse_args()

    if not os.path.exists(args.video):
        print(f"[auto-thumbnail] Input not found: {args.video}", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    if args.title:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            raw_path = tmp.name
        try:
            print(f"[auto-thumbnail] Extracting frame from: {args.video}")
            if not extract_frame(args.video, raw_path, args.seek or None, args.scan_frames):
                return 1
            print(f"[auto-thumbnail] Adding text overlay: '{args.title}'")
            if not add_text_overlay(raw_path, args.out, args.title, args.subtitle or None):
                print("[auto-thumbnail] ImageMagick failed -- saving without overlay", file=sys.stderr)
                os.rename(raw_path, args.out)
        finally:
            if os.path.exists(raw_path):
                os.unlink(raw_path)
    else:
        print(f"[auto-thumbnail] Extracting frame from: {args.video}")
        if not extract_frame(args.video, args.out, args.seek or None, args.scan_frames):
            return 1

    size_kb = os.path.getsize(args.out) // 1024
    print(f"[auto-thumbnail] Done: {args.out} ({size_kb} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
