#!/bin/bash
# Tests inbound-video-handle.sh -- the local video -> transcript+keyframes helper
# for the fleet multimodal-inbound capability (kanban card 7469c9bd).
#
# The script's binary paths default to absolute whisper-env paths. The test
# overrides them via env vars (INBOUND_FFMPEG, INBOUND_FFPROBE, INBOUND_WHISPER_PY)
# to inject stubs so no real whisper-env / ffmpeg installation is required.
#
# Run: bash scripts/__tests__/inbound-video-handle.test.sh

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/inbound-video-handle.sh"

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

[ -f "$SCRIPT" ] || { echo "FATAL: $SCRIPT missing"; exit 1; }
[ -x "$SCRIPT" ] || { echo "FATAL: $SCRIPT not executable (run chmod +x)"; exit 1; }

# --- stub factory ------------------------------------------------------------
# Creates stub executables in a given directory:
#   ffmpeg: writes an empty file at the LAST argument (output path) and exits 0.
#           This covers both audio-extraction (-vn WAV) and keyframe (PNG) calls.
#   ffprobe: prints a fixed duration string to stdout and exits 0.
#   python: acts as the whisper python -- if "$2" ends in "_video_transcribe.py",
#           parses --out-base from argv and writes <out-base>.txt with dummy text.
#           Falls through to real python3 for other uses (timestamp math).
make_stubs() {
  local bindir="$1"
  mkdir -p "$bindir"

  # fake ffmpeg: touch the last arg as the output file
  cat > "$bindir/ffmpeg" <<'STUB'
#!/bin/bash
# stub ffmpeg: write an empty output file at the last positional arg, exit 0
OUT="${@: -1}"
[ -n "$OUT" ] && touch "$OUT"
exit 0
STUB
  chmod +x "$bindir/ffmpeg"

  # fake ffprobe: return a fixed 12.0-second duration
  cat > "$bindir/ffprobe" <<'STUB'
#!/bin/bash
echo "12.0"
exit 0
STUB
  chmod +x "$bindir/ffprobe"

  # fake python: if first real arg is _video_transcribe.py, write a .txt;
  # otherwise delegate to real python3 so the timestamp math still works.
  cat > "$bindir/python" <<'STUBEOF'
#!/bin/bash
# If this invocation is "python /path/_video_transcribe.py ...", write stub .txt
IS_TRANSCRIBE=0
for arg in "$@"; do
  case "$arg" in
    *_video_transcribe.py) IS_TRANSCRIBE=1; break ;;
  esac
done

if [ "$IS_TRANSCRIBE" = "1" ]; then
  OUT_BASE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --out-base) OUT_BASE="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "$OUT_BASE" ] && printf 'stub transcript: test passed\n' > "${OUT_BASE}.txt"
  exit 0
fi

# delegate to real python3 for math
exec python3 "$@"
STUBEOF
  chmod +x "$bindir/python"
}

# Global temp dir cleaned on exit
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

STUBS="$WORK/stubs"
make_stubs "$STUBS"

# ---------------------------------------------------------------------------
# Assertion (a): missing input -> non-zero exit + stderr error message
# ---------------------------------------------------------------------------
echo "--- Assertion (a): missing/invalid input ---"

# a1: no args at all
STDERR_A1="$WORK/stderr-a1.txt"
set +e
"$SCRIPT" 2>"$STDERR_A1"
RC_A1=$?
set -e
[ "$RC_A1" -ne 0 ] \
  && pass "a1: no-args exits non-zero ($RC_A1)" \
  || fail "a1: no-args returned 0 (should be non-zero)"
grep -q "ERROR" "$STDERR_A1" \
  && pass "a1: no-args prints ERROR to stderr" \
  || fail "a1: no-args did not print ERROR to stderr (got: $(cat "$STDERR_A1"))"

# a2: non-existent file path
STDERR_A2="$WORK/stderr-a2.txt"
set +e
"$SCRIPT" "/tmp/__nonexistent_video_12345.mp4" 2>"$STDERR_A2"
RC_A2=$?
set -e
[ "$RC_A2" -ne 0 ] \
  && pass "a2: non-existent file exits non-zero ($RC_A2)" \
  || fail "a2: non-existent file returned 0 (should be non-zero)"
grep -q "ERROR" "$STDERR_A2" \
  && pass "a2: non-existent file prints ERROR to stderr" \
  || fail "a2: non-existent file did not print ERROR to stderr (got: $(cat "$STDERR_A2"))"
echo

# ---------------------------------------------------------------------------
# Assertion (b): keyframe clamp -- --keyframes 50 produces <=8 KEYFRAME lines
# ---------------------------------------------------------------------------
echo "--- Assertion (b): keyframe clamp (--keyframes 50 <= 8 output lines) ---"

