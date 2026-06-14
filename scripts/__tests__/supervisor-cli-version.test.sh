#!/bin/bash
# Unit tests for ensure_cli_version_watch (card b1739f30).
#
# Tests the pure state-machine behaviour: throttle, first-run baseline,
# version-unchanged no-op, and version-changed alert path. The actual
# `claude --version` binary and the Telegram HTTPS call are stubbed.
#
# Run: bash scripts/__tests__/supervisor-cli-version.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq()       { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { if echo "$3" | grep -q "$2"; then pass "$1"; else fail "$1 (expected '$2' in output)"; fi; }
assert_not_contains() { if echo "$3" | grep -q "$2"; then fail "$1 (unexpected '$2' in output)"; else pass "$1"; fi; }

# --- Source supervisor with isolated store ----------------------------------
export FLEET_SUPERVISOR_STORE="$TMP/store"
mkdir -p "$FLEET_SUPERVISOR_STORE"
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

CAPTURE="$TMP/log.txt"
: > "$CAPTURE"
log() { echo "$*" >> "$CAPTURE"; }

# Stub `claude` binary: controlled version output
FAKE_CLAUDE="$TMP/claude"
echo '#!/bin/sh
echo "2.1.200 (Claude Code)"' > "$FAKE_CLAUDE"
chmod +x "$FAKE_CLAUDE"

# Override PATH so `command -v claude` finds our stub
export PATH="$TMP:$PATH"

VER_FILE="$STATE_DIR/claude-cli-version.txt"
NEXT_FILE="$STATE_DIR/cli-version-check.next"

# --- throttle: skip if next file is in the future ---------------------------
rm -f "$NEXT_FILE" "$VER_FILE"
echo $(( $(date +%s) + 9999 )) > "$NEXT_FILE"
: > "$CAPTURE"
ensure_cli_version_watch
assert_not_contains "future throttle -> no log output" "cli-version-watch" "$(cat "$CAPTURE")"

# --- first run: baseline recorded, no alert ---------------------------------
rm -f "$NEXT_FILE" "$VER_FILE"
: > "$CAPTURE"
ensure_cli_version_watch
assert_contains "first run -> baseline logged" "baseline recorded" "$(cat "$CAPTURE")"
assert_eq "first run -> version file written" "2.1.200" "$(cat "$VER_FILE" 2>/dev/null)"
assert_not_contains "first run -> no alert" "HTTPS alert" "$(cat "$CAPTURE")"

# --- unchanged: no action after baseline ------------------------------------
# Reset throttle so it fires again
rm -f "$NEXT_FILE"
: > "$CAPTURE"
ensure_cli_version_watch
assert_not_contains "unchanged -> no log" "cli-version-watch" "$(cat "$CAPTURE")"

# --- version changed: logs + dry-run alert -----------------------------------
rm -f "$NEXT_FILE"
echo "2.1.100" > "$VER_FILE"   # stored version is older than stub's 2.1.200
: > "$CAPTURE"
ensure_cli_version_watch
assert_contains "changed -> upgrade logged" "CLI changed 2.1.100 -> 2.1.200" "$(cat "$CAPTURE")"
assert_contains "changed -> c12 smoke mentioned" "c12" "$(cat "$CAPTURE")"
assert_contains "changed -> dry-run alert noted" "DRY-RUN would" "$(cat "$CAPTURE")"
assert_eq "changed -> version file updated to new" "2.1.200" "$(cat "$VER_FILE" 2>/dev/null)"

# --- corrupt stored version: treated as empty / unknown ---------------------
rm -f "$NEXT_FILE"
echo "not-a-version!" > "$VER_FILE"
: > "$CAPTURE"
ensure_cli_version_watch
assert_contains "corrupt stored -> upgrade logged" "CLI changed" "$(cat "$CAPTURE")"

# --- TOTAL ------------------------------------------------------------------
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
else
  echo "$FAIL FAILED"
  exit 1
fi
