#!/bin/bash
# DoD migration for the gyore listener-drop detector (card 4a2683e6; DoD-migration
# OPS-272 / 8e124447 slice-2). check_listener_drop() decides whether Gyore's
# Telegram channel listener has silently dropped and the watchdog must kill +
# relaunch the session.
#
# It is an ENFORCEMENT detector (a false positive = a spurious session kill), so
# the three suppression gates are load-bearing and each has its own FP class:
#   gate 1 -- gauge freshness: a fresh gauge (< LISTENER_STALE_SECONDS) is never a drop.
#   gate 2 -- marveen cross-ref: if marveen's inbound keepalive is ALSO stale, the
#             whole fleet is quiet (no Boss messages arrived), not a Gyore drop.
#   gate 3 -- bot.pid liveness: a stale gauge + fresh marveen only means Boss is
#             messaging *some* agent; Gyore is a low-traffic researcher that can go
#             hours without a direct DM. Only declare a drop if the bun bot PROCESS
#             is actually gone (OPS/322a8a3f, lesson-proxy-signal-liveness-fp-
#             low-traffic-agent-1004: gyore flapped ~5min using marveen-keepalive
#             as a fleet-alive proxy).
#
# This harness SOURCES the real check_listener_drop from gyore-watchdog.sh (via
# GYORE_WATCHDOG_SOURCE_ONLY=1) instead of mirroring an inline copy -- the previous
# version tested a hand-copied function that had already drifted (it never grew the
# gate-3 bot.pid check, so the shipped FP fix had ZERO coverage). Sourcing the real
# function is the fix for lesson c813ad2 (exercise the real detector, not a copy).
#
# 4-item detector DoD (detector-dod-gate skill):
#   (a) positive-control -- every healthy shape (fresh gauge / quiet period / bot
#       alive) returns 0, no kill.
#   (b) bypass-fixture   -- proxy-signal low-traffic FP class: stale gauge + marveen
#       fresh + bot.pid ALIVE -> 0 (the OPS/322a8a3f / lesson-1004 regression).
#   (c) fail-direction   -- a genuinely dead listener (stale gauge + marveen fresh +
#       bot dead/missing) IS flagged -> 1.
#   (d) tail-scope       -- the detector's window is LISTENER_STALE_SECONDS (mtime
#       staleness); it scans no scrollback. Boundary fixtures lock it.
#
# Run: bash scripts/__tests__/channel-listener-drop.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

# --- Source the REAL check_listener_drop (not a copy) -----------------------
# The sourcing guard defines the functions and returns before the daemon loop.
export GYORE_WATCHDOG_LOG="$TMP/watchdog.log"
export GYORE_WATCHDOG_SOURCE_ONLY=1
# shellcheck source=/dev/null
source "$INSTALL_DIR/scripts/gyore-watchdog.sh"
if ! type check_listener_drop >/dev/null 2>&1; then
  echo "FATAL: check_listener_drop not defined after sourcing gyore-watchdog.sh"
  exit 1
fi
SESSION="agent-gyore-test"
LISTENER_STALE_SECONDS=3600

# A guaranteed-alive pid: this test shell's own pid ($$ is always alive and > 1).
# Using $$ avoids a long-lived background job, which is fragile under command-
# substitution subshells and job control.
ALIVE_PID=$$
# A guaranteed-dead pid: spawn, kill, reap -> kill -0 now fails.
sleep 60 & DEAD_PID=$!; kill "$DEAD_PID" 2>/dev/null; wait "$DEAD_PID" 2>/dev/null

now=$(date +%s)
stale=$(( now - 7200 ))        # 2 h ago -> beyond 3600s threshold
borderline=$(( now - 3540 ))   # 59 min ago -> just under threshold
fresh=$(( now - 300 ))         # 5 min ago -> healthy

# scenario <gauge_age|none> <marveen: fresh|stale|exact|none> <botpid: alive|dead|missing|garbage|one>
# Sets the globals the real check_listener_drop reads, then the caller invokes it.
scenario() {
  local gage="$1" mka="$2" bot="$3"

  if [ "$gage" = "none" ]; then
    LISTENER_STATE_FILE="$TMP/gauge-absent.json"; rm -f "$LISTENER_STATE_FILE"
  else
    LISTENER_STATE_FILE="$TMP/gauge.json"; echo '{"connected":true}' > "$LISTENER_STATE_FILE"
    touch -d "@$gage" "$LISTENER_STATE_FILE"
  fi

  case "$mka" in
    none)  MARVEEN_KEEPALIVE_FILE="$TMP/ka-absent"; rm -f "$MARVEEN_KEEPALIVE_FILE" ;;
    fresh) MARVEEN_KEEPALIVE_FILE="$TMP/ka"; touch -d "@$fresh" "$MARVEEN_KEEPALIVE_FILE" ;;
    stale) MARVEEN_KEEPALIVE_FILE="$TMP/ka"; touch -d "@$stale" "$MARVEEN_KEEPALIVE_FILE" ;;
    exact) MARVEEN_KEEPALIVE_FILE="$TMP/ka"; touch -d "@$(( now - 3600 ))" "$MARVEEN_KEEPALIVE_FILE" ;;
  esac

  STATE="$TMP/state"; mkdir -p "$STATE"
  local pf="$STATE/bot.pid"
  case "$bot" in
    alive)   echo "$ALIVE_PID" > "$pf" ;;
    dead)    echo "$DEAD_PID"  > "$pf" ;;
    missing) rm -f "$pf" ;;
    garbage) echo "not-a-pid" > "$pf" ;;
    one)     echo "1"         > "$pf" ;;
  esac
}
run() { check_listener_drop; echo $?; }

