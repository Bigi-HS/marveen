#!/bin/bash
# Class-invariant guard (card c22bae23): any watchdog that CALLS a wd_* helper
# from scripts/lib/watchdog-common.sh MUST source that lib, or the call errors
# ("command not found") at runtime and silently breaks the relaunch-rate cap.
#
# This is the regression guard for two shipped instances of the bug:
#   - scout-watchdog.sh     : cap-check -> non-zero -> else-branch -> NEVER
#                             relaunched (permanent 600s back-off; scout down ~1d).
#   - local-agent-watchdog.sh: `! cap-check` -> non-zero -> then-branch ALWAYS
#                             taken -> rate limit silently disabled (relaunch thrash).
#
# Invariant: for every scripts/*-watchdog.sh, if it references a wd_* function on
# a non-comment line, the script must also source watchdog-common.sh (directly).
# Watchdogs that use no wd_* helper are exempt (they never need the lib).
#
# Run: bash scripts/test_watchdog_sources_lib.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/scripts/lib/watchdog-common.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

[ -f "$LIB" ] || { echo "FATAL: $LIB not found"; exit 1; }

# wd_* helper names defined by the lib (kept in sync by reading the lib itself).
wd_fns="$(grep -oE '^wd_[a-zA-Z0-9_]+\(\)' "$LIB" | sed 's/()//' | sort -u)"
[ -n "$wd_fns" ] || { echo "FATAL: no wd_* functions found in lib"; exit 1; }
fn_alt="$(echo "$wd_fns" | paste -sd'|' -)"

shopt -s nullglob
for wd in "$ROOT"/scripts/*-watchdog.sh; do
  base="$(basename "$wd")"
  # Call sites: a wd_* name on a line that is NOT a comment (strip leading ws,
  # skip lines beginning with #). Definition lines don't occur here (watchdogs
  # never define wd_* -- those live only in the lib).
  calls="$(grep -nE "\b(${fn_alt})\b" "$wd" | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  if [ -z "$calls" ]; then
    ok "$base: uses no wd_* helper (exempt)"
    continue
  fi
  if grep -qE '(^|[^a-zA-Z0-9_])watchdog-common\.sh' "$wd"; then
    ok "$base: calls wd_* and sources watchdog-common.sh"
  else
    bad "$base: calls wd_* but does NOT source watchdog-common.sh -> runtime 'command not found' (relaunch cap broken)"
    echo "$calls" | sed 's/^/        /'
  fi
done

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
