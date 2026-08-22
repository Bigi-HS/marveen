#!/bin/bash
# Unit tests for the ensure_tailscaled wiring in fleet-supervisor.sh (card c2de413f).
#
# The heavy logic (daemon start, auth gate, serve re-apply) is covered hermetically
# by scripts/__tests__/ensure-tailscaled.test.py. Here we only verify the supervisor
# WIRING: the deploy-flag gate and the DRY-RUN guard, by sourcing the supervisor with
# an isolated store (the `if BASH_SOURCE == $0` guard keeps the daemon loop from
# running) and driving tailscale_serve_enabled / ensure_tailscaled directly.
#
# Run: bash scripts/__tests__/supervisor-ensure-tailscaled.test.sh
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

FLAG="$STORE/tailscale-serve.enabled"

# --- tailscale_serve_enabled: pure flag gate -------------------------------
rm -f "$FLAG"
tailscale_serve_enabled; assert_eq "no flag -> disabled" 1 "$?"
: > "$FLAG"
tailscale_serve_enabled; assert_eq "flag present -> enabled" 0 "$?"

# --- ensure_tailscaled: inert when the flag is absent -----------------------
rm -f "$FLAG"; : > "$CAPTURE"
ensure_tailscaled; assert_eq "flag absent -> ensure returns 0 (no-op)" 0 "$?"
if grep -q "ensure-tailscaled" "$CAPTURE"; then
  fail "flag absent -> must not log/run anything"
else
  pass "flag absent -> no log, no run"
fi

# --- ensure_tailscaled: DRY-RUN guard logs intent, never execs the script ---
# DRY_RUN is 1 because we sourced with --dry-run.
: > "$FLAG"; : > "$CAPTURE"
ensure_tailscaled; assert_eq "flag present + dry-run -> returns 0" 0 "$?"
grep -q "DRY-RUN would: run ensure-tailscaled.sh" "$CAPTURE" \
  && pass "dry-run logs the intent" || fail "dry-run logs the intent"

# Proof it did NOT exec the real script: no serve/daemon side effect, and the
# tailscaled log was never created under the isolated store.
if [ -f "$STORE/tailscaled.log" ]; then
  fail "dry-run must not invoke the real hook (tailscaled.log created)"
else
  pass "dry-run did not invoke the real hook"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
