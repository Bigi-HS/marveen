#!/bin/bash
# Unit tests for ensure_main_channel_watchdog in fleet-supervisor.sh (card da737e92).
#
# The watchdog logic itself is covered by scripts/__tests__/channel-watchdog.test.sh.
# Here we only verify the supervisor WIRING: the pgrep-skip (keep a running --loop
# daemon, no double-launch) and the DRY-RUN guard, by sourcing the supervisor with an
# isolated store (the `if BASH_SOURCE == $0` guard skips the daemon) and driving the
# function directly with a stubbed pgrep.
#
# NOTE: fleet-supervisor.sh re-exports a curated PATH at source time, so the pgrep
# stub dir is prepended AFTER sourcing. A file-based stub (not a live process) keeps
# the pgrep match deterministic -- avoids the pgrep-test-poisoning false-match.
#
# Run: bash scripts/__tests__/supervisor-channel-watchdog.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

# Source the supervisor with an isolated store + DRY-RUN. The source-guard skips the daemon.
export FLEET_SUPERVISOR_STORE="$TMP/store"
mkdir -p "$FLEET_SUPERVISOR_STORE"
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

CAPTURE="$TMP/log.txt"; : > "$CAPTURE"
log() { echo "$*" >> "$CAPTURE"; }

# Stub pgrep (controlled by STUB_PGREP_RC) -- prepended AFTER source (PATH was
# re-exported at source time).
STUBBIN="$TMP/bin"; mkdir -p "$STUBBIN"
cat > "$STUBBIN/pgrep" <<'EOF'
#!/bin/bash
exit "${STUB_PGREP_RC:-1}"
EOF
chmod +x "$STUBBIN/pgrep"
export PATH="$STUBBIN:$PATH"

# --- pgrep finds a running --loop daemon -> keep it, no log, no launch ------
: > "$CAPTURE"
STUB_PGREP_RC=0 ensure_main_channel_watchdog
assert_eq "running daemon -> returns 0" 0 "$?"
if [ -s "$CAPTURE" ]; then fail "running daemon -> must not log/launch"; else pass "running daemon -> no log, no launch (pgrep-skip)"; fi

# --- not running + DRY-RUN -> logs the intent, never nohups ------------------
: > "$CAPTURE"
STUB_PGREP_RC=1 ensure_main_channel_watchdog
assert_eq "not running + dry-run -> returns 0" 0 "$?"
grep -q "DRY-RUN would: start channel-watchdog.sh --loop" "$CAPTURE" \
  && pass "not running + dry-run -> logs intent" || fail "not running + dry-run -> logs intent"
[ -f "$STORE/channel-watchdog.log" ] \
  && fail "dry-run must not spawn the real loop (log created)" \
  || pass "dry-run did not spawn the real loop"

# --- the watchdog script must be executable (else ensure silently does nothing) ---
[ -x "$INSTALL_DIR/scripts/channel-watchdog.sh" ] \
  && pass "channel-watchdog.sh is executable" || fail "channel-watchdog.sh is executable"

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
