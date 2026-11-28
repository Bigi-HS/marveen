#!/bin/bash
# Unit test for the check_intervals_health_completeness tick throttle wired into
# fleet-supervisor.sh (card eng/health-autofetch-robustness).
#
# Mirrors supervisor-freshness-check.test.sh: source the supervisor with an
# ISOLATED store (the `BASH_SOURCE == $0` guard keeps the daemon loop off),
# stub dash_alive + log, and drive the single check_* function directly in
# --dry-run so no python/network runs. Asserts the fire / throttle / re-arm cycle
# and that a down dashboard suppresses the tick (alert could not deliver anyway).
#
# Run: bash scripts/__tests__/supervisor-intervals-health-completeness.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

export FLEET_SUPERVISOR_STORE="$TMP/store"
mkdir -p "$FLEET_SUPERVISOR_STORE"
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

CAPTURE="$TMP/log.txt"
log() { echo "$*" >> "$CAPTURE"; }
MARKER="DRY-RUN would: intervals-health-completeness-watchdog.py"
TS="$STATE_DIR/intervals-health-completeness.ts"
now() { date +%s; }

# --- dashboard UP: fires on a fresh tick ---
dash_alive() { return 0; }
rm -f "$TS"; : > "$CAPTURE"
check_intervals_health_completeness
[ -f "$TS" ] && pass "fresh tick writes .ts" || fail "fresh tick writes .ts"
grep -qF "$MARKER" "$CAPTURE" && pass "fresh tick fires (dry-run)" || fail "fresh tick fires (dry-run)"
first_ts="$(cat "$TS")"

# --- immediate re-call is throttled ---
: > "$CAPTURE"
check_intervals_health_completeness
grep -qF "$MARKER" "$CAPTURE" \
  && fail "immediate re-call throttled (should NOT fire)" \
  || pass "immediate re-call throttled (does not fire)"
assert_eq ".ts unchanged while throttled" "$first_ts" "$(cat "$TS")"

# --- fires again after the 6h window elapses ---
# This tick stores the LAST-RUN timestamp (age-based throttle, like
# check_zepp_freshness): re-arming means .ts is refreshed to ~now (not now+window).
expired="$(( $(now) - 21601 ))"
echo "$expired" > "$TS"; : > "$CAPTURE"
check_intervals_health_completeness
grep -qF "$MARKER" "$CAPTURE" && pass "fires again after 6h window" || fail "fires again after 6h window"
rearmed="$(cat "$TS")"
{ [ "$rearmed" -gt "$expired" ] && [ "$(( $(now) - rearmed ))" -lt 5 ]; } \
  && pass "throttle re-armed (.ts refreshed to ~now)" \
  || fail "throttle re-armed (.ts refreshed to ~now)"

# --- dashboard DOWN: tick is suppressed (no fire, no .ts churn) ---
dash_alive() { return 1; }
rm -f "$TS"; : > "$CAPTURE"
check_intervals_health_completeness
grep -qF "$MARKER" "$CAPTURE" \
  && fail "dash down suppresses tick (should NOT fire)" \
  || pass "dash down suppresses tick (does not fire)"
[ -f "$TS" ] && fail "dash down writes no .ts" || pass "dash down writes no .ts"

echo ""
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