FAKE_VIDEO="$WORK/input.mp4"
touch "$FAKE_VIDEO"
OUT_B="$WORK/out-b"

MANIFEST_B="$WORK/manifest-b.txt"
set +e
INBOUND_FFMPEG="$STUBS/ffmpeg" \
INBOUND_FFPROBE="$STUBS/ffprobe" \
INBOUND_WHISPER_PY="$STUBS/python" \
  "$SCRIPT" "$FAKE_VIDEO" --keyframes 50 --out-dir "$OUT_B" >"$MANIFEST_B" 2>/dev/null
RC_B=$?
set -e

[ "$RC_B" -eq 0 ] \
  && pass "b: script exits 0 with stubs" \
  || fail "b: script exited $RC_B (want 0)"

KF_COUNT="$(grep -c '^KEYFRAME=' "$MANIFEST_B" || echo 0)"
[ "$KF_COUNT" -le 8 ] \
  && pass "b: keyframe count clamped to <=$KF_COUNT (<=8)" \
  || fail "b: keyframe count $KF_COUNT exceeds hard cap 8"
echo

# ---------------------------------------------------------------------------
# Assertion (c): manifest contains TRANSCRIPT= and KEYFRAME= lines
# ---------------------------------------------------------------------------
echo "--- Assertion (c): manifest structure ---"

FAKE_VIDEO_C="$WORK/input-c.mp4"
touch "$FAKE_VIDEO_C"
OUT_C="$WORK/out-c"

MANIFEST_C="$WORK/manifest-c.txt"
set +e
INBOUND_FFMPEG="$STUBS/ffmpeg" \
INBOUND_FFPROBE="$STUBS/ffprobe" \
INBOUND_WHISPER_PY="$STUBS/python" \
  "$SCRIPT" "$FAKE_VIDEO_C" --keyframes 2 --out-dir "$OUT_C" >"$MANIFEST_C" 2>/dev/null
RC_C=$?
set -e

[ "$RC_C" -eq 0 ] \
  && pass "c: script exits 0" \
  || fail "c: script exited $RC_C (want 0)"

grep -q '^TRANSCRIPT=' "$MANIFEST_C" \
  && pass "c: manifest contains TRANSCRIPT= line" \
  || fail "c: manifest missing TRANSCRIPT= (got: $(cat "$MANIFEST_C"))"

TRANSCRIPT_PATH="$(grep '^TRANSCRIPT=' "$MANIFEST_C" | head -1 | cut -d= -f2-)"
[ -f "$TRANSCRIPT_PATH" ] \
  && pass "c: TRANSCRIPT path exists on disk ($TRANSCRIPT_PATH)" \
  || fail "c: TRANSCRIPT path does not exist: $TRANSCRIPT_PATH"

KF_C="$(grep -c '^KEYFRAME=' "$MANIFEST_C" || echo 0)"
[ "$KF_C" -ge 1 ] \
  && pass "c: manifest contains $KF_C KEYFRAME= line(s)" \
  || fail "c: manifest has no KEYFRAME= lines"

grep -q '^DURATION=' "$MANIFEST_C" \
  && pass "c: manifest contains DURATION= line" \
  || fail "c: manifest missing DURATION="
echo

# ---------------------------------------------------------------------------
# Assertion (d): production defaults are absolute whisper-env paths (not bare)
# ---------------------------------------------------------------------------
echo "--- Assertion (d): production binary defaults are absolute paths ---"

grep -q 'store/whisper-env/env/bin/ffmpeg' "$SCRIPT" \
  && pass "d: script contains absolute ffmpeg path (store/whisper-env/env/bin/ffmpeg)" \
  || fail "d: script does NOT reference store/whisper-env/env/bin/ffmpeg"

grep -q 'store/whisper-env/env/bin/python' "$SCRIPT" \
  && pass "d: script contains absolute python path (store/whisper-env/env/bin/python)" \
  || fail "d: script does NOT reference store/whisper-env/env/bin/python"

# Confirm the default assignments do NOT fall back to bare 'ffmpeg' or 'python'
# (they must use the whisper-env absolute path as the default, not the system binary)
grep -qE 'FFMPEG_BIN=.*whisper-env' "$SCRIPT" \
  && pass "d: FFMPEG_BIN default uses whisper-env path" \
  || fail "d: FFMPEG_BIN default does not reference whisper-env"

grep -qE 'WHISPER_PY=.*whisper-env' "$SCRIPT" \
  && pass "d: WHISPER_PY default uses whisper-env path" \
  || fail "d: WHISPER_PY default does not reference whisper-env"
echo

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "======================================"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "$FAIL CHECK(S) FAILED"
  exit 1
fi
