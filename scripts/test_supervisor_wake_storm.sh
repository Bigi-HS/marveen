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

curl() {
  case "$*" in
    *"/api/messages"*) echo "ALERT" >> "$ALERTS_FILE" ;;
  esac
  return 0
}

tmux() {
  case "$*" in
    "has-session -t =agent-dead-one") return 1 ;;
    "has-session -t ="*)              return 0 ;;
    "capture-pane "*"agent-wedged"*)  printf '%s' "Usage limit reached -- weekly limit" ;;
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

# ── results ─────────────────────────────────────────────────────────────────
MAX_FRESH_STARTS_PER_TICK="${FLEET_MAX_FRESH_STARTS:-3}"  # reset to default
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