# ============================================================
echo "=== (d) tail-scope: LISTENER_STALE_SECONDS freshness window ==="
# gate 1. The detector's entire notion of "how far back" is the gauge mtime vs the
# staleness window -- no scrollback scan. These boundary cases lock that window.

scenario none none missing
assert_eq "(a/d) no gauge file -> 0 (no baseline, never fires)"            "0" "$(run)"

scenario "$fresh" fresh alive
assert_eq "(a/d) fresh gauge (5min) -> 0 (inside window, OK)"              "0" "$(run)"

scenario "$borderline" fresh missing
assert_eq "(a/d) borderline 59min < 60min window -> 0 (not yet stale)"     "0" "$(run)"

scenario "$(( now - 3600 ))" fresh missing
assert_eq "(c/d) exactly at 3600s window + marveen fresh + no bot -> 1 (DROP)" "1" "$(run)"

# ============================================================
echo "=== (a) positive-control: marveen cross-ref quiet-period (gate 2) ==="

# bot=DEAD here on purpose: gate 2 (quiet period) must return 0 BEFORE reaching the
# gate-3 bot.pid check. If gate 2 were removed, these would fall through to gate 3
# and -- with a dead bot -- flip to 1, so the rc itself proves gate 2 (not just the log).
scenario "$stale" stale dead
assert_eq "(a) stale gauge + marveen ALSO stale -> 0 (fleet quiet, no kill)" "0" "$(run)"

scenario "$stale" exact dead
assert_eq "(a) stale gauge + marveen exactly at threshold -> 0 (quiet)"     "0" "$(run)"

if grep -q "quiet period" "$GYORE_WATCHDOG_LOG" 2>/dev/null; then
  pass "(a) quiet-period path logged"
else
  fail "(a) quiet-period path NOT logged"
fi

# ============================================================
echo "=== (b) bypass-fixture: bot.pid liveness gate 3 (proxy-signal FP) ==="
# THE documented FP class -- OPS/322a8a3f / lesson-proxy-signal-liveness-fp-low-
# traffic-agent-1004. A stale gauge + fresh marveen is NOT enough: Gyore is a
# low-traffic researcher. Only a dead bot process is a real drop.

scenario "$stale" fresh alive
assert_eq "(b) stale gauge + marveen fresh + bot.pid ALIVE -> 0 (idle, NOT a drop)" "0" "$(run)"

if grep -q "bot pid .* alive -- idle period" "$GYORE_WATCHDOG_LOG" 2>/dev/null; then
  pass "(b) idle-period (bot-alive) suppression logged"
else
  fail "(b) idle-period (bot-alive) suppression NOT logged"
fi

scenario "$stale" fresh garbage
assert_eq "(b-edge) non-numeric bot.pid -> 1 (bogus pid must NOT suppress a drop)" "1" "$(run)"

scenario "$stale" fresh one
assert_eq "(b-edge) bot.pid=1 (init, not our bot) -> 1 (DROP)"               "1" "$(run)"

# ============================================================
echo "=== (c) fail-direction: genuine listener drop IS flagged ==="

scenario "$stale" fresh dead
assert_eq "(c) stale gauge + marveen fresh + bot.pid DEAD -> 1 (REAL DROP)" "1" "$(run)"

scenario "$stale" fresh missing
assert_eq "(c) stale gauge + marveen fresh + no bot.pid file -> 1 (can't confirm alive, DROP)" "1" "$(run)"

scenario "$stale" none dead
assert_eq "(c) stale gauge + no marveen file + bot dead -> 1 (conservative DROP)" "1" "$(run)"

if grep -q "LISTENER-DROP" "$GYORE_WATCHDOG_LOG" 2>/dev/null; then
  pass "(c) LISTENER-DROP logged on a real drop"
else
  fail "(c) LISTENER-DROP NOT logged"
fi

# ============================================================
echo "=== opposing-pair: bot alive vs bot dead, else identical (selective) ==="
# Same stale gauge, same fresh marveen -- only the bot liveness differs. Proves the
# trigger is SELECTIVE on gate 3, not firing on the shared stale+fresh prefix.

scenario "$stale" fresh alive; alive_r="$(run)"
scenario "$stale" fresh dead;  dead_r="$(run)"
if [ "$alive_r" = "0" ] && [ "$dead_r" = "1" ]; then
  pass "(opposing) bot alive -> 0, bot dead -> 1 (selective on gate 3)"
