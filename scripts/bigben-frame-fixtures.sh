#!/usr/bin/env bash
# Ground-truth fixtures for scripts/bigben-frame-analysis.py.
#
# Every clip has a KNOWN-CORRECT answer by construction: a bright, high-detail
# testsrc2 blob is composited onto a flat dark background at a chosen corner, so
# the expected speaker_zone follows from the coordinates, not from a prior run
# of the detector. Degenerate clips (centred blob, full-frame pattern, flat
# frame) have no correct corner and exist to measure the noise floor.
#
# Usage:
#   scripts/bigben-frame-fixtures.sh [out-dir]     # default /tmp/bb-fixtures
#   scripts/bigben-frame-fixtures.sh --verify      # generate, then assert
#
# See the media-fixture-verify skill for the wider pattern.

set -uo pipefail

FF=/home/domin/marveen/store/whisper-env/env/bin/ffmpeg   # NOT on $PATH, fixed venv location

# Resolve the analyzer NEXT TO THIS SCRIPT, never by absolute repo path. A
# reviewer runs this from a worktree or a fresh clone; an absolute path would
# silently measure whatever sits in the main working tree instead of the
# checkout under review -- i.e. report PASS for code it never executed.
# Computed BEFORE any cd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZE="$SCRIPT_DIR/bigben-frame-analysis.py"

if [ ! -f "$ANALYZE" ]; then
  echo "analyzer not found next to this script: $ANALYZE" >&2
  exit 1
fi

VERIFY=0
[ "${1:-}" = "--verify" ] && { VERIFY=1; shift; }
OUT="${1:-/tmp/bb-fixtures}"
mkdir -p "$OUT"

if [ ! -x "$FF" ]; then
  echo "ffmpeg not found at $FF" >&2
  exit 1
fi

# $1=name  $2=blob_x  $3=blob_y   (1280x720 canvas, 360x360 blob)
gen() {
  "$FF" -y -loglevel error \
    -f lavfi -i "color=c=0x101418:s=1280x720:d=6:r=25" \
    -f lavfi -i "testsrc2=s=360x360:d=6:r=25" \
    -filter_complex "[1:v]format=yuv420p[s];[0:v][s]overlay=x=$2:y=$3" \
    -c:v libx264 -pix_fmt yuv420p "$OUT/$1.mp4"
}

# true positives -- expected zone is implied by the coordinates
gen topleft      40  40
gen topright    880  40
gen bottomleft   40 320
gen bottomright 880 320
# noise floor -- no correct corner exists
gen centered    460 180
"$FF" -y -loglevel error -f lavfi -i "testsrc2=s=1280x720:d=6:r=25" \
  -c:v libx264 -pix_fmt yuv420p "$OUT/uniform.mp4"
"$FF" -y -loglevel error -f lavfi -i "color=c=0x101418:s=1280x720:d=0.04:r=25" \
  -c:v libx264 -pix_fmt yuv420p "$OUT/flat.mp4"

echo "fixtures in $OUT"
[ "$VERIFY" -eq 1 ] || exit 0

echo
fail=0
# One analyzer run per fixture: invoking it per field doubled the ffmpeg work
# and let the two reads disagree. Prints "<speaker_zone> <confidence>", or
# nothing at all if the analyzer or the JSON parse failed.
analyze() {  # $1=fixture name
  python3 "$ANALYZE" --video "$OUT/$1.mp4" --frames 4 2>/dev/null \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["speaker_zone"],d["confidence"])'
}

is_number() {  # reject empty AND anything non-numeric
  case "$1" in
    ''|*[!0-9.]*) return 1 ;;
    *) return 0 ;;
  esac
}

# "not measured" must be its own LOUD state. An unread confidence used to reach
# awk as an empty string, which awk coerces to 0 in a numeric compare -- so a
# crashed analyzer scored 0 < 0.10 and printed "PASS noise". A measurement that
# never happened was reported as evidence of correctness: exactly the failure
# this PR exists to remove, in the harness that verifies it.
measured() {  # $1=label $2=fixture $3=raw analyzer output $4=confidence
  if [ -z "$3" ] || ! is_number "$4"; then
    echo "FAIL $1 $2 -> analyzer produced no usable output ('$3'); NOT measured, not a pass"
    return 1
  fi
  return 0
}

for f in topleft topright bottomleft bottomright; do
  want=$(echo "$f" | sed -E 's/(top|bottom)(left|right)/\1-\2/')
  out=$(analyze "$f"); got=${out%% *}; conf=${out##* }
  measured "measure " "$f" "$out" "$conf" || { fail=1; continue; }
  if [ "$got" = "$want" ]; then
    echo "PASS zone     $f -> $got (confidence $conf)"
  else
    echo "FAIL zone     $f -> got=$got want=$want"; fail=1
  fi
  # a true positive must clear the documented no-signal gate
  awk -v c="$conf" 'BEGIN{exit !(c >= 0.10)}' \
    && echo "PASS gate     $f confidence $conf >= 0.10" \
    || { echo "FAIL gate     $f confidence $conf < 0.10"; fail=1; }
done

# noise floor: the detector may still name a zone, but must not claim confidence
for f in centered uniform flat; do
  out=$(analyze "$f"); conf=${out##* }
  measured "measure " "$f" "$out" "$conf" || { fail=1; continue; }
  awk -v c="$conf" 'BEGIN{exit !(c < 0.10)}' \
    && echo "PASS noise    $f confidence $conf < 0.10" \
    || { echo "FAIL noise    $f confidence $conf >= 0.10 (false positive)"; fail=1; }
done

echo
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"
