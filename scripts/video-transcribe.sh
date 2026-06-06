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

[ -n "$URL" ] || { echo "ERROR: no URL given. Usage: $0 <url> [--lang hu|en|auto] [--model small|medium] [--out-dir DIR]" >&2; exit 2; }

# --- input validation (security: external URL -> subprocess -> yt-dlp) ------
# (1) URL allowlist: https ONLY (no file://, ftp://, etc.) and only YouTube /
#     Twitch hosts. yt-dlp would otherwise happily open file:// and other
#     schemes. Strip userinfo so https://youtube.com@evil.com/ cannot slip past.
case "$URL" in
  https://*) ;;
  *) echo "ERROR: only https:// URLs are allowed (got: $URL)" >&2; exit 2 ;;
esac
_auth="${URL#https://}"; _auth="${_auth%%/*}"   # authority: [user@]host[:port]
_auth="${_auth##*@}"                              # strip userinfo
HOST="$(printf '%s' "${_auth%%:*}" | tr '[:upper:]' '[:lower:]')"  # host, lowercased
case "$HOST" in
  youtube.com|www.youtube.com|m.youtube.com|music.youtube.com|youtu.be| \
  youtube-nocookie.com|www.youtube-nocookie.com|*.youtube.com| \
  twitch.tv|www.twitch.tv|m.twitch.tv|clips.twitch.tv|*.twitch.tv) ;;
  *) echo "ERROR: host not allowed (YouTube/Twitch only): '$HOST'" >&2; exit 2 ;;
esac

# (2) flag allowlists: reject anything outside the known-safe sets.
case "$LANG" in hu|en|auto) ;; *) echo "ERROR: --lang must be hu|en|auto (got: $LANG)" >&2; exit 2 ;; esac
case "$MODEL" in small|medium) ;; *) echo "ERROR: --model must be small|medium (got: $MODEL)" >&2; exit 2 ;; esac

# (3) --out-dir must canonicalize to a path INSIDE the repo (no writing to /,
#     $HOME, etc. via '..' or an absolute escape). A relative path resolves
#     against REPO_ROOT (not the caller's CWD) so the tool is CWD-independent.
#     realpath via python normalises a not-yet-existing dir textually.
case "$OUT_DIR" in /*) ;; *) OUT_DIR="$REPO_ROOT/$OUT_DIR" ;; esac
OUT_DIR="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$OUT_DIR")"
REPO_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$REPO_ROOT")"
case "$OUT_DIR" in
  "$REPO_REAL"|"$REPO_REAL"/*) ;;
  *) echo "ERROR: --out-dir must be inside $REPO_REAL (got: $OUT_DIR)" >&2; exit 2 ;;
esac

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

# slug for output names: the yt-dlp video id. SECURITY: this is untrusted output
# that goes into a filesystem path, so it must NOT contain '/', '..', or other
# path chars. Accept ONLY [A-Za-z0-9_-]; anything else (or empty) falls back to a
# safe timestamp slug -- no path traversal into / out of store/transcripts/.
SLUG="$("$YTDLP" --no-playlist --get-id "$URL" 2>/dev/null | head -1 || true)"
if ! printf '%s' "$SLUG" | grep -Eq '^[A-Za-z0-9_-]{1,64}$'; then
  SLUG="transcript-$(date +%Y%m%d-%H%M%S)"
fi

# --- 2. normalise to 16 kHz mono WAV (whisper input) -----------------------
echo "[2/3] ffmpeg: normalising to 16 kHz mono WAV"
WAV="$WORK/audio16k.wav"
if ! "$FFMPEG" -y -i "$SRC" -ac 1 -ar 16000 -vn "$WAV" >"$WORK/ffmpeg.log" 2>&1; then
  echo "ERROR: ffmpeg conversion failed. Last lines:" >&2; tail -5 "$WORK/ffmpeg.log" >&2; exit 11
fi

# --- 3. transcribe (source language) ---------------------------------------
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
