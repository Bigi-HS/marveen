#!/bin/bash
# multi-format-export.sh -- 1 input -> platform variánsok (YT / Reels / LinkedIn)
#
# Usage:
#   scripts/multi-format-export.sh <input.mp4> [--out-dir DIR] [--formats yt,reels,linkedin]
#
# Formátumok:
#   yt        : YouTube  -- 1920x1080 (16:9), H.264, ~8 Mbps, AAC 192k
#   reels     : Reels/Shorts/TikTok -- 1080x1920 (9:16), center-crop, ~6 Mbps, AAC 192k
#   linkedin  : LinkedIn -- 1920x1080 (16:9), ~4 Mbps (kisebb fájl), AAC 128k
#
# 9:16 crop stratégia: a 16:9 forrásból a középső 9:16 sávot vesszük
#   -> ha a videó face-cam + ernyő, a középre tett arcot megőrzi
#   -> ha más composition kell, crop_x paramétert állítsd (lásd lent)
#
# Minden format OUTPUT: <basename>-<format>.mp4

set -euo pipefail

FFMPEG="/home/domin/marveen/store/whisper-env/env/bin/ffmpeg"
INPUT=""
OUT_DIR="."
FORMATS="yt,reels,linkedin"

# --- parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)   OUT_DIR="$2"; shift 2 ;;
    --formats)   FORMATS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    -*)
      echo "ERROR: unknown flag: $1" >&2; exit 2 ;;
    *)
      if [[ -z "$INPUT" ]]; then INPUT="$1"; else echo "ERROR: extra arg: $1" >&2; exit 2; fi
      shift ;;
  esac
done

[[ -n "$INPUT" ]] || { echo "ERROR: no input file. Usage: $0 <input.mp4> [--out-dir DIR]" >&2; exit 2; }
[[ -f "$INPUT" ]] || { echo "ERROR: not found: $INPUT" >&2; exit 2; }

BASENAME="$(basename "${INPUT%.*}")"
mkdir -p "$OUT_DIR"

# --- helper: duration ---
get_duration() {
  "$FFMPEG" -i "$1" 2>&1 | grep "Duration" | awk '{print $2}' | tr -d ','
}

echo ""
echo "Input: $INPUT"
echo "Output: $OUT_DIR/"
echo "Formats: $FORMATS"
echo "---"

# ── YouTube 16:9 ──────────────────────────────────────────────────────────────
if [[ "$FORMATS" == *"yt"* ]]; then
  OUT="$OUT_DIR/${BASENAME}-yt.mp4"
  echo "[1/3] YouTube 1920x1080 (16:9) ..."
  "$FFMPEG" -i "$INPUT" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black" \
    -c:v libx264 -preset fast -crf 18 \
    -maxrate 8M -bufsize 16M \
    -c:a aac -b:a 192k \
    -movflags +faststart \
    -y "$OUT" 2>/dev/null
  SIZE=$(du -sh "$OUT" | cut -f1)
  echo "    -> $OUT  ($SIZE)"
fi

# ── Reels / Shorts / TikTok 9:16 center-crop ──────────────────────────────────
if [[ "$FORMATS" == *"reels"* ]]; then
  OUT="$OUT_DIR/${BASENAME}-reels.mp4"
  echo "[2/3] Reels/Shorts 1080x1920 (9:16, center crop) ..."
  # 16:9 -> 9:16 center crop: a forrás szélességéből kivonjuk a 9:16 sávot
  # iw/ih = input width/height; crop width = ih*(9/16), crop x = (iw-cw)/2
  "$FFMPEG" -i "$INPUT" \
    -vf "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920" \
    -c:v libx264 -preset fast -crf 20 \
    -maxrate 6M -bufsize 12M \
    -c:a aac -b:a 192k \
    -movflags +faststart \
    -y "$OUT" 2>/dev/null
  SIZE=$(du -sh "$OUT" | cut -f1)
  echo "    -> $OUT  ($SIZE)"
fi

# ── LinkedIn 16:9 kompakt ──────────────────────────────────────────────────────
if [[ "$FORMATS" == *"linkedin"* ]]; then
  OUT="$OUT_DIR/${BASENAME}-linkedin.mp4"
  echo "[3/3] LinkedIn 1920x1080 (16:9, kisebb fájl) ..."
  "$FFMPEG" -i "$INPUT" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black" \
    -c:v libx264 -preset fast -crf 23 \
    -maxrate 4M -bufsize 8M \
    -c:a aac -b:a 128k \
    -movflags +faststart \
    -y "$OUT" 2>/dev/null
  SIZE=$(du -sh "$OUT" | cut -f1)
  echo "    -> $OUT  ($SIZE)"
fi

echo ""
echo "Kész. Output fájlok: $OUT_DIR/"
ls -lh "$OUT_DIR/${BASENAME}"*.mp4 2>/dev/null || true
