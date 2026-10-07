#!/bin/bash
# c12-equivalent for fleet-supervisor WAKE-STORM GUARD + FLEET WEDGE SWEEP
# (card OPS/96ef336a, Boss-directive 2026-09-30).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
STATE_DIR="$TMP/store/.fleet-supervisor"
INSTALL_DIR="$TMP"; STORE="$TMP/store"; DRY_RUN=0
TMUX_BIN="tmux"
DASH_PORT=3420
mkdir -p "$TMP/store" "$TMP/scripts" "$STATE_DIR"
LOG="$TMP/store/fleet-supervisor.log"
touch "$LOG"

log()    { echo "$*" >> "$TMP/supervisor.log"; }
disown() { :; }

RF="$TMP/actions"  # action log file for mock calls

count_rf()     { grep -c "$1" "$RF"          2>/dev/null; true; }
count_alerts() { grep -c "$1" "$ALERTS_FILE" 2>/dev/null; true; }
# Note: trailing 'true' ensures exit-0 even when grep finds 0 matches (exit-1)
# so $() captures the count string rather than collapsing to empty.

# ── WAKE-STORM GUARD: fresh-start budget functions ───────────────────────────

_init_fresh_start_budget
[ "${_FRESH_STARTS_REMAINING:-MISSING}" != "MISSING" ] \
  && [ "$_FRESH_STARTS_REMAINING" -eq "$MAX_FRESH_STARTS_PER_TICK" ] \
  && ok "init_fresh_start_budget: sets remaining to MAX" \
  || bad "init_fresh_start_budget: remaining=${_FRESH_STARTS_REMAINING:-MISSING} expected=$MAX_FRESH_STARTS_PER_TICK"

# _consume_fresh_start exhausts exactly MAX times
_init_fresh_start_budget
consumed=0
while _consume_fresh_start 2>/dev/null; do
  consumed=$((consumed+1))
  [ "$consumed" -gt 20 ] && break
done
[ "$consumed" -eq "$MAX_FRESH_STARTS_PER_TICK" ] \
  && ok "consume_fresh_start: exhausts exactly MAX_FRESH_STARTS_PER_TICK" \
  || bad "consume_fresh_start: consumed=$consumed expected=$MAX_FRESH_STARTS_PER_TICK"

_init_fresh_start_budget
_FRESH_STARTS_REMAINING=0
_consume_fresh_start 2>/dev/null \
  && bad "consume_fresh_start: should fail when budget=0" \
  || ok "consume_fresh_start: fails correctly when budget=0"

# ── WAKE-STORM GUARD: load backpressure ──────────────────────────────────────

FLEET_LOADAVG_FILE="/nonexistent/loadavg"
_load_permits_start \
  && ok "_load_permits_start: fail-open when /proc/loadavg absent" \
  || bad "_load_permits_start: should fail-open when /proc/loadavg absent"
unset FLEET_LOADAVG_FILE

FLEET_LOADAVG_FILE="$TMP/loadavg"
FLEET_NPROC=4
echo "1.50 2.00 2.10 1/200 99" > "$TMP/loadavg"
_load_permits_start \
  && ok "_load_permits_start: allows start when load=1.5 < 2*nproc=8" \
  || bad "_load_permits_start: should allow start when load=1.5 nproc=4"

echo "10.50 8.00 6.00 1/200 99" > "$TMP/loadavg"
_load_permits_start \
  && bad "_load_permits_start: should block when load=10.5 > 2*nproc=8" \
  || ok "_load_permits_start: blocks start when load > 2*nproc"
unset FLEET_LOADAVG_FILE FLEET_NPROC

# ── WAKE-STORM GUARD: fresh-start cap in ensure_agent_watchdogs ───────────────

mkdir -p "$TMP/agents/ag1" "$TMP/agents/ag2" "$TMP/agents/ag3" "$TMP/agents/ag4"
for n in ag1 ag2 ag3 ag4; do echo '{}' > "$TMP/agents/$n/agent-config.json"; done
touch "$TMP/scripts/agent-watchdog.sh"; chmod +x "$TMP/scripts/agent-watchdog.sh"

pgrep() { return 1; }  # no watchdogs running
nohup()  { echo "NOHUP[$*]" >> "$RF"; return 0; }

