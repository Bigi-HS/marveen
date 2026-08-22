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
MISMATCH_FILE="$STATE_DIR/cli-version-mismatch.txt"

# --- throttle: skip if next file is in the future ---------------------------
rm -f "$NEXT_FILE" "$VER_FILE"
echo $(( $(date +%s) + 9999 )) > "$NEXT_FILE"
: > "$CAPTURE"
ensure_cli_version_watch
assert_not_contains "future throttle -> no log output" "cli-version-watch" "$(cat "$CAPTURE")"

# --- first run: baseline recorded, no alert ---------------------------------
rm -f "$NEXT_FILE" "$VER_FILE" "$MISMATCH_FILE"
: > "$CAPTURE"
ensure_cli_version_watch
assert_contains "first run -> baseline logged" "baseline recorded" "$(cat "$CAPTURE")"
assert_eq "first run -> version file written" "2.1.200" "$(cat "$VER_FILE" 2>/dev/null)"
assert_not_contains "first run -> no alert" "HTTPS alert" "$(cat "$CAPTURE")"
assert_eq "first run -> no drift gate flagged (baseline is not a drift)" "" "$(cat "$MISMATCH_FILE" 2>/dev/null)"

# --- unchanged: no action after baseline ------------------------------------
# Reset throttle so it fires again
rm -f "$NEXT_FILE"
: > "$CAPTURE"
ensure_cli_version_watch
assert_not_contains "unchanged -> no log" "cli-version-watch" "$(cat "$CAPTURE")"

# --- version changed: logs + dry-run alert + sentinel written ----------------
rm -f "$NEXT_FILE" "$MISMATCH_FILE" "$STATE_DIR/cli-drift-alerts.jsonl"
echo "2.1.100" > "$VER_FILE"   # stored version is older than stub's 2.1.200
: > "$CAPTURE"
ensure_cli_version_watch
assert_contains "changed -> upgrade logged" "CLI changed 2.1.100 -> 2.1.200" "$(cat "$CAPTURE")"
assert_contains "changed -> c12 smoke mentioned" "c12" "$(cat "$CAPTURE")"
assert_contains "changed -> dry-run alert noted" "DRY-RUN would" "$(cat "$CAPTURE")"
assert_eq "changed -> version file updated to new" "2.1.200" "$(cat "$VER_FILE" 2>/dev/null)"
# Card 56ad0fa3: a drift flags the pane-detector gate so the watchdogs stand down.
assert_eq "changed -> drift gate flagged with new version" "2.1.200" "$(cat "$MISMATCH_FILE" 2>/dev/null)"
# Card ed4945a4: durable sentinel written even in dry-run (local file, no external side effect).
assert_contains "changed -> sentinel written" "cli-drift" "$(cat "$STATE_DIR/cli-drift-alerts.jsonl" 2>/dev/null)"
assert_contains "changed -> sentinel has correct to-version" "2.1.200" "$(cat "$STATE_DIR/cli-drift-alerts.jsonl" 2>/dev/null)"

# --- fallback token used when chad token absent (non-dry-run) ----------------
# Use $TMP as INSTALL_DIR so we never touch real credentials. Put the fallback
# token in $TMP/.env and provide no chad token file.
CURL_CALLS="$TMP/curl-calls.txt"
FAKE_CURL2="$TMP/curl-cap2"
# Unquoted heredoc: $CURL_CALLS expands now, embedding the abs path in the script.
cat > "$FAKE_CURL2" << CURLEOF
#!/bin/sh
for arg; do
  case "\$arg" in
    https://api.telegram.org/bot*/sendMessage) echo "\$arg" >> "$CURL_CALLS" ;;
  esac
done
exit 0
CURLEOF
chmod +x "$FAKE_CURL2"
# Fake INSTALL_DIR in $TMP: .env with marveen token, no agents/chad token
mkdir -p "$TMP/fake-install/store/.fleet-supervisor"
echo "TELEGRAM_BOT_TOKEN=marveen-fallback-token" > "$TMP/fake-install/.env"
_REAL_INSTALL="$INSTALL_DIR"
_REAL_STATE="$STATE_DIR"
_REAL_VER="$VER_FILE"
INSTALL_DIR="$TMP/fake-install"
STATE_DIR="$TMP/fake-install/store/.fleet-supervisor"
VER_FILE="$STATE_DIR/claude-cli-version.txt"
MISMATCH_FILE="$STATE_DIR/cli-version-mismatch.txt"
NEXT_FILE="$STATE_DIR/cli-version-check.next"
rm -f "$CURL_CALLS"
echo "2.1.100" > "$VER_FILE"
: > "$CAPTURE"
CURL="$FAKE_CURL2" DRY_RUN=0 ensure_cli_version_watch
# Restore
INSTALL_DIR="$_REAL_INSTALL"
STATE_DIR="$_REAL_STATE"
VER_FILE="$_REAL_VER"
MISMATCH_FILE="$STATE_DIR/cli-version-mismatch.txt"
NEXT_FILE="$STATE_DIR/cli-version-check.next"
assert_contains "fallback token -> logged" "fallback" "$(cat "$CAPTURE")"
assert_contains "fallback token -> curl used marveen token" "marveen-fallback-token" "$(cat "$CURL_CALLS" 2>/dev/null)"

# --- claude not on PATH: silent no-op --------------------------------------
# CLAUDE_BIN_OVERRIDE="" forces the empty-bin path without depending on PATH manipulation
# (the supervisor sets its own PATH that includes the real claude binary, so PATH tricks
# are unreliable in tests). Same env-override pattern as FLEET_SUPERVISOR_STORE.
rm -f "$NEXT_FILE" "$VER_FILE"
: > "$CAPTURE"
CLAUDE_BIN_OVERRIDE="" ensure_cli_version_watch
assert_not_contains "claude not on PATH -> silent no-op" "cli-version-watch" "$(cat "$CAPTURE")"
assert_eq "claude not on PATH -> version file not created" "" "$(cat "$VER_FILE" 2>/dev/null)"

# --- claude bin exists but exits non-zero (broken install): silent no-op ----
BROKEN_BIN="$TMP/claude-broken"
echo '#!/bin/sh
exit 1' > "$BROKEN_BIN"; chmod +x "$BROKEN_BIN"
rm -f "$NEXT_FILE" "$VER_FILE"
: > "$CAPTURE"
CLAUDE_BIN_OVERRIDE="$BROKEN_BIN" ensure_cli_version_watch
assert_not_contains "broken claude -> silent no-op" "cli-version-watch" "$(cat "$CAPTURE")"

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
