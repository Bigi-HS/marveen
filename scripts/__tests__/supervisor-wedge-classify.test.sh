#!/bin/bash
# Bash integration tests for fleet_wedge_sweep G1/G2/G6 pane classification
# via the canonical node CLI (dist/pane-classify-cli.js, card c72ec834).
#
# Adversarial focus:
#   - G2: "weekly limit" prose in scrollback -> NOT G2 (bare-substring FP root cause)
#   - G2: real limit menu in tail-18 -> G2
#   - G6: survey modal in tail-10 -> G6
#   - G6: survey phrase scrolled away (>10 lines) -> NOT G6
#   - G1: "Press Enter" in tail -> G1
#   - G1: "Press Enter" only in scrollback -> NOT G1 (tail-scope fix)
#
# Run: bash scripts/__tests__/supervisor-wedge-classify.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Guard: require dist/pane-classify-cli.js (built by tsc; always present in
# c12 context since c12 builds first). Run `npm run build` before standalone.
# ---------------------------------------------------------------------------
CLI="$INSTALL_DIR/dist/pane-classify-cli.js"
if [ ! -f "$CLI" ]; then
  echo "SKIP: $CLI not found -- run 'npm run build' first"
  exit 0
fi
NODE="$(command -v node)"

# ---------------------------------------------------------------------------
# Unit-level: test classifyPane output directly via node SINGLE mode.
# These are the core adversarial fixtures from the card spec.
# ---------------------------------------------------------------------------

classify_single() {
  printf '%s' "$1" | "$NODE" "$CLI" --pane 2>/dev/null | tr -d '\n'
}

# Pad a string with N blank lines above it (push it into scrollback).
in_scrollback() {
  local content="$1" n="${2:-20}"
  local padding
  padding=$(printf '%0.s\n' $(seq 1 $n))
  printf '%s\n%s' "$padding" "$content"
}

IDLE_FOOTER=$'\n? for shortcuts'
LIMIT_MENU_TAIL="You've reached your usage limit
Stop and wait for limit to reset
Upgrade to Pro"
SURVEY_TAIL="How is Claude doing this session? (optional)
1. Amazing  2. Good  3. Meh"
ENTER_TAIL="Compiling project...
Press Enter to continue"

# --- G2 adversarial ---
echo "--- ADV-G2-1: 'weekly limit' prose in scrollback -> NOT limit ---"
pane=$(in_scrollback "The weekly limit is 100 requests per day." 25)
result=$(classify_single "$pane$IDLE_FOOTER")
[ "$result" != "limit" ] && pass "ADV-G2-1: scrollback weekly-limit prose NOT limit (got: $result)" \
  || fail "ADV-G2-1: scrollback weekly-limit prose NOT limit (got: $result)"

echo "--- ADV-G2-1b: 'credit' and 'budget' prose in scrollback -> NOT limit ---"
pane=$(in_scrollback "Your credit balance and budget allocation are fine." 25)
result=$(classify_single "$pane$IDLE_FOOTER")
[ "$result" != "limit" ] && pass "ADV-G2-1b: scrollback credit/budget prose NOT limit (got: $result)" \
  || fail "ADV-G2-1b: scrollback credit/budget prose NOT limit (got: $result)"