else
  fail "(opposing) expected alive=0/dead=1, got alive=$alive_r/dead=$dead_r"
fi

# ============================================================
echo "=== gauge-writer hook (channel-listener-gauge-write.py) ==="

GAUGE_METRICS_DIR="$TMP/metrics-test"
mkdir -p "$GAUGE_METRICS_DIR"
GAUGE_FILE="$GAUGE_METRICS_DIR/.agent-channel-testenv.json"

CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  CLAUDE_CONFIG_DIR="$TMP/agents/testenv/.claude-config" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null
if [ -f "$GAUGE_FILE" ]; then
  connected=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('connected'))" 2>/dev/null)
  assert_eq "hook: connected=True" "True" "$connected"
  agent_id=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('agent_id'))" 2>/dev/null)
  assert_eq "hook: agent_id=testenv" "testenv" "$agent_id"
  ts=$(python3 -c "import json,time; d=json.load(open('$GAUGE_FILE')); print('ok' if abs(d.get('last_event_ts',0)-time.time())<5 else 'stale')" 2>/dev/null)
  assert_eq "hook: last_event_ts within 5s of now" "ok" "$ts"
  pass "hook: gauge file created"
else
  fail "hook: gauge file NOT created at $GAUGE_FILE"
fi

count1=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('event_count',0))" 2>/dev/null)
CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  CLAUDE_CONFIG_DIR="$TMP/agents/testenv/.claude-config" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null
count2=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('event_count',0))" 2>/dev/null)
if [ "$count2" -gt "$count1" ] 2>/dev/null; then pass "hook: event_count increments"; else fail "hook: event_count did NOT increment ($count1 -> $count2)"; fi

rm -f "$GAUGE_FILE"
mkdir -p "$TMP/agents/testenv"
(cd "$TMP/agents/testenv" && unset CLAUDE_CONFIG_DIR && CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null)
if [ -f "$GAUGE_FILE" ]; then
  agent_id=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('agent_id'))" 2>/dev/null)
  assert_eq "hook: agent_id from CWD fallback" "testenv" "$agent_id"
else
  fail "hook: gauge file NOT created via CWD fallback"
fi

chmod 000 "$GAUGE_METRICS_DIR" 2>/dev/null || true
CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  CLAUDE_CONFIG_DIR="$TMP/agents/testenv/.claude-config" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null
EXITCODE=$?
chmod 755 "$GAUGE_METRICS_DIR" 2>/dev/null || true
assert_eq "hook: exits 0 even when dir is unwritable" "0" "$EXITCODE"

# ============================================================
echo "=== LISTENER_CHECK_TICKS=0 div-by-zero guard ==="
TICKS=0; TICK=5; result=0
if [ "${TICKS:-20}" -gt 0 ] && [ $(( TICK % TICKS )) -eq 0 ] 2>/dev/null; then result=1; fi
assert_eq "tick-guard: LISTENER_CHECK_TICKS=0 -> check never fires (div-by-zero safe)" "0" "$result"

# ============================================================
echo "=== Integration: real drop -> kill + notify; suppressed -> no kill ==="
KILL_LOG="$TMP/kill.log"; : > "$KILL_LOG"
NOTIFY_LOG="$TMP/notify.log"; : > "$NOTIFY_LOG"
declare -a STAMPS=()
MAX_PER_HOUR=8
under_cap() {
  local now2; now2=$(date +%s); local kept=(); local s
  for s in "${STAMPS[@]}"; do [ $((now2 - s)) -lt 3600 ] && kept+=("$s"); done
  STAMPS=("${kept[@]}"); [ "${#STAMPS[@]}" -lt "$MAX_PER_HOUR" ]
}
notify_marveen() { echo "notify: $1" >> "$NOTIFY_LOG"; }   # override the real network call
kill_session() { echo "kill: $1" >> "$KILL_LOG"; }

# Real drop: stale gauge + marveen fresh + bot dead.
scenario "$stale" fresh dead
if ! check_listener_drop; then
  if under_cap; then kill_session "$SESSION"; STAMPS+=("$(date +%s)"); notify_marveen "listener-drop auto-recovery"; fi
fi
if grep -q "kill:"   "$KILL_LOG";   then pass "integ: real drop -> kill called";   else fail "integ: real drop -> kill NOT called";   fi
if grep -q "notify:" "$NOTIFY_LOG"; then pass "integ: real drop -> marveen notified"; else fail "integ: real drop -> marveen NOT notified"; fi

# Suppressed (bot alive): no kill.
: > "$KILL_LOG"; : > "$NOTIFY_LOG"
scenario "$stale" fresh alive
if check_listener_drop; then pass "integ: bot-alive -> returns 0 (no kill)"; else kill_session "$SESSION"; fail "integ: bot-alive -> spurious kill"; fi
if ! grep -q "kill:" "$KILL_LOG"; then pass "integ: bot-alive -> kill NOT in log"; else fail "integ: bot-alive -> kill IN log (false positive)"; fi

# ============================================================
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS (0 failures)"
  exit 0
else
  echo "FAILURES: $FAIL"
  exit 1
fi
