#!/bin/bash
# Unit tests for the Hibiki daily-push tick throttle in fleet-supervisor.sh.
#
# The push script is itself idempotent (per-day state file), so the supervisor's
# only job is to invoke it on a bounded cadence instead of the fragile WSL cron.
# These tests source the supervisor (the `if BASH_SOURCE == $0` guard keeps the
# daemon loop from running) with an ISOLATED store, so STATE_DIR lives in a temp
# dir, then drive `hibiki_push_due` (pure throttle decision) and `ensure_hibiki_push`
# (the dry-run invocation + .next bookkeeping) directly.
#
# Run: bash scripts/__tests__/hibiki-supervisor-push.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

# Source the supervisor with an isolated store. The source-guard skips the daemon.
export FLEET_SUPERVISOR_STORE="$TMP/store"
export HIBIKI_PUSH_THROTTLE_SECONDS=300
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

# Capture log output (ensure_hibiki_push logs the dry-run intent only when it fires).
CAPTURE="$TMP/log.txt"
: > "$CAPTURE"
log() { echo "$*" >> "$CAPTURE"; }

NEXTF="$STATE_DIR/hibiki-push.next"
now() { date +%s; }

# --- hibiki_push_due: pure throttle decision -------------------------------
rm -f "$NEXTF"
hibiki_push_due; assert_eq "no state file -> due" 0 "$?"

echo "$(( $(now) + 9999 ))" > "$NEXTF"
hibiki_push_due; assert_eq "future .next -> throttled" 1 "$?"

echo "$(( $(now) - 1 ))" > "$NEXTF"
hibiki_push_due; assert_eq "past .next -> due" 0 "$?"

echo "garbage" > "$NEXTF"
hibiki_push_due; assert_eq "non-numeric .next -> due (treated as 0)" 0 "$?"

# --- ensure_hibiki_push: fires, then throttles -----------------------------
rm -f "$NEXTF"; : > "$CAPTURE"
ensure_hibiki_push
[ -f "$NEXTF" ] && pass "first call writes .next" || fail "first call writes .next"
grep -q "DRY-RUN would: hibiki-daily-push.py" "$CAPTURE" \
  && pass "first call fires the push (dry-run)" || fail "first call fires the push (dry-run)"
FIRST_NEXT="$(cat "$NEXTF")"

: > "$CAPTURE"
ensure_hibiki_push
grep -q "DRY-RUN would: hibiki-daily-push.py" "$CAPTURE" \
  && fail "immediate re-call is throttled (should NOT fire)" \
  || pass "immediate re-call is throttled (does not fire)"
assert_eq ".next unchanged while throttled" "$FIRST_NEXT" "$(cat "$NEXTF")"

# Expire the window: it fires again.
echo "$(( $(now) - 1 ))" > "$NEXTF"; : > "$CAPTURE"
ensure_hibiki_push
grep -q "DRY-RUN would: hibiki-daily-push.py" "$CAPTURE" \
  && pass "fires again after window elapses" || fail "fires again after window elapses"

# .next is in the future after a fire (throttle re-armed).
[ "$(cat "$NEXTF")" -gt "$(now)" ] && pass "throttle re-armed (.next in future)" \
  || fail "throttle re-armed (.next in future)"

echo ""
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