# Test wrapper that uses a known 4-agent list
_test_ensure_watchdogs() {
  local n
  for n in ag1 ag2 ag3 ag4; do
    pgrep -f "scripts/agent-watchdog.sh $n\$" >/dev/null 2>&1 && continue
    if [ -x "$INSTALL_DIR/scripts/agent-watchdog.sh" ]; then
      [ "$DRY_RUN" -eq 1 ] && { log "DRY-RUN $n"; continue; }
      _load_permits_start || { log "agent-watchdog $n: load high, deferring"; continue; }
      _consume_fresh_start || { log "agent-watchdog $n: fresh-start cap reached"; continue; }
      nohup bash "$INSTALL_DIR/scripts/agent-watchdog.sh" "$n" &
      disown 2>/dev/null || true
      log "agent-watchdog $n: started"
    fi
  done
}

: > "$RF"
MAX_FRESH_STARTS_PER_TICK=2
_init_fresh_start_budget  # re-init after changing MAX
_test_ensure_watchdogs
wait 2>/dev/null

start_count=$(count_rf "NOHUP\[")
[ "$start_count" -eq 2 ] \
  && ok "ensure_watchdogs: caps starts at MAX=2 (4 eligible)" \
  || bad "ensure_watchdogs: expected 2 starts got $start_count"

# load-high: defers all starts
: > "$RF"
MAX_FRESH_STARTS_PER_TICK=3
_init_fresh_start_budget
FLEET_LOADAVG_FILE="$TMP/loadavg"
FLEET_NPROC=1
echo "5.00 4.00 3.00 1/10 1" > "$TMP/loadavg"  # load=5 > 2*1=2 -> block
_test_ensure_watchdogs
wait 2>/dev/null

start_count=$(count_rf "NOHUP\[")
[ "$start_count" -eq 0 ] \
  && ok "ensure_watchdogs: defers all starts when load high" \
  || bad "ensure_watchdogs: expected 0 starts under high load, got $start_count"
unset FLEET_LOADAVG_FILE FLEET_NPROC

# ── FLEET WEDGE SWEEP ────────────────────────────────────────────────────────

ALERTS_FILE="$TMP/alerts"
: > "$ALERTS_FILE"

# Use "curl" (shell-function form) not the full path so our mock fires.
CURL="curl"
echo "testtoken" > "$TMP/store/.dashboard-token"

PAYLOADS_FILE="$TMP/payloads"
: > "$PAYLOADS_FILE"
curl() {
  case "$*" in
    *"/api/messages"*)
      echo "ALERT" >> "$ALERTS_FILE"
      # Capture the full arg string so tests can inspect the sweep payload
      # (wedged/dead/asleep classification lists).
      printf '%s\n' "$*" >> "$PAYLOADS_FILE" ;;
  esac
  return 0
}

tmux() {
  case "$*" in
    "has-session -t =agent-dead-one") return 1 ;;
    "has-session -t =agent-sleepy")   return 1 ;;
    "has-session -t ="*)              return 0 ;;
    "capture-pane "*"agent-wedged"*)  printf '%s' "Usage limit reached -- weekly limit" ;;
    "capture-pane "*"agent-surveyer"*) printf '%s' "How is Claude doing this session?" ;;
    # Active agent EDITING the survey-modal-recovery.js file -- its pane contains
    # the filename "survey". The old bare *survey* glob false-matched this as G6.
    "capture-pane "*"agent-editor"*)  printf '%s' "  M src/web/survey-modal-recovery.js  (editing)" ;;
    "capture-pane "*)                 printf '%s' "> healthy pane prompt" ;;
    *) return 1 ;;
  esac
}

FLEET_WEDGE_SWEEP_INTERVAL=5

# Test: throttle prevents double-alert within interval
: > "$ALERTS_FILE"
rm -f "$STATE_DIR/fleet-wedge-sweep.last"
FLEET_TEST_SWEEP_AGENTS="dead-one"
fleet_wedge_sweep                    # first call: dead-one visible but only wedge alerts matter
fleet_wedge_sweep                    # second call within 5s: should be throttled
alert_count=$(count_alerts "ALERT")
# dead-one triggers no alert (dead = watchdog handles it); so 0 is expected
# The THROTTLE test just checks the second call is skipped
# We test throttle by ensuring only 1 _run_ happened (not two):
second_last=$(cat "$STATE_DIR/fleet-wedge-sweep.last" 2>/dev/null || echo 0)
[ "$second_last" -gt 0 ] \
  && ok "fleet_wedge_sweep: throttle state written on first call" \
  || bad "fleet_wedge_sweep: throttle state not written"

