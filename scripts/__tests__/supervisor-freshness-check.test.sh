#!/bin/bash
# Unit tests for the freshness-check + token-expiry-check tick throttles in
# fleet-supervisor.sh (cards 9ad7334e + 540511e1).
#
# WSL has no systemd, so the OS cron daemon dies on reboot and can silently die
# mid-session (the literal ~6-week silence of the token-expiry cron). The fix is
# to move both periodic checks onto the always-on supervisor tick. Both detector
# scripts are themselves idempotent (per-owner alert-suppression state / per-level
# escalation state), so the supervisor's only job is to invoke them on a bounded
# cadence -- exactly the ensure_hibiki_push shape. These tests source the
# supervisor (the `BASH_SOURCE == $0` guard keeps the daemon loop from running)
# with an ISOLATED store, then drive the *_due (pure throttle decision) and
# ensure_* (dry-run invocation + .next bookkeeping) functions directly.
#
# Run: bash scripts/__tests__/supervisor-freshness-check.test.sh
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
export FRESHNESS_CHECK_THROTTLE_SECONDS=3600
export TOKEN_EXPIRY_CHECK_THROTTLE_SECONDS=86400
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

# Capture log output (the ensure_* helpers log the dry-run intent only when they fire).
CAPTURE="$TMP/log.txt"
: > "$CAPTURE"
log() { echo "$*" >> "$CAPTURE"; }

now() { date +%s; }

# ---------------------------------------------------------------------------
# Generic throttle-behaviour harness: given a *_due fn, an ensure_* fn, the
# .next basename, and the dry-run log marker, assert the fire/throttle/re-arm
# cycle. Both new ticks share the exact ensure_hibiki_push contract.
# ---------------------------------------------------------------------------
check_throttle() {
  local label="$1" due_fn="$2" ensure_fn="$3" nextf="$STATE_DIR/$4" marker="$5"

  echo "--- $label: $due_fn (pure throttle decision) ---"
  rm -f "$nextf"
  "$due_fn"; assert_eq "$label: no state file -> due" 0 "$?"

  echo "$(( $(now) + 9999 ))" > "$nextf"
  "$due_fn"; assert_eq "$label: future .next -> throttled" 1 "$?"

  echo "$(( $(now) - 1 ))" > "$nextf"
  "$due_fn"; assert_eq "$label: past .next -> due" 0 "$?"

  echo "garbage" > "$nextf"
  "$due_fn"; assert_eq "$label: non-numeric .next -> due (treated as 0)" 0 "$?"

  echo "--- $label: $ensure_fn (fires, then throttles) ---"
  rm -f "$nextf"; : > "$CAPTURE"
  "$ensure_fn"
  [ -f "$nextf" ] && pass "$label: first call writes .next" || fail "$label: first call writes .next"
  grep -qF "$marker" "$CAPTURE" \
    && pass "$label: first call fires (dry-run)" || fail "$label: first call fires (dry-run)"
  local first_next; first_next="$(cat "$nextf")"

  : > "$CAPTURE"
  "$ensure_fn"
  grep -qF "$marker" "$CAPTURE" \
    && fail "$label: immediate re-call is throttled (should NOT fire)" \
    || pass "$label: immediate re-call is throttled (does not fire)"
  assert_eq "$label: .next unchanged while throttled" "$first_next" "$(cat "$nextf")"

  echo "$(( $(now) - 1 ))" > "$nextf"; : > "$CAPTURE"
  "$ensure_fn"
  grep -qF "$marker" "$CAPTURE" \
    && pass "$label: fires again after window elapses" || fail "$label: fires again after window elapses"

  [ "$(cat "$nextf")" -gt "$(now)" ] && pass "$label: throttle re-armed (.next in future)" \
    || fail "$label: throttle re-armed (.next in future)"
}

check_throttle "freshness" \
  freshness_check_due ensure_freshness_check "freshness-check.next" \
  "DRY-RUN would: todo-freshness-check.py"

check_throttle "token-expiry" \
  token_expiry_check_due ensure_token_expiry_check "token-expiry-check.next" \
  "DRY-RUN would: token-expiry-monitor.py --once"

echo ""
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
