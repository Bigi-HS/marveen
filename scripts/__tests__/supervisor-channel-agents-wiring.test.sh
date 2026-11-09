#!/bin/bash
# Unit tests for ensure_channel_watchdogs in fleet-supervisor.sh (card 793963f8 step 2).
#
# Verifies the supervisor wiring for per-agent channel watchdogs:
#   - servo-skull-watchdog.sh is in the ensure_channel_watchdogs agent list
#   - servo-skull-watchdog.sh exists and is executable
#   - pgrep-skip: running watchdog -> no relaunch (no double-spawn)
#   - DRY-RUN: not running + dry-run -> logs intent, no real spawn
#
# Pattern mirrors supervisor-channel-watchdog.test.sh (ensure_main_channel_watchdog).
# Run: bash scripts/__tests__/supervisor-channel-agents-wiring.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

export FLEET_SUPERVISOR_STORE="$TMP/store"
mkdir -p "$FLEET_SUPERVISOR_STORE"
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

CAPTURE="$TMP/log.txt"; : > "$CAPTURE"
log() { echo "$*" >> "$CAPTURE"; }

# Stub pgrep (controlled by STUB_PGREP_RC) -- prepended AFTER source.
STUBBIN="$TMP/bin"; mkdir -p "$STUBBIN"
cat > "$STUBBIN/pgrep" <<'EOF'
#!/bin/bash
exit "${STUB_PGREP_RC:-1}"
EOF
chmod +x "$STUBBIN/pgrep"
export PATH="$STUBBIN:$PATH"

# --- servo-skull-watchdog.sh exists and is executable -----------------------
[ -f "$INSTALL_DIR/scripts/servo-skull-watchdog.sh" ] \
  && pass "servo-skull-watchdog.sh exists" \
  || fail "servo-skull-watchdog.sh exists"
[ -x "$INSTALL_DIR/scripts/servo-skull-watchdog.sh" ] \
  && pass "servo-skull-watchdog.sh is executable" \
  || fail "servo-skull-watchdog.sh is executable"

# --- servo-skull in ensure_channel_watchdogs agent list (source code check) -
grep -q "servo-skull" "$INSTALL_DIR/scripts/fleet-supervisor.sh" \
  && pass "servo-skull present in fleet-supervisor.sh" \
  || fail "servo-skull present in fleet-supervisor.sh"
grep "ensure_channel_watchdogs" -A 3 "$INSTALL_DIR/scripts/fleet-supervisor.sh" \
  | grep -q "servo-skull" \
  && pass "servo-skull in ensure_channel_watchdogs for-loop" \
  || fail "servo-skull in ensure_channel_watchdogs for-loop"

# --- pgrep-skip: running watchdog -> no relaunch ----------------------------
: > "$CAPTURE"
STUB_PGREP_RC=0 ensure_channel_watchdogs
if [ -s "$CAPTURE" ]; then fail "running watchdogs -> must not log/relaunch"; else pass "running watchdogs -> pgrep-skip, no log"; fi

# --- DRY-RUN: not running + dry-run -> logs intent, no real spawn -----------
: > "$CAPTURE"
STUB_PGREP_RC=1 ensure_channel_watchdogs
grep -q "DRY-RUN would: start servo-skull-watchdog.sh" "$CAPTURE" \
  && pass "not running + dry-run -> logs servo-skull intent" \
  || fail "not running + dry-run -> logs servo-skull intent"
[ -f "$FLEET_SUPERVISOR_STORE/servo-skull-watchdog.log" ] \
  && fail "dry-run must not spawn (log file created)" \
  || pass "dry-run did not spawn (no log file)"

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
