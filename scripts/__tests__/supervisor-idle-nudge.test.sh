#!/bin/bash
# Unit tests for the ensure_idle_nudge_watch wiring in fleet-supervisor.sh
# (card 5899286b).
#
# Heavy logic (pane-string parse, DB obligation query, send-keys) is
# tested here only at the WIRING level: flag gate, throttle, dry-run guard.
# The pane-state predicate and obligation query are tested as pure bash
# functions by driving them with controlled inputs (mock pane content,
# mock DB). The e2e negative-fixture harness lives in Thor's card (845750ad).
#
# Run: bash scripts/__tests__/supervisor-idle-nudge.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { if echo "$3" | grep -q "$2"; then pass "$1"; else fail "$1 (expected '$2' in output)"; fi; }

# Source the supervisor with an isolated store. The source-guard skips the daemon.
export FLEET_SUPERVISOR_STORE="$TMP/store"
mkdir -p "$FLEET_SUPERVISOR_STORE"
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

CAPTURE="$TMP/log.txt"
: > "$CAPTURE"
log() { echo "$*" >> "$CAPTURE"; }

FLAG="$STORE/idle-nudge-watch.enabled"

# --- idle_nudge_watch_enabled: pure flag gate --------------------------------
rm -f "$FLAG"
idle_nudge_watch_enabled; assert_eq "no flag -> disabled" 1 "$?"
: > "$FLAG"
idle_nudge_watch_enabled; assert_eq "flag present -> enabled" 0 "$?"

# --- ensure_idle_nudge_watch: inert when flag is absent ----------------------
rm -f "$FLAG"; : > "$CAPTURE"
ensure_idle_nudge_watch; assert_eq "flag absent -> returns 0 (no-op)" 0 "$?"
if [ -s "$CAPTURE" ]; then
  fail "flag absent -> must not log/run anything"
else
  pass "flag absent -> no log, no run"
fi

# --- ensure_idle_nudge_watch: dry-run logs intent ----------------------------
: > "$FLAG"; : > "$CAPTURE"
ensure_idle_nudge_watch; assert_eq "flag + dry-run -> returns 0" 0 "$?"
assert_contains "dry-run logs intent" "DRY-RUN would: idle-nudge sweep" "$(cat "$CAPTURE")"
: > "$CAPTURE"

# --- ensure_idle_nudge_watch: throttle suppresses subsequent calls -----------
: > "$FLAG"
# Set the .next file to far in the future
echo $(( $(date +%s) + 9999 )) > "$STATE_DIR/idle-nudge.next"
: > "$CAPTURE"
ensure_idle_nudge_watch; assert_eq "future throttle stamp -> returns 0 (skipped)" 0 "$?"
if [ -s "$CAPTURE" ]; then
  fail "throttled tick must not log anything"
else
  pass "throttled tick suppressed"
fi

# --- ensure_idle_nudge_watch: elapsed throttle lets through ------------------
echo 0 > "$STATE_DIR/idle-nudge.next"
: > "$CAPTURE"
ensure_idle_nudge_watch; assert_eq "elapsed throttle -> dry-run fires" 0 "$?"
assert_contains "elapsed throttle -> dry-run logs" "DRY-RUN would" "$(cat "$CAPTURE")"

# --- pane_is_idle_at_prompt: REAL function via shared classifier (089e78db) ---
# Drives the ACTUAL pane_is_idle_at_prompt (which now delegates to
# pane_capture_classify in lib/pane-idle.sh) by overriding TMUX_BIN with a mock
# that emits controlled `capture-pane -e` (ANSI-preserved) content. Real captures
# + synthetic SGR, same mock-tmux pattern as pane_has_overloaded_error below.
_pane_content_file="$TMP/pane-e.txt"
_pane_mock_tmux="$TMP/mock-tmux-pane.sh"
cat > "$_pane_mock_tmux" << SCRIPT
#!/bin/bash
cat "$_pane_content_file"
SCRIPT
chmod +x "$_pane_mock_tmux"

assert_pane_idle() { # <label> <expected-rc> <raw-e-content>
  printf '%s' "$3" > "$_pane_content_file"
  local old="$TMUX_BIN"; TMUX_BIN="$_pane_mock_tmux"
  pane_is_idle_at_prompt "fake-session"; local rc=$?
  TMUX_BIN="$old"
  assert_eq "$1" "$2" "$rc"
}
_E=$'\x1b'; _CHEV=$'\xe2\x9d\xaf'; _NBSP=$'\xc2\xa0'
FIXDIR="$INSTALL_DIR/scripts/__tests__/fixtures/pane"

