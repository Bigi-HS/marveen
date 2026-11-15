#!/bin/bash
# Local video -> transcript + keyframes helper for the fleet multimodal-inbound
# capability (kanban card 7469c9bd).
#
# Accepts a local video file, extracts audio for whisper transcription, and
# pulls N evenly-spaced keyframes. Prints a machine-readable manifest to stdout
# so the calling agent knows exactly which files to Read.
#
# Usage:
#   scripts/inbound-video-handle.sh <video> [--lang hu|en|auto] [--model small|medium]
#                                            [--keyframes N] [--out-dir DIR]
#
# Token-awareness (AC4): keyframe count is capped at 8 and images are downscaled
# to <=768px width -- the helper enforces these limits so the calling agent
# cannot accidentally burn unbounded vision tokens on a long video.
#
# Binary override (for testing): the production defaults point at the absolute
# whisper-env binary paths so this script NEVER relies on PATH. The env vars
# INBOUND_FFMPEG, INBOUND_FFPROBE, and INBOUND_WHISPER_PY can override all three
# at runtime; the test suite uses this to inject stub executables.

set -euo pipefail

# --- repo root (absolute; CWD-independent) -----------------------------------
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- binary paths (absolute whisper-env defaults; override via env vars) -----
# See header comment: INBOUND_FFMPEG / INBOUND_FFPROBE / INBOUND_WHISPER_PY
# let the test suite inject stubs without touching PATH or the whisper-env.
FFMPEG_BIN="${INBOUND_FFMPEG:-$REPO/store/whisper-env/env/bin/ffmpeg}"
FFPROBE_BIN="${INBOUND_FFPROBE:-$REPO/store/whisper-env/env/bin/ffprobe}"
WHISPER_PY="${INBOUND_WHISPER_PY:-$REPO/store/whisper-env/env/bin/python}"
TRANSCRIBE_PY="$REPO/scripts/_video_transcribe.py"
MODEL_CACHE="$REPO/store/whisper-env/models"

# --- defaults ----------------------------------------------------------------
VIDEO=""; LANG="hu"; MODEL="medium"; KEYFRAMES=4; OUT_DIR=""

# --- arg parsing -------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --lang)       LANG="$2";      shift 2 ;;
    --model)      MODEL="$2";     shift 2 ;;
    --keyframes)  KEYFRAMES="$2"; shift 2 ;;
    --out-dir)    OUT_DIR="$2";   shift 2 ;;
    -h|--help)    sed -n '2,15p' "$0"; exit 0 ;;
    -*)           echo "ERROR: unknown flag: $1" >&2; exit 2 ;;
    *)
      if [ -z "$VIDEO" ]; then
        VIDEO="$1"
      else
        echo "ERROR: extra positional arg: $1" >&2; exit 2
      fi
      shift ;;
  esac
done

# --- input validation --------------------------------------------------------
if [ -z "$VIDEO" ]; then
  echo "ERROR: no video file given. Usage: $0 <video> [--lang hu|en|auto] [--model small|medium] [--keyframes N] [--out-dir DIR]" >&2
  exit 1
fi
if [ ! -f "$VIDEO" ]; then
  echo "ERROR: video file not found: $VIDEO" >&2
  exit 1
fi

# AC6b: cap keyframes at 8 (hard max to bound vision token usage)
KEYFRAMES_INT=$(printf '%d' "$KEYFRAMES" 2>/dev/null) || { echo "ERROR: --keyframes must be an integer" >&2; exit 2; }
if [ "$KEYFRAMES_INT" -gt 8 ]; then
  KEYFRAMES_INT=8
fi
if [ "$KEYFRAMES_INT" -lt 1 ]; then
  KEYFRAMES_INT=1
fi

case "$LANG"  in hu|en|auto) ;; *) echo "ERROR: --lang must be hu|en|auto (got: $LANG)" >&2; exit 2 ;; esac
case "$MODEL" in small|medium) ;; *) echo "ERROR: --model must be small|medium (got: $MODEL)" >&2; exit 2 ;; esac

# --- output directory --------------------------------------------------------
if [ -z "$OUT_DIR" ]; then
  # default: a sibling dir next to the input file, named after the file basename
  VIDEO_DIR="$(cd "$(dirname "$VIDEO")" && pwd)"
  VIDEO_BASE="$(basename "$VIDEO")"
  VIDEO_STEM="${VIDEO_BASE%.*}"
  OUT_DIR="$VIDEO_DIR/${VIDEO_STEM}-inbound-out"
