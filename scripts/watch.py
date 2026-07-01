#!/usr/bin/env python3
"""
watch.py -- Multimodal video analysis: download + frame extraction + transcript.

Usage:
    python3 scripts/watch.py <URL-or-video-id> [--mode MODE] [--question "..."] [--cleanup]
    python3 scripts/watch.py <URL> --hook    # hook-only: first 15s, 2fps

Output: a workdir /tmp/watch-<VIDEO_ID>/ with:
    video.*           -- downloaded video file
    HH-MM-SS.jpg     -- extracted frames (HH-MM-SS naming is mandatory for Claude alignment)
    transcript.txt    -- timestamped transcript ([Ns] text)
    prompt_ctx.txt    -- ready-to-paste multimodal prompt context block

The SKILL.md orchestration layer reads these files and sends the multimodal prompt to Claude.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

# ── Constants ─────────────────────────────────────────────────────────────────

YTDLP = os.path.expanduser('~/.local/bin/yt-dlp')

# frame_rate, max_seconds (None = full), scale
MODES = {
    'hook':   ('2',    15,   '640:-1'),
    'short':  ('1',    None, '640:-1'),
    'medium': ('1/5',  None, '640:-1'),
    'long':   ('1/30', None, '640:-1'),
    'sparse': ('1/60', None, '640:-1'),
}
DEFAULT_MODE = 'medium'

# ── Video ID extraction ───────────────────────────────────────────────────────

def extract_video_id(url_or_id: str) -> str:
    """Return the 11-char YouTube video ID from a URL or bare ID."""
    # bare ID
    if re.match(r'^[A-Za-z0-9_-]{11}$', url_or_id):
        return url_or_id
    # youtu.be/ID
    m = re.search(r'youtu\.be/([A-Za-z0-9_-]{11})', url_or_id)
    if m:
        return m.group(1)
    # youtube.com/watch?v=ID or /shorts/ID or /embed/ID
    m = re.search(r'(?:v=|/(?:shorts|embed)/)([A-Za-z0-9_-]{11})', url_or_id)
    if m:
        return m.group(1)
    raise ValueError(f'Cannot extract video ID from: {url_or_id!r}')

# ── Prerequisite check ────────────────────────────────────────────────────────

def check_prerequisites() -> dict:
    """Return dict of dependency availability."""
    results = {}
    # yt-dlp
    results['yt_dlp'] = os.path.isfile(YTDLP) and os.access(YTDLP, os.X_OK)
    # ffmpeg
    results['ffmpeg'] = shutil.which('ffmpeg') is not None
    # faster-whisper
    try:
        import importlib
        importlib.import_module('faster_whisper')
        results['faster_whisper'] = True
    except ImportError:
        results['faster_whisper'] = False
    return results

def assert_can_run(prereqs: dict, mode: str) -> None:
    """Raise if critical dependencies are missing for the chosen mode."""
    if not prereqs['yt_dlp']:
        raise RuntimeError(f'yt-dlp not found at {YTDLP}. Install: pip install yt-dlp or download standalone.')
    if not prereqs['ffmpeg']:
        raise RuntimeError(
            'ffmpeg not found. Install: sudo apt install ffmpeg (WSL/Ubuntu) or brew install ffmpeg (Mac).\n'
            'Frame extraction is impossible without ffmpeg. '
            'If you only need a transcript, use yt-dlp --write-auto-sub directly.'
        )

# ── Frame budget ──────────────────────────────────────────────────────────────

def frame_budget_for_duration(duration_s: float, mode: str) -> int:
    """Estimate number of frames for a given duration + mode (informational)."""
    rate_str, max_s, _ = MODES[mode]
    if max_s is not None:
        duration_s = min(duration_s, max_s)
    if '/' in rate_str:
        num, den = rate_str.split('/')
        fps = float(num) / float(den)
    else:
        fps = float(rate_str)
    return max(1, int(duration_s * fps))

# ── Download ──────────────────────────────────────────────────────────────────

def download_video(video_id: str, workdir: Path) -> Path:
    """Download video to workdir. Returns path to the downloaded file."""
    url = f'https://www.youtube.com/watch?v={video_id}'
    out_template = str(workdir / 'video.%(ext)s')
    cmd = [
        YTDLP,
        '-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]',
        '--output', out_template,
        '--no-playlist',
        url,
    ]
    print(f'[watch] Downloading {url} ...', flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'yt-dlp failed:\n{result.stderr}')
    # find the downloaded file
    for f in sorted(workdir.glob('video.*')):
        if f.suffix not in ('.vtt', '.json', '.txt'):
            return f
    raise RuntimeError(f'Downloaded file not found in {workdir}')

# ── Frame extraction ──────────────────────────────────────────────────────────

def extract_frames(video_path: Path, workdir: Path, mode: str) -> list[Path]:
    """Extract frames with HH-MM-SS.jpg naming. Returns sorted list of frame paths."""
    rate_str, max_s, scale = MODES[mode]
    prefix = 'hook-' if mode == 'hook' else ''
    out_pattern = str(workdir / f'{prefix}%H-%M-%S.jpg')

    cmd = ['ffmpeg', '-i', str(video_path)]
    if max_s is not None:
        cmd += ['-t', str(max_s)]
    cmd += [
        '-vf', f'fps={rate_str},scale={scale}',
        '-frame_pts', '1',
        out_pattern,
        '-y',
    ]
    print(f'[watch] Extracting frames (mode={mode}, rate={rate_str}) ...', flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'ffmpeg failed:\n{result.stderr}')

    frames = sorted(workdir.glob(f'{prefix}*.jpg'))
    print(f'[watch] Extracted {len(frames)} frames.', flush=True)
    return frames

# ── Transcript ────────────────────────────────────────────────────────────────

def transcribe_faster_whisper(video_path: Path, transcript_path: Path) -> None:
    """Transcribe with local faster-whisper (PII-safe)."""
    from faster_whisper import WhisperModel  # type: ignore
    print('[watch] Transcribing with faster-whisper (local) ...', flush=True)
    model = WhisperModel('base', device='cpu', compute_type='int8')
    segments, _ = model.transcribe(str(video_path), beam_size=5)
    with open(transcript_path, 'w', encoding='utf-8') as f:
        for seg in segments:
            f.write(f'[{seg.start:.1f}s] {seg.text.strip()}\n')

def parse_vtt(vtt_text: str) -> str:
    """Strip WEBVTT headers, metadata, timecodes, inline tags; dedup overlapping lines."""
    lines = vtt_text.splitlines()
    seen: set[str] = set()
    out: list[str] = []
    # Skip the WEBVTT header block: from 'WEBVTT' line up to and including the first blank line.
    in_header = True
    for line in lines:
        if in_header:
            if not line.strip():
                in_header = False  # end of header block
            continue
        # skip blank lines and timecode lines (contain -->)
        if not line.strip() or '-->' in line:
            continue
        # strip all inline tags: <c>, </c>, <00:00:01.234>, etc.
        clean = re.sub(r'<[^>]+>', '', line).strip()
        if clean and clean not in seen:
            seen.add(clean)
            out.append(clean)
    return '\n'.join(out)

def transcribe_yt_captions(video_id: str, workdir: Path, transcript_path: Path) -> None:
    """Download auto-captions via yt-dlp and parse VTT (fallback, no local model)."""
    print('[watch] Downloading auto-captions (yt-dlp fallback) ...', flush=True)
    url = f'https://www.youtube.com/watch?v={video_id}'
    cmd = [
        YTDLP,
        '--write-auto-sub', '--sub-lang', 'en.*',
        '--skip-download', '--sub-format', 'vtt',
        '--output', str(workdir / '%(title)s.%(ext)s'),
        url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'yt-dlp caption download failed:\n{result.stderr}')
    vtt_files = list(workdir.glob('*.vtt'))
    if not vtt_files:
        raise RuntimeError('No VTT caption file found after yt-dlp download.')
    vtt_text = vtt_files[0].read_text(encoding='utf-8', errors='replace')
    parsed = parse_vtt(vtt_text)
    transcript_path.write_text(parsed, encoding='utf-8')

def get_transcript(
    video_id: str,
    video_path: Path,
    workdir: Path,
    use_faster_whisper: bool,
) -> tuple[Path, str]:
    """Return (transcript_path, method_label)."""
    transcript_path = workdir / 'transcript.txt'
    if use_faster_whisper:
        transcribe_faster_whisper(video_path, transcript_path)
        return transcript_path, 'faster-whisper (local)'
    else:
        transcribe_yt_captions(video_id, workdir, transcript_path)
        return transcript_path, 'yt-dlp auto-captions (fallback)'

# ── Prompt context assembly ───────────────────────────────────────────────────

def build_prompt_context(
    video_id: str,
    frames: list[Path],
    transcript_path: Path,
    transcript_method: str,
    question: str,
    workdir: Path,
) -> Path:
    """Write prompt_ctx.txt with multimodal prompt structure."""
    transcript = transcript_path.read_text(encoding='utf-8') if transcript_path.exists() else '(no transcript)'
    frame_list = '\n'.join(f'  {f.name}' for f in frames)
    ctx = (
        f'You are analyzing video [{video_id}].\n'
        f'Transcript method: {transcript_method}\n\n'
        f'Transcript (timestamped):\n{transcript}\n\n'
        f'Frames are named HH-MM-SS.jpg -- use the filename as the timestamp to align with the transcript.\n'
        f'Frame files in {workdir}:\n{frame_list}\n\n'
        f'[ATTACH: {len(frames)} frames from {workdir}, sorted by name]\n\n'
        f'Question: {question}\n'
    )
    ctx_path = workdir / 'prompt_ctx.txt'
    ctx_path.write_text(ctx, encoding='utf-8')
    return ctx_path

# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description='watch.py: multimodal video analysis prep')
    parser.add_argument('url', help='YouTube URL or 11-char video ID')
    parser.add_argument('--mode', choices=list(MODES), default=DEFAULT_MODE,
                        help=f'Frame extraction mode (default: {DEFAULT_MODE})')
    parser.add_argument('--hook', action='store_true',
                        help='Alias for --mode hook (first 15s at 2fps)')
    parser.add_argument('--question', default='What is happening in this video?',
                        help='Question to answer via multimodal analysis')
    parser.add_argument('--cleanup', action='store_true',
                        help='Remove workdir after printing prompt context')
    parser.add_argument('--no-frames', action='store_true',
                        help='Skip frame extraction (transcript only, faster)')
    parser.add_argument('--whisper', action='store_true',
                        help='Use local faster-whisper for transcript (PII-safe, requires pip install faster-whisper). Default: yt-dlp auto-captions.')
    args = parser.parse_args()

    if args.hook:
        args.mode = 'hook'

    prereqs = check_prerequisites()
    missing = [k for k, v in prereqs.items() if not v]
    if missing:
        print(f'[watch] Dependencies: yt-dlp={prereqs["yt_dlp"]} ffmpeg={prereqs["ffmpeg"]} faster-whisper={prereqs["faster_whisper"]}', file=sys.stderr)

    if not prereqs['yt_dlp']:
        print(f'ERROR: yt-dlp not found at {YTDLP}', file=sys.stderr)
        sys.exit(1)

    try:
        video_id = extract_video_id(args.url)
    except ValueError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)

    workdir = Path(f'/tmp/watch-{video_id}')
    workdir.mkdir(parents=True, exist_ok=True)
    print(f'[watch] Workdir: {workdir}', flush=True)

    video_path: Optional[Path] = None
    frames: list[Path] = []
    transcript_method = 'none'

    try:
        # 1. Download
        video_path = download_video(video_id, workdir)

        # 2. Frame extraction (skip if --no-frames or ffmpeg missing)
        if not args.no_frames:
            if not prereqs['ffmpeg']:
                print('[watch] WARNING: ffmpeg missing -- skipping frame extraction. Install ffmpeg to enable visual analysis.', file=sys.stderr)
            else:
                frames = extract_frames(video_path, workdir, args.mode)

        # 3. Transcript (captions-first: yt-dlp auto-captions is primary,
        # faster-whisper only if --whisper flag is passed AND it is installed)
        use_whisper = args.whisper and prereqs['faster_whisper']
        transcript_path, transcript_method = get_transcript(
            video_id, video_path, workdir,
            use_faster_whisper=use_whisper,
        )

        # 4. Prompt context
        ctx_path = build_prompt_context(
            video_id, frames, transcript_path, transcript_method, args.question, workdir,
        )

        print(f'\n[watch] Done. Workdir: {workdir}')
        print(f'[watch] Transcript method: {transcript_method}')
        print(f'[watch] Frames: {len(frames)} ({args.mode} mode)')
        print(f'[watch] Prompt context: {ctx_path}')
        print(f'\n--- prompt_ctx.txt ---')
        print(ctx_path.read_text())

    finally:
        if args.cleanup and workdir.exists():
            shutil.rmtree(workdir)
            print(f'[watch] Cleaned up {workdir}')


if __name__ == '__main__':
    main()