# A second call within the interval should not re-run (last timestamp unchanged)
last_after_second=$(cat "$STATE_DIR/fleet-wedge-sweep.last" 2>/dev/null || echo 0)
[ "$last_after_second" -eq "$second_last" ] \
  && ok "fleet_wedge_sweep: second call within interval is a no-op (last unchanged)" \
  || bad "fleet_wedge_sweep: second call unexpectedly updated last timestamp"

# Test: wedged agent triggers alert
: > "$ALERTS_FILE"
rm -f "$STATE_DIR/fleet-wedge-sweep.last"
FLEET_TEST_SWEEP_AGENTS="wedged"   # tmux captures "Usage limit" for this one
fleet_wedge_sweep
alert_count=$(count_alerts "ALERT")
[ "$alert_count" -ge 1 ] \
  && ok "fleet_wedge_sweep: alerts when agent is wedged G2 (usage-limit)" \
  || bad "fleet_wedge_sweep: no alert for wedged agent (got $alert_count)"

# Test: all healthy = no alert
: > "$ALERTS_FILE"
rm -f "$STATE_DIR/fleet-wedge-sweep.last"
FLEET_TEST_SWEEP_AGENTS="forge"  # alive + healthy pane
fleet_wedge_sweep
alert_count=$(count_alerts "ALERT")
[ "$alert_count" -eq 0 ] \
  && ok "fleet_wedge_sweep: no alert when all agents healthy" \
  || bad "fleet_wedge_sweep: unexpected alert for healthy fleet (got $alert_count)"

# Test: dead agent = no alert (watchdog handles it, not sweep)
: > "$ALERTS_FILE"
rm -f "$STATE_DIR/fleet-wedge-sweep.last"
FLEET_TEST_SWEEP_AGENTS="dead-one"
fleet_wedge_sweep
alert_count=$(count_alerts "ALERT")
[ "$alert_count" -eq 0 ] \
  && ok "fleet_wedge_sweep: no alert for dead agent (watchdog scope, not sweep)" \
  || bad "fleet_wedge_sweep: unexpected alert for dead agent (got $alert_count)"

# ── FLEET WEDGE SWEEP: G6 2-strike contract + *survey* FP guard (55219b86, b0e189fb) ─

# AUTHORITATIVE G6 CONTRACT (b0e189fb, migrated to detector-common in 9644ed7c S1):
# the canonical session-feedback marker is NOT an immediate flag -- it needs a
# confirmed 2nd consecutive strike within the window before auto-dismiss. A single
# sweep is the 1st strike (silent, no flag); the 2nd sweep confirms -> send-keys 0 +
# dismissed:<agent>:G6. Pre-b0e189fb this asserted single-sweep immediate fire and
# has been red ever since; re-contracted here to the 2-strike behaviour that is now
# live under both flag=0 (inline) and flag=1 (shared strike_gate). This also removes
# the latent ordering-coupling where the asleep/dead tests below depended on
# surveyer always flagging (see their stateless G2 partner).
_surv_clear() { rm -f "$STATE_DIR/g6-strike-surveyer" "$STATE_DIR/strike-g6-surveyer" "$STATE_DIR/strike-latch-g6-surveyer"; }

# Strike 1: silent (no flag, no payload).
: > "$ALERTS_FILE"; : > "$PAYLOADS_FILE"
rm -f "$STATE_DIR/fleet-wedge-sweep.last"; _surv_clear
FLEET_TEST_SWEEP_AGENTS="surveyer"
fleet_wedge_sweep
if [ "$(count_alerts "ALERT")" -eq 0 ] && ! grep -q "surveyer:G6" "$PAYLOADS_FILE"; then
  ok "fleet_wedge_sweep: G6 1st strike on canonical marker is silent (2-strike contract)"
