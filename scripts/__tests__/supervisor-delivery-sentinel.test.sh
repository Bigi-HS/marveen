#!/bin/bash
# Unit tests for the ensure_delivery_sentinel_watch wiring in fleet-supervisor.sh
# (card d37df625).
#
# The heavy logic (sentinel parse, escalation decision, cursor advance) is
# covered by the TS unit tests (delivery-sentinel-consumer.test.ts). Here we
# only verify the supervisor WIRING: the deploy-flag gate, the missing-CLI skip,
# the throttle, and the DRY-RUN guard, by sourcing the supervisor with an
# isolated store (the `if BASH_SOURCE == $0` guard keeps the daemon loop from
# running) and driving the functions directly.
#
# Run: bash scripts/__tests__/supervisor-delivery-sentinel.test.sh
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
mkdir -p "$FLEET_SUPERVISOR_STORE"
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

CAPTURE="$TMP/log.txt"
: > "$CAPTURE"
log() { echo "$*" >> "$CAPTURE"; }

FLAG="$STORE/delivery-sentinel-watch.enabled"

# --- delivery_sentinel_watch_enabled: pure flag gate -----------------------
rm -f "$FLAG"
delivery_sentinel_watch_enabled; assert_eq "no flag -> disabled" 1 "$?"
: > "$FLAG"
delivery_sentinel_watch_enabled; assert_eq "flag present -> enabled" 0 "$?"

# --- ensure_delivery_sentinel_watch: inert when the flag is absent ---------
rm -f "$FLAG"; : > "$CAPTURE"
ensure_delivery_sentinel_watch; assert_eq "flag absent -> returns 0 (no-op)" 0 "$?"
if [ -s "$CAPTURE" ]; then
  fail "flag absent -> must not log/run anything"
else
  pass "flag absent -> no log, no run"
fi

# --- flag present but CLI not built -> skips with a log, never spawns node --
: > "$FLAG"; : > "$CAPTURE"
# Ensure the dist CLI is absent under the isolated INSTALL_DIR view by pointing
# the check at a build that does not exist: the real INSTALL_DIR may or may not
# have dist/, so assert behaviour for BOTH branches explicitly below.
if [ -f "$INSTALL_DIR/dist/delivery-sentinel-cli.js" ]; then
  # dist present -> dry-run path: logs intent, never execs node.
  ensure_delivery_sentinel_watch; assert_eq "flag + dist + dry-run -> returns 0" 0 "$?"
  grep -q "DRY-RUN would: node dist/delivery-sentinel-cli.js" "$CAPTURE" \
    && pass "dry-run logs the intent" || fail "dry-run logs the intent"
  [ -f "$STORE/delivery-sentinel.log" ] \
    && fail "dry-run must not invoke the real CLI (log created)" \
    || pass "dry-run did not invoke the real CLI"
else
  # dist absent -> missing-CLI skip.
  ensure_delivery_sentinel_watch; assert_eq "flag + no dist -> returns 0" 0 "$?"
  grep -q "delivery-sentinel-cli.js missing" "$CAPTURE" \
    && pass "missing CLI logs a skip" || fail "missing CLI logs a skip"
fi

# --- throttle: a future .next stamp suppresses the run ----------------------
# Build a stub CLI so the missing-CLI branch does not short-circuit the throttle.
mkdir -p "$STORE/.fleet-supervisor"
STUB_DIST="$TMP/install/dist"; mkdir -p "$STUB_DIST"
: > "$STUB_DIST/delivery-sentinel-cli.js"
# Re-source with INSTALL_DIR pointed at the stub tree so the CLI check passes.
# (INSTALL_DIR is derived at source time; override it directly for this check.)
INSTALL_DIR_SAVE="$INSTALL_DIR"
INSTALL_DIR="$TMP/install"
: > "$FLAG"; : > "$CAPTURE"
echo $(( $(date +%s) + 9999 )) > "$STATE_DIR/delivery-sentinel.next"
ensure_delivery_sentinel_watch; assert_eq "future throttle stamp -> returns 0 (skipped)" 0 "$?"
if grep -q "DRY-RUN would: node" "$CAPTURE"; then
  fail "throttled tick must not run"
else
  pass "throttled tick suppressed"
fi
# Elapsed throttle -> dry-run path fires.
: > "$CAPTURE"
echo 1 > "$STATE_DIR/delivery-sentinel.next"   # far past
ensure_delivery_sentinel_watch >/dev/null 2>&1
grep -q "DRY-RUN would: node" "$CAPTURE" \
  && pass "elapsed throttle -> dry-run fires" || fail "elapsed throttle -> dry-run fires"
INSTALL_DIR="$INSTALL_DIR_SAVE"

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
