#!/bin/bash
# Platform-independent video transcription for the fleet (kanban f98cc764).
#
# Transcribes ANY web video's speech independent of the platform's own
# (often missing / inaccurate) auto-captions: yt-dlp pulls the audio, ffmpeg
# normalises it to 16 kHz mono WAV, and faster-whisper (CTranslate2, CPU int8)
# produces a timestamped transcript as BOTH .txt and .srt. Handles Hungarian
# and English (multilingual whisper model).
#
# WHY this stack: the host has no C++ compiler and no sudo, so whisper.cpp can't
# be built. faster-whisper ships prebuilt CTranslate2 wheels, runs CPU-only, and
# is fast + accurate. Everything lives in a self-contained micromamba env at
# store/whisper-env/ -- rebuild recipe in scripts/video-transcribe.md. The script
# calls the env's binaries by ABSOLUTE path; it does NOT rely on PATH.
#
# Usage:
#   scripts/video-transcribe.sh <url> [--lang hu|en|auto] [--model small|medium] [--out-dir DIR]
# Examples:
#   scripts/video-transcribe.sh 'https://youtu.be/XXXX'
#   scripts/video-transcribe.sh 'https://twitch.tv/videos/123' --lang hu --model medium

set -euo pipefail

# --- fixed, documented env location (absolute; never PATH) -----------------
REPO_ROOT="/home/domin/marveen"
ENV="$REPO_ROOT/store/whisper-env/env"
YTDLP="$ENV/bin/yt-dlp"
FFMPEG="$ENV/bin/ffmpeg"
PYTHON="$ENV/bin/python"
HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_video_transcribe.py"
MODEL_CACHE="$REPO_ROOT/store/whisper-env/models"

# --- args ------------------------------------------------------------------
URL=""; LANG="auto"; MODEL="medium"; OUT_DIR="$REPO_ROOT/store/transcripts"
while [ $# -gt 0 ]; do
  case "$1" in
    --lang)   LANG="$2"; shift 2 ;;
    --model)  MODEL="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "ERROR: unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$URL" ]; then URL="$1"; else echo "ERROR: extra arg: $1" >&2; exit 2; fi; shift ;;
  esac
done

[ -n "$URL" ] || { echo "ERROR: no URL given. Usage: $0 <url> [--lang hu|en|auto] [--model small|medium]" >&2; exit 2; }
for bin in "$YTDLP" "$FFMPEG" "$PYTHON"; do
  [ -x "$bin" ] || { echo "ERROR: missing env binary: $bin -- rebuild the env (see scripts/video-transcribe.md)" >&2; exit 3; }
done
[ -f "$HELPER" ] || { echo "ERROR: helper not found: $HELPER" >&2; exit 3; }

mkdir -p "$OUT_DIR" "$MODEL_CACHE"
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# --- 1. pull audio (best audio-only) --------------------------------------
echo "[1/3] yt-dlp: fetching audio from $URL"
if ! "$YTDLP" -f 'bestaudio/best' --no-playlist -o "$WORK/audio.%(ext)s" \
      --ffmpeg-location "$FFMPEG" "$URL" >"$WORK/ytdlp.log" 2>&1; then
  echo "ERROR: yt-dlp failed (bad URL / unavailable / region-locked). Last lines:" >&2
  tail -5 "$WORK/ytdlp.log" >&2
  exit 10
fi
SRC="$(find "$WORK" -maxdepth 1 -name 'audio.*' | head -1)"
[ -n "$SRC" ] || { echo "ERROR: yt-dlp produced no audio file" >&2; exit 10; }

# slug for output names: video id if yt-dlp can give one, else a timestamp
SLUG="$("$YTDLP" --no-playlist --get-id "$URL" 2>/dev/null | head -1 || true)"
[ -n "$SLUG" ] || SLUG="transcript-$(date +%Y%m%d-%H%M%S)"

# --- 2. normalise to 16 kHz mono WAV (whisper input) -----------------------
echo "[2/3] ffmpeg: normalising to 16 kHz mono WAV"
WAV="$WORK/audio16k.wav"
if ! "$FFMPEG" -y -i "$SRC" -ac 1 -ar 16000 -vn "$WAV" >"$WORK/ffmpeg.log" 2>&1; then
  echo "ERROR: ffmpeg conversion failed. Last lines:" >&2; tail -5 "$WORK/ffmpeg.log" >&2; exit 11
fi

# --- 3. transcribe ---------------------------------------------------------
echo "[3/3] faster-whisper: transcribing (model=$MODEL lang=$LANG)"
START=$(date +%s)
if ! "$PYTHON" "$HELPER" --audio "$WAV" --out-base "$OUT_DIR/$SLUG" \
      --model "$MODEL" --lang "$LANG" --download-root "$MODEL_CACHE"; then
  echo "ERROR: transcription failed" >&2; exit 12
fi
END=$(date +%s)
echo "Done in $((END-START))s. Output:"
echo "  $OUT_DIR/$SLUG.txt"
echo "  $OUT_DIR/$SLUG.srt"
