#!/usr/bin/env python3
"""
bigben-frame-analysis.py -- Speaker position + safe overlay zone detection.

Uses ffprobe to extract key frames, PIL to analyze visual density per quadrant.
No ML / face detection required: heuristic approach (brightest/most complex zone
= speaker area; opposite = safe overlay zone).

Foundation for card 4b1b62de (HyperFrames frame-grounding).

Usage:
  python3 scripts/bigben-frame-analysis.py --video INPUT.mp4
  python3 scripts/bigben-frame-analysis.py --video INPUT.mp4 --frames 5 --out analysis.json
  python3 scripts/bigben-frame-analysis.py --video INPUT.mp4 --visualize --out-dir /tmp/analysis/
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

FFMPEG = "/home/domin/marveen/store/whisper-env/env/bin/ffmpeg"
FFPROBE = "/home/domin/marveen/store/whisper-env/env/bin/ffprobe"

QUADRANTS = {
    "top-left":     (0,   0,   0.5, 0.5),
    "top-right":    (0.5, 0,   1.0, 0.5),
    "bottom-left":  (0,   0.5, 0.5, 1.0),
    "bottom-right": (0.5, 0.5, 1.0, 1.0),
    "center":       (0.25, 0.25, 0.75, 0.75),
}

SAFE_ZONE_OPPOSITE = {
    "top-left":     "bottom-right",
    "top-right":    "bottom-left",
    "bottom-left":  "top-right",
    "bottom-right": "top-left",
    "center":       "top-right",
}

OVERLAY_POSITIONS = {
    "top-left":     {"x": "w*0.05", "y": "h*0.05"},
    "top-right":    {"x": "w*0.55", "y": "h*0.05"},
    "bottom-left":  {"x": "w*0.05", "y": "h*0.60"},
    "bottom-right": {"x": "w*0.55", "y": "h*0.60"},
    "center":       {"x": "w*0.55", "y": "h*0.05"},
}


class NoDetectionError(Exception):
    """Raised when frame_analyses is empty or all composite scores are zero."""


def get_video_info(video_path):
    cmd = [
        FFPROBE, "-v", "quiet", "-print_format", "json",
        "-show_streams", "-show_format", video_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")
    data = json.loads(result.stdout)
    video_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
        None
    )
    if not video_stream:
        raise RuntimeError("No video stream found")
    duration = float(data.get("format", {}).get("duration", 0))
    width = int(video_stream.get("width", 1920))
    height = int(video_stream.get("height", 1080))
    fps_str = video_stream.get("avg_frame_rate", "30/1")
    num, den = (int(x) for x in fps_str.split("/"))
    fps = num / den if den else 30.0
    return {"duration": duration, "width": width, "height": height, "fps": fps}


def extract_frames(video_path, timestamps, out_dir):
    frames = []
    for i, ts in enumerate(timestamps):
        out_path = os.path.join(out_dir, f"frame_{i:03d}.jpg")
        cmd = [
            FFMPEG, "-y", "-ss", str(ts), "-i", video_path,
            "-vframes", "1", "-q:v", "2", out_path, "-loglevel", "error"
        ]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode == 0 and os.path.exists(out_path):
            frames.append({"timestamp": ts, "path": out_path})
    return frames


def analyze_frame(frame_path, width, height):
    try:
        from PIL import Image, ImageFilter
    except ImportError:
        raise RuntimeError("Pillow not found. Run: pip install Pillow")

    img = Image.open(frame_path).convert("RGB")
    img = img.resize((320, 180), Image.LANCZOS)
    w, h = img.size

    scores = {}
    for name, (x0r, y0r, x1r, y1r) in QUADRANTS.items():
        x0, y0 = int(x0r * w), int(y0r * h)
        x1, y1 = int(x1r * w), int(y1r * h)
        region = img.crop((x0, y0, x1, y1))

        # Visual complexity: edge density via filter
        gray = region.convert("L")
        edges = gray.filter(ImageFilter.FIND_EDGES)
        edge_pixels = list(edges.getdata())
        edge_score = sum(edge_pixels) / (len(edge_pixels) * 255)

        # Brightness (faces tend to be brighter than background in talking-head videos)
        brightness_pixels = list(gray.getdata())
        brightness = sum(brightness_pixels) / (len(brightness_pixels) * 255)

        # Skin-tone heuristic: look for reddish/warm pixels
        rgb_pixels = list(region.getdata())
        skin_count = sum(
            1 for r, g, b in rgb_pixels
            if r > 95 and g > 40 and b > 20
            and r > g and r > b
            and abs(int(r) - int(g)) > 15
        )
        skin_score = skin_count / len(rgb_pixels)

        scores[name] = {
            "edge_complexity": round(edge_score, 4),
            "brightness": round(brightness, 4),
            "skin_tone": round(skin_score, 4),
            "composite": round(
                edge_score * 0.4 + skin_score * 0.4 + brightness * 0.2, 4
            )
        }

    return scores


def consensus_zone(frame_analyses):
    totals = {name: 0.0 for name in QUADRANTS}
    for fa in frame_analyses:
        for name, scores in fa["quadrant_scores"].items():
            totals[name] += scores["composite"]
    if not frame_analyses or sum(totals.values()) == 0.0:
        raise NoDetectionError(
            f"No usable frames ({len(frame_analyses)} analyzed, all composites zero)"
        )
    speaker_zone = max(totals, key=totals.get)
    safe_zone = SAFE_ZONE_OPPOSITE.get(speaker_zone, "top-right")
    return speaker_zone, safe_zone, totals


def main():
    parser = argparse.ArgumentParser(description="Speaker position + safe overlay zone analysis")
    parser.add_argument("--video", required=True, help="Input video file")
    parser.add_argument("--frames", type=int, default=5, help="Number of frames to sample (default: 5)")
    parser.add_argument("--out", help="Save JSON result to file")
    parser.add_argument("--visualize", action="store_true", help="Save annotated frame images")
    parser.add_argument("--out-dir", default="/tmp/bigben-frame-analysis", help="Dir for visualizations")
    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(f"Error: video not found: {args.video}", file=sys.stderr)
        sys.exit(1)

    print(f"Analyzing: {args.video}", file=sys.stderr)

    info = get_video_info(args.video)
    print(f"  {info['width']}x{info['height']} @ {info['fps']:.2f}fps, {info['duration']:.1f}s", file=sys.stderr)

    # Sample timestamps: skip first 5s and last 10s (often logo/outro)
    start = min(5.0, info["duration"] * 0.1)
    end = max(start + 1, info["duration"] - 10.0)
    step = (end - start) / max(1, args.frames - 1)
    timestamps = [start + i * step for i in range(args.frames)]
    timestamps = [min(t, info["duration"] - 0.5) for t in timestamps]

    with tempfile.TemporaryDirectory() as tmpdir:
        frames = extract_frames(args.video, timestamps, tmpdir)
        print(f"  Extracted {len(frames)} frames", file=sys.stderr)

        frame_analyses = []
        for frame in frames:
            scores = analyze_frame(frame["path"], info["width"], info["height"])
            frame_analyses.append({
                "timestamp": round(frame["timestamp"], 2),
                "quadrant_scores": scores
            })

    try:
        speaker_zone, safe_zone, totals = consensus_zone(frame_analyses)
    except NoDetectionError as exc:
        print(f"  Warning: {exc}", file=sys.stderr)
        no_det = {
            "video": args.video,
            "resolution": f"{info['width']}x{info['height']}",
            "duration_s": round(info["duration"], 1),
            "frames_analyzed": len(frame_analyses),
            "speaker_zone": "no-detection",
            "safe_overlay_zone": "no-detection",
            "overlay_position_ffmpeg": None,
            "zone_scores": {},
            "frame_details": frame_analyses,
            "hyperframes_hint": {"note": str(exc)},
        }
        if args.out:
            with open(args.out, "w") as f:
                json.dump(no_det, f, indent=2)
            print(f"Result saved to: {args.out}", file=sys.stderr)
        print(json.dumps({
            "speaker_zone": "no-detection",
            "safe_overlay_zone": "no-detection",
            "overlay_ffmpeg_x": None,
            "overlay_ffmpeg_y": None,
            "confidence": 0.0,
        }, indent=2))
        return

    overlay_pos = OVERLAY_POSITIONS.get(safe_zone, OVERLAY_POSITIONS["top-right"])

    result = {
        "video": args.video,
        "resolution": f"{info['width']}x{info['height']}",
        "duration_s": round(info["duration"], 1),
        "frames_analyzed": len(frame_analyses),
        "speaker_zone": speaker_zone,
        "safe_overlay_zone": safe_zone,
        "overlay_position_ffmpeg": overlay_pos,
        "zone_scores": {k: round(v, 4) for k, v in totals.items()},
        "frame_details": frame_analyses,
        "hyperframes_hint": {
            "safe_x_pct": int(float(overlay_pos["x"].replace("w*", "")) * 100),
            "safe_y_pct": int(float(overlay_pos["y"].replace("h*", "")) * 100),
            "note": f"Speaker detected in {speaker_zone}; overlays safe in {safe_zone}"
        }
    }

    if args.out:
        with open(args.out, "w") as f:
            json.dump(result, f, indent=2)
        print(f"Result saved to: {args.out}", file=sys.stderr)

    print(json.dumps({
        "speaker_zone": speaker_zone,
        "safe_overlay_zone": safe_zone,
        "overlay_ffmpeg_x": overlay_pos["x"],
        "overlay_ffmpeg_y": overlay_pos["y"],
        "confidence": round(
            totals[speaker_zone] / (sum(totals.values()) or 1), 3
        )
    }, indent=2))


if __name__ == "__main__":
    main()