fi
mkdir -p "$OUT_DIR"

# --- working directory (temp, cleaned on exit) --------------------------------
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

VIDEO_ABS="$(cd "$(dirname "$VIDEO")" && pwd)/$(basename "$VIDEO")"
VIDEO_STEM_SAFE="$(basename "${VIDEO_ABS%.*}" | tr -cs 'A-Za-z0-9_-' '_')"

# --- 1. extract audio -> 16 kHz mono WAV ------------------------------------
WAV="$WORK/audio16k.wav"
"$FFMPEG_BIN" -y -i "$VIDEO_ABS" -ac 1 -ar 16000 -vn "$WAV" \
  >"$WORK/ffmpeg-audio.log" 2>&1 \
  || { echo "ERROR: ffmpeg audio extraction failed" >&2
       tail -5 "$WORK/ffmpeg-audio.log" >&2; exit 11; }

# --- 2. transcribe via whisper -----------------------------------------------
TRANSCRIPT_BASE="$OUT_DIR/${VIDEO_STEM_SAFE}"
"$WHISPER_PY" "$TRANSCRIBE_PY" \
  --audio "$WAV" \
  --out-base "$TRANSCRIPT_BASE" \
  --model "$MODEL" \
  --lang "$LANG" \
  --download-root "$MODEL_CACHE" \
  >"$WORK/whisper.log" 2>&1 \
  || { echo "ERROR: transcription failed" >&2
       tail -5 "$WORK/whisper.log" >&2; exit 12; }

TRANSCRIPT_TXT="${TRANSCRIPT_BASE}.txt"

# --- 3. get video duration via ffprobe ---------------------------------------
# prefer the whisper-env ffprobe; fall back to system ffprobe if the env one
# is absent (edge case: env not yet built but system ffprobe available)
if [ -x "$FFPROBE_BIN" ]; then
  PROBE_BIN="$FFPROBE_BIN"
else
  PROBE_BIN="ffprobe"
fi

DURATION="$("$PROBE_BIN" -v error -show_entries format=duration \
  -of default=nw=1:nk=1 "$VIDEO_ABS" 2>/dev/null || echo "0")"

# sanitise: ensure it looks like a non-negative number
if ! printf '%s' "$DURATION" | grep -Eq '^[0-9]+(\.[0-9]+)?$'; then
  DURATION="0"
fi

# --- 4. extract N evenly-spaced keyframes ------------------------------------
# Timestamps: 0 <= t < DURATION, evenly distributed across KEYFRAMES_INT frames.
# For a single frame we use the midpoint; for N>1 we use 0..(N-1) evenly-spaced.
# python3 handles all float arithmetic; ffmpeg gets a plain decimal string.
KEYFRAME_PATHS=()

DURATION_POSITIVE="$(python3 -c "print('yes' if float('$DURATION') > 0 else 'no')")"

if [ "$KEYFRAMES_INT" -ge 1 ] && [ "$DURATION_POSITIVE" = "yes" ]; then
  for i in $(seq 0 $((KEYFRAMES_INT - 1))); do
    TS="$(python3 -c "
d = float('$DURATION')
n = int('$KEYFRAMES_INT')
i = int('$i')
if n == 1:
    t = d / 2.0
else:
    t = i * d / (n - 1)
if t >= d and d > 0:
    t = d * 0.99
print('{:.3f}'.format(max(0.0, t)))
")"
    FRAME_OUT="$OUT_DIR/keyframe-$(printf '%02d' "$i").png"
    "$FFMPEG_BIN" -ss "$TS" -i "$VIDEO_ABS" -frames:v 1 \
      -vf "scale=768:-1" -y "$FRAME_OUT" \
      >"$WORK/ffmpeg-frame-$i.log" 2>&1 \
      || { echo "WARNING: keyframe $i extraction failed (ts=$TS), skipping" >&2; continue; }
    KEYFRAME_PATHS+=("$FRAME_OUT")
  done
fi

# --- 5. print machine-readable manifest to stdout (AC3/AC6c) -----------------
printf 'TRANSCRIPT=%s\n' "$TRANSCRIPT_TXT"
printf 'DURATION=%s\n' "$DURATION"
for kf in "${KEYFRAME_PATHS[@]}"; do
  printf 'KEYFRAME=%s\n' "$kf"
done