# Real empty composer (❯ + U+00A0 + cursor) -> idle. The OLD regex failed this
# (NBSP is not [[:space:]] under C.UTF-8) -- the core FINDING-2 regression.
assert_pane_idle "real empty composer -> idle" 0 "$(cat "$FIXDIR/real-empty-composer.txt")"
# Real ghost-text autosuggestion (faint SGR) -> idle
assert_pane_idle "real ghost-text autosuggestion -> idle" 0 "$(cat "$FIXDIR/real-ghosttext.txt")"
# esc-to-interrupt working bar -> NOT idle
assert_pane_idle "esc to interrupt -> not idle" 1 "$(printf '%s[39m%s%s%s[7m %s[0m\nesc to interrupt' "$_E" "$_CHEV" "$_NBSP" "$_E" "$_E")"
# Thinking -> NOT idle
assert_pane_idle "Thinking -> not idle" 1 "$(printf 'Thinking...\n%s[39m%s%s%s[7m %s[0m' "$_E" "$_CHEV" "$_NBSP" "$_E" "$_E")"
# Real typed input (normal intensity) -> NOT idle (must not nudge over live typing)
assert_pane_idle "real typed input -> not idle" 1 "$(printf '%s[39m%s%s%s[7ml%s[0mekerem a kartyat' "$_E" "$_CHEV" "$_NBSP" "$_E" "$_E")"

# --- IDLE_NUDGE_TEXT is a constant (Chad requirement) ------------------------
assert_eq "IDLE_NUDGE_TEXT is static constant" "Please continue your current task." "$IDLE_NUDGE_TEXT"

# --- idle-since file lifecycle -----------------------------------------------
# Grace period: idle-since file created on first detection
rm -f "$STATE_DIR/idle-since-test-agent"
now_ts=$(date +%s)
echo "$now_ts" > "$STATE_DIR/idle-since-test-agent"
idle_since=$(cat "$STATE_DIR/idle-since-test-agent")
assert_eq "idle-since file written correctly" "$now_ts" "$idle_since"

# File cleared on agent-becomes-working (rm -f)
rm -f "$STATE_DIR/idle-since-test-agent"
[ ! -f "$STATE_DIR/idle-since-test-agent" ]
assert_eq "idle-since removed on working" 0 "$?"

# Grace period not elapsed: no nudge
now_ts=$(date +%s)
echo "$now_ts" > "$STATE_DIR/idle-since-test-agent"  # just set
idle_age=$(( $(date +%s) - now_ts ))
[ "$idle_age" -lt "$IDLE_NUDGE_GRACE_SECONDS" ]
assert_eq "fresh idle-since -> grace period not elapsed" 0 "$?"

# --- pane_has_overloaded_error: detection-label predicate (card 7ede0997 / 0c567c29) ---
# Tests call the REAL pane_has_overloaded_error() (sourced above) -- no grep-mock.
# TMUX_BIN is overridden per-call to emit controlled pane content.

_mock_pane_content=""
_mock_tmux="$TMP/mock-tmux.sh"
_pane_content_file="$TMP/pane-content.txt"

# Build the mock tmux script once; it reads from _pane_content_file each call.
cat > "$_mock_tmux" << SCRIPT
#!/bin/bash
cat "$_pane_content_file"
SCRIPT
chmod +x "$_mock_tmux"

assert_overloaded() {
  local label="$1" expected="$2" content="$3"
  printf '%s' "$content" > "$_pane_content_file"
  local old_tmux="$TMUX_BIN"
  TMUX_BIN="$_mock_tmux"
  pane_has_overloaded_error "fake-session"
  local rc=$?
  TMUX_BIN="$old_tmux"
  assert_eq "$label" "$expected" "$rc"
}

# Positive: API Error: Overloaded header (primary TUI form)
assert_overloaded "API Error: Overloaded -> true" 0 "Some output
API Error: Overloaded
❯ "

# Positive: lowercase / case-insensitive variant
assert_overloaded "api error: overloaded (lowercase) -> true" 0 "api error: overloaded
❯ "

# Positive: narrative form 'is overloaded' (verb-anchored)
assert_overloaded "'is overloaded' narrative -> true" 0 "Claude claude-opus-4-8 is overloaded at the moment
❯ "

# Positive: 'is currently overloaded' form
assert_overloaded "'is currently overloaded' -> true" 0 "Claude is currently overloaded -- please retry
❯ "

# ADVERSARIAL FIXTURE 1 (false-positive): generic overload discussion must NOT trigger.
# "Claude handles overloaded queues" -- no verb 'is/was' before 'overloaded', no API Error.
assert_overloaded "AF1: discussion of overloaded systems -> false" 1 "I asked Claude about handling overloaded queues
The model handles overloaded scenarios gracefully
❯ "

# ADVERSARIAL FIXTURE 2 (false-positive): subject mentions Claude + overloaded but no verb anchor.
# "Claude's context window is large; overloaded_error type is 529" -- 'overloaded' in a type name,
# not preceded by ' is/was (currently)'.
assert_overloaded "AF2: 'overloaded_error' type name -> false" 1 "The overloaded_error type (529) is documented
Claude returns this when capacity is exceeded
❯ "

# ADVERSARIAL FIXTURE 3 (opposing-combination): benign Claude mention coexists with real API error.
# Must still return true because the API Error line matches independently.
assert_overloaded "AF3: benign Claude mention + real API Error -> true" 0 "Earlier: Claude discussed overloaded systems
Now: API Error: Overloaded (529)
❯ "

# --- TOTAL -------------------------------------------------------------------
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
else
  echo "$FAIL FAILED"
  exit 1
fi