echo "--- ADV-G2-2: real limit menu in tail -> limit ---"
result=$(classify_single "$(in_scrollback 'Some output' 5)
$LIMIT_MENU_TAIL")
[ "$result" = "limit" ] && pass "ADV-G2-2: real limit menu -> limit" \
  || fail "ADV-G2-2: real limit menu -> limit (got: $result)"

# --- G6 adversarial ---
echo "--- ADV-G6-1: survey in tail-10 -> survey ---"
result=$(classify_single "$(in_scrollback 'Some output' 5)
$SURVEY_TAIL")
[ "$result" = "survey" ] && pass "ADV-G6-1: survey in tail -> survey" \
  || fail "ADV-G6-1: survey in tail -> survey (got: $result)"

echo "--- ADV-G6-2: survey scrolled away (>10 lines above) -> NOT survey ---"
# Survey is in the first 2 lines; then 20 lines of output push it out of tail-10.
pane_g62=$(printf '%s\n' "$SURVEY_TAIL"; for i in $(seq 1 20); do echo "Output line $i"; done; echo "? for shortcuts")
result=$(classify_single "$pane_g62")
[ "$result" != "survey" ] && pass "ADV-G6-2: dismissed survey NOT survey (got: $result)" \
  || fail "ADV-G6-2: dismissed survey NOT survey (got: $result)"

echo "--- ADV-G6-3: 'survey-modal-recovery.js' filename -> NOT survey ---"
result=$(classify_single "Editing src/survey-modal-recovery.js
> ")
[ "$result" != "survey" ] && pass "ADV-G6-3: filename not survey (got: $result)" \
  || fail "ADV-G6-3: filename not survey (got: $result)"

# --- G1 adversarial ---
echo "--- ADV-G1-1: 'Press Enter' in tail -> enter ---"
result=$(classify_single "$(in_scrollback 'Some output' 5)
$ENTER_TAIL")
[ "$result" = "enter" ] && pass "ADV-G1-1: Press Enter in tail -> enter" \
  || fail "ADV-G1-1: Press Enter in tail -> enter (got: $result)"

echo "--- ADV-G1-2: 'Press Enter' in scrollback only -> NOT enter ---"
# Enter-prompt in first line; then 20 lines of output push it out of tail-10.
pane_g12=$(printf 'Press Enter to start the process.\n'; for i in $(seq 1 20); do echo "Output line $i"; done; echo "? for shortcuts")
result=$(classify_single "$pane_g12")
[ "$result" != "enter" ] && pass "ADV-G1-2: dismissed Press Enter NOT enter (got: $result)" \
  || fail "ADV-G1-2: dismissed Press Enter NOT enter (got: $result)"

# --- SINGLE mode fail-safe ---
echo "--- FAIL-SAFE: corrupt input -> unknown, exit 0 ---"
result=$(printf '\x00\xff\xfe' | "$NODE" "$CLI" --pane 2>/dev/null; echo $?)
# Last token after newline is the exit code
exit_code="${result##*$'\n'}"
state_token=$(printf '%s' "$result" | head -1)
[ "$state_token" = "unknown" ] && pass "FAIL-SAFE: corrupt -> unknown" \
  || fail "FAIL-SAFE: corrupt -> unknown (got: $state_token)"

# --- BATCH mode ---
echo "--- BATCH: multi-agent JSON -> correct states ---"
batch_input=$(cat <<'JSON'
{
  "a1": "Stop and wait for limit to reset\n",
  "a2": "How is Claude doing this session?\n",
  "a3": "Normal output\n> "
}
JSON
)
batch_output=$(printf '%s' "$batch_input" | "$NODE" "$CLI" 2>/dev/null)
a1_state=$(printf '%s' "$batch_output" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('a1','?'))" 2>/dev/null)
a2_state=$(printf '%s' "$batch_output" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('a2','?'))" 2>/dev/null)
a3_state=$(printf '%s' "$batch_output" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('a3','?'))" 2>/dev/null)
[ "$a1_state" = "limit" ] && pass "BATCH a1: limit" || fail "BATCH a1: limit (got: $a1_state)"
[ "$a2_state" = "survey" ] && pass "BATCH a2: survey" || fail "BATCH a2: survey (got: $a2_state)"
# a3 is a non-CC pane (no structural input box) -> unknown (healthy, not a wedge state)
[[ "$a3_state" != "limit" && "$a3_state" != "survey" && "$a3_state" != "enter" ]] \
  && pass "BATCH a3: healthy (not a wedge state, got: $a3_state)" \
  || fail "BATCH a3: healthy (not a wedge state, got: $a3_state)"

# ---------------------------------------------------------------------------
# Integration: fleet_wedge_sweep with fake tmux + real node CLI
# ---------------------------------------------------------------------------
echo ""
echo "--- Integration: fleet_wedge_sweep with batch classify ---"

export FLEET_SUPERVISOR_STORE="$TMP/store"
export FLEET_WEDGE_SWEEP_INTERVAL=0   # always due in tests
export INSTALL_DIR
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1
DRY_RUN=0

LOGFILE="$TMP/sweep.log"

# Fake tmux: reads pane content from $FAKE_PANE_DIR/<agent> based on -t arg.
FAKE_PANE_DIR="$TMP/panes"
export FAKE_PANE_DIR
mkdir -p "$FAKE_PANE_DIR"

FAKE_TMUX="$TMP/fake-tmux.sh"
cat > "$FAKE_TMUX" <<'SCRIPT'
#!/bin/bash
# Fake tmux capture-pane: output canned pane file based on -t session arg.
while [ $# -gt 0 ]; do
  case "$1" in
    -t) SESSION="$2"; shift 2 ;;
    *) shift ;;
  esac
done
AGENT="${SESSION#=agent-}"
AGENT="${AGENT%:0.0}"
cat "$FAKE_PANE_DIR/$AGENT" 2>/dev/null || echo "> "
SCRIPT
chmod +x "$FAKE_TMUX"

log() { echo "$*" >> "$LOGFILE"; }
session_alive() { return 0; }
is_sleep_eligible() { return 1; }
wedge_sleep_suppress() { return 1; }  # never suppress in these tests

# INT-1: "weekly limit" prose in scrollback -> NOT G2
echo "--- INT-1: scrollback weekly-limit -> NOT G2 ---"
: > "$LOGFILE"
TMUX_BIN="$FAKE_TMUX"
export FLEET_TEST_SWEEP_AGENTS="testA"
# 25 lines of scrollback containing "weekly limit", then idle footer
{
  for i in $(seq 1 25); do echo "Line $i: your weekly limit discussion"; done
  echo "? for shortcuts"
} > "$FAKE_PANE_DIR/testA"

fleet_wedge_sweep
grep -qF "testA:G2" "$LOGFILE" \
  && fail "INT-1: scrollback weekly-limit -> NOT G2 (was flagged G2)" \
  || pass "INT-1: scrollback weekly-limit -> NOT G2"

# INT-2: real limit menu -> G2
echo "--- INT-2: real limit menu -> G2 ---"
: > "$LOGFILE"
export FLEET_TEST_SWEEP_AGENTS="testB"
{
  echo "Some normal output"
  echo "Stop and wait for limit to reset"
  echo "Upgrade to Pro"
} > "$FAKE_PANE_DIR/testB"

fleet_wedge_sweep
grep -qF "testB:G2" "$LOGFILE" \
  && pass "INT-2: real limit menu -> G2" \
  || fail "INT-2: real limit menu -> G2 (not flagged)"

# INT-3: survey in tail -> G6
echo "--- INT-3: survey in tail -> G6 ---"
: > "$LOGFILE"
export FLEET_TEST_SWEEP_AGENTS="testC"
{
  echo "Working..."
  echo "How is Claude doing this session? (optional)"
  echo "1. Amazing  2. Good  3. Meh"
} > "$FAKE_PANE_DIR/testC"

fleet_wedge_sweep
grep -qF "testC:G6" "$LOGFILE" \
  && pass "INT-3: survey in tail -> G6" \
  || fail "INT-3: survey in tail -> G6 (not flagged)"

# INT-4: survey in scrollback only -> NOT G6
echo "--- INT-4: survey scrolled away -> NOT G6 ---"
: > "$LOGFILE"
export FLEET_TEST_SWEEP_AGENTS="testD"
{
  echo "How is Claude doing this session? (optional)"
  for i in $(seq 1 20); do echo "Output line $i"; done
  echo "? for shortcuts"
} > "$FAKE_PANE_DIR/testD"

fleet_wedge_sweep
grep -qF "testD:G6" "$LOGFILE" \
  && fail "INT-4: survey scrolled away -> NOT G6 (was flagged G6)" \
  || pass "INT-4: survey scrolled away -> NOT G6"

# INT-5: login chrome in scrollback only -> NOT G3 (no wedge flag)
echo "--- INT-5: login chrome scrolled away -> NOT G3 ---"
: > "$LOGFILE"
export FLEET_TEST_SWEEP_AGENTS="testE"
{
  echo "Esc to cancel"
  echo "Paste code here:"
  for i in $(seq 1 20); do echo "Output line $i"; done
  echo "? for shortcuts"
} > "$FAKE_PANE_DIR/testE"

fleet_wedge_sweep
# G3 is not wired to a wedge class (login -> * healthy by-design; TODO: wire as G3 when scoped).
# Verify no G3 flag appears (not a regression from scope-expansion).
grep -qF "testE:G3" "$LOGFILE" \
  && fail "INT-5: login chrome in scrollback -> NOT G3 (was flagged G3)" \
  || pass "INT-5: login chrome in scrollback -> NOT G3 (healthy as expected)"

# INT-6 (optional): degraded fallback when NODE is unavailable
echo "--- INT-6: NODE unavailable -> degraded bare-substring fallback ---"
: > "$LOGFILE"
export FLEET_TEST_SWEEP_AGENTS="testF"
{
  echo "Stop and wait for limit to reset"
} > "$FAKE_PANE_DIR/testF"

_saved_node="$NODE"
NODE="/nonexistent-node"
fleet_wedge_sweep
NODE="$_saved_node"
# Fallback bare-substring: "Stop and wait for limit to reset" matches *"Usage limit"*? No.
# But it would match the fallback pattern ONLY if one of the bare-substring patterns is present.
# "Stop and wait for limit to reset" does NOT contain "Usage limit"/"weekly limit"/"credit"/"budget".
# So fallback returns healthy. Verify no false G2 (degrade-safe).
grep -qF "testF:G2" "$LOGFILE" \
  && fail "INT-6: degraded fallback no false G2 (was flagged)" \
  || pass "INT-6: degraded fallback: no G2 for STRONG-only pattern (fallback safe)"

# ---------------------------------------------------------------------------
echo ""
echo "Results: $FAIL failure(s)"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