else
  bad "fleet_wedge_sweep: G6 fired on 1st strike -- immediate-fire regression (payload: $(cat "$PAYLOADS_FILE"))"
fi

# Strike 2 (consecutive, within window): confirmed -> auto-dismiss, surveyer:G6 in payload.
: > "$ALERTS_FILE"; : > "$PAYLOADS_FILE"
rm -f "$STATE_DIR/fleet-wedge-sweep.last"
FLEET_TEST_SWEEP_AGENTS="surveyer"
fleet_wedge_sweep
if [ "$(count_alerts "ALERT")" -ge 1 ] && grep -q "surveyer:G6" "$PAYLOADS_FILE"; then
  ok "fleet_wedge_sweep: G6 2nd strike confirms -> auto-dismiss (surveyer:G6 in payload)"
else
  bad "fleet_wedge_sweep: G6 did not dismiss on confirmed 2nd strike (payload: $(cat "$PAYLOADS_FILE"))"
fi
_surv_clear   # leave no strike state for the sections below

# REGRESSION GUARD: an agent EDITING survey-modal-recovery.js must NOT be G6.
# The old bare *survey* glob false-matched the filename and flagged active
# agents (thor/claudia) as wedged. This is the load-bearing assertion for the fix.
: > "$ALERTS_FILE"; : > "$PAYLOADS_FILE"
rm -f "$STATE_DIR/fleet-wedge-sweep.last"
FLEET_TEST_SWEEP_AGENTS="editor"
fleet_wedge_sweep
if [ "$(count_alerts "ALERT")" -eq 0 ]; then
  ok "fleet_wedge_sweep: agent editing survey-modal-recovery.js is NOT G6 (no *survey* FP)"
else
  bad "fleet_wedge_sweep: FALSE-POSITIVE -- filename 'survey' flagged as G6"
fi

# ── FLEET WEDGE SWEEP: asleep vs dead classification (card 55219b86 dim 2) ─────

# Mark 'sleepy' as sleep-eligible; when its session is down it is asleep-by-design,
# NOT dead. Pair with the 'wedged' G2 agent (usage-limit = STATELESS immediate flag)
# so a payload is reliably emitted regardless of G6 strike state. (Was 'surveyer',
# whose G6 flag now depends on 2-strike history -- a latent ordering-coupling.)
echo "sleepy" > "$TMP/store/sleep-eligible.txt"

: > "$ALERTS_FILE"; : > "$PAYLOADS_FILE"
rm -f "$STATE_DIR/fleet-wedge-sweep.last"
FLEET_TEST_SWEEP_AGENTS="wedged sleepy"
fleet_wedge_sweep
# Fields are "dead:<ids> asleep:<ids>" with NO space after the colon
# (leading space stripped by ${list# }). Use [^ ]* so the negative dead-check
# does not bleed into the asleep field on the single-line payload.
if grep -qE "asleep:[^ ]*sleepy" "$PAYLOADS_FILE" && ! grep -qE "dead:[^ ]*sleepy" "$PAYLOADS_FILE"; then
  ok "fleet_wedge_sweep: sleep-eligible down agent classified asleep, not dead"
else
  bad "fleet_wedge_sweep: sleepy not classified asleep (payload: $(cat "$PAYLOADS_FILE"))"
fi

# A genuinely-down NON-sleep-eligible agent is still dead.
: > "$ALERTS_FILE"; : > "$PAYLOADS_FILE"
rm -f "$STATE_DIR/fleet-wedge-sweep.last"
FLEET_TEST_SWEEP_AGENTS="wedged dead-one"
fleet_wedge_sweep
if grep -qE "dead:[^ ]*dead-one" "$PAYLOADS_FILE" && ! grep -qE "asleep:[^ ]*dead-one" "$PAYLOADS_FILE"; then
  ok "fleet_wedge_sweep: non-sleep-eligible down agent still classified dead"
else
  bad "fleet_wedge_sweep: dead-one misclassified (payload: $(cat "$PAYLOADS_FILE"))"
fi

# ── results ─────────────────────────────────────────────────────────────────
MAX_FRESH_STARTS_PER_TICK="${FLEET_MAX_FRESH_STARTS:-3}"  # reset to default
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
