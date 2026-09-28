#!/bin/bash
# Tests for listener-drop detection (card 4a2683e6).
#
# Covers check_listener_drop() cross-reference logic (gauge stale + marveen
# keepalive cross-check to prevent quiet-period false positives), gauge-writer
# hook, integration kill+notify, and div-by-zero guard.
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

# --- Mirror the watchdog's check_listener_drop logic (with cross-reference) --
LOG="$TMP/watchdog.log"
log() { echo "$(date -Is) $*" >> "$LOG"; }

# make_check_listener_drop <gauge_file> <stale_seconds> <marveen_keepalive_file_or_none>
make_check_listener_drop() {
  local state_file="$1"
  local stale_seconds="$2"
  local ka_file="${3:-}"    # empty = no file (skip cross-reference)
  LISTENER_STATE_FILE="$state_file"
  LISTENER_STALE_SECONDS="$stale_seconds"
  MARVEEN_KEEPALIVE_FILE="$ka_file"
  SESSION="agent-gyore-test"
  check_listener_drop() {
    [ -f "$LISTENER_STATE_FILE" ] || return 0
    local mtime now age
    mtime=$(stat -c %Y "$LISTENER_STATE_FILE" 2>/dev/null || echo 0)
    now=$(date +%s)
    age=$(( now - mtime ))
    [ "$age" -ge "$LISTENER_STALE_SECONDS" ] || return 0

    # Cross-check marveen keepalive before declaring drop.
    if [ -n "$MARVEEN_KEEPALIVE_FILE" ] && [ -f "$MARVEEN_KEEPALIVE_FILE" ]; then
      local ka_mtime ka_age
      ka_mtime=$(stat -c %Y "$MARVEEN_KEEPALIVE_FILE" 2>/dev/null || echo 0)
      ka_age=$(( now - ka_mtime ))
      if [ "$ka_age" -ge "$LISTENER_STALE_SECONDS" ]; then
        log "check_listener_drop: gauge stale ${age}s but marveen keepalive also stale ${ka_age}s -- quiet period, no action"
        return 0
      fi
    fi

    log "LISTENER-DROP: gauge stale ${age}s, marveen keepalive fresh (or absent) -- $SESSION listener appears dead"
    return 1
  }
}

now=$(date +%s)
stale=$(( now - 7200 ))          # 2 hours ago -> beyond 3600s threshold
borderline=$(( now - 3540 ))     # 59 min ago -> just under 3600s threshold
fresh=$(( now - 300 ))           # 5 min ago -> healthy

# ============================================================
echo "=== check_listener_drop: basic staleness ---"

# FIXTURE 1: no state file (no baseline) -> 0 (no action)
GAUGE="$TMP/.agent-channel-nofile.json"
rm -f "$GAUGE"
make_check_listener_drop "$GAUGE" 3600 ""
check_listener_drop
assert_eq "F1: no state file -> 0 (OK, no baseline)" "0" "$?"

# FIXTURE 2: fresh gauge (5 min) -> 0
GAUGE="$TMP/.agent-channel-fresh.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$fresh" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600 ""
check_listener_drop
assert_eq "F2: fresh gauge -> 0 (OK)" "0" "$?"

# FIXTURE 3: borderline (59 min, threshold 60 min) -> 0
GAUGE="$TMP/.agent-channel-border.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$borderline" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600 ""
check_listener_drop
assert_eq "F3: borderline (59min < 60min threshold) -> 0 (OK)" "0" "$?"

# FIXTURE 4: exactly at threshold (3600s) -> 1 (drop, no keepalive cross-ref)
GAUGE="$TMP/.agent-channel-exact.json"
echo '{"connected":true}' > "$GAUGE"
exact=$(( now - 3600 ))
touch -d "@$exact" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600 ""
check_listener_drop
assert_eq "F4: exactly at threshold (no keepalive file) -> 1 (DROP)" "1" "$?"

# ============================================================
echo "=== check_listener_drop: cross-reference (quiet-period false-positive fix) ==="

MARVEEN_KA="$TMP/.channel-keepalive"

# FIXTURE 5: stale gauge + marveen ALSO stale -> quiet period, return 0 (FALSE-POSITIVE PREV.)
GAUGE="$TMP/.agent-channel-quiet.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$stale" "$GAUGE"
touch -d "@$stale" "$MARVEEN_KA"   # marveen also stale: fleet-wide quiet
make_check_listener_drop "$GAUGE" 3600 "$MARVEEN_KA"
check_listener_drop
assert_eq "F5: stale gauge + marveen stale -> 0 (quiet period, no kill)" "0" "$?"
QUIET_LOG=$(grep -c "quiet period" "$LOG" 2>/dev/null || echo 0)
if [ "$QUIET_LOG" -gt 0 ]; then pass "F5: quiet-period logged"; else fail "F5: quiet-period NOT logged"; fi

# FIXTURE 6: stale gauge + marveen FRESH -> real drop, return 1
GAUGE="$TMP/.agent-channel-realdrop.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$stale" "$GAUGE"
touch -d "@$fresh" "$MARVEEN_KA"   # marveen active: Boss is sending, Gyore deaf
make_check_listener_drop "$GAUGE" 3600 "$MARVEEN_KA"
check_listener_drop
assert_eq "F6: stale gauge + marveen fresh -> 1 (REAL DROP)" "1" "$?"
DROP_LOG=$(grep -c "LISTENER-DROP" "$LOG" 2>/dev/null || echo 0)
if [ "$DROP_LOG" -gt 0 ]; then pass "F6: LISTENER-DROP logged"; else fail "F6: LISTENER-DROP NOT logged"; fi

# FIXTURE 7: adversarial: stale gauge + no marveen keepalive file -> 1 (conservative: fire)
# Rationale: if we can't cross-check, assume drop (errs toward recovery, not missed drops).
GAUGE="$TMP/.agent-channel-noka.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$stale" "$GAUGE"
rm -f "$TMP/.channel-keepalive-missing"
make_check_listener_drop "$GAUGE" 3600 "$TMP/.channel-keepalive-missing"
check_listener_drop
assert_eq "F7: stale gauge + no marveen keepalive file -> 1 (DROP, conservative)" "1" "$?"

# FIXTURE 8: stale gauge + marveen at EXACTLY threshold -> quiet period, return 0
# (boundary: if ka_age == LISTENER_STALE_SECONDS, it's also stale -> quiet)
GAUGE="$TMP/.agent-channel-exact-ka.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$stale" "$GAUGE"
exact_ka=$(( now - 3600 ))
touch -d "@$exact_ka" "$MARVEEN_KA"
make_check_listener_drop "$GAUGE" 3600 "$MARVEEN_KA"
check_listener_drop
assert_eq "F8: stale gauge + marveen exactly at threshold -> 0 (quiet period)" "0" "$?"

# ============================================================
echo "=== gauge-writer hook (channel-listener-gauge-write.py) ==="

GAUGE_METRICS_DIR="$TMP/metrics-test"
mkdir -p "$GAUGE_METRICS_DIR"
GAUGE_FILE="$GAUGE_METRICS_DIR/.agent-channel-testenv.json"

# FIXTURE 9: gauge writer creates file with correct fields
CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  CLAUDE_CONFIG_DIR="$TMP/agents/testenv/.claude-config" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null
if [ -f "$GAUGE_FILE" ]; then
  connected=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('connected'))" 2>/dev/null)
  assert_eq "F9: gauge writer: connected=True" "True" "$connected"
  agent_id=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('agent_id'))" 2>/dev/null)
  assert_eq "F9: gauge writer: agent_id=testenv" "testenv" "$agent_id"
  ts=$(python3 -c "import json,time; d=json.load(open('$GAUGE_FILE')); print('ok' if abs(d.get('last_event_ts',0)-time.time())<5 else 'stale')" 2>/dev/null)
  assert_eq "F9: gauge writer: last_event_ts within 5s of now" "ok" "$ts"
  pass "F9: gauge file created"
else
  fail "F9: gauge file NOT created at $GAUGE_FILE"
fi

# FIXTURE 10: event_count increments on successive calls
count1=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('event_count',0))" 2>/dev/null)
CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  CLAUDE_CONFIG_DIR="$TMP/agents/testenv/.claude-config" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null
count2=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('event_count',0))" 2>/dev/null)
if [ "$count2" -gt "$count1" ] 2>/dev/null; then pass "F10: event_count increments"; else fail "F10: event_count did NOT increment ($count1 -> $count2)"; fi

# FIXTURE 11: CWD fallback for agent_id
rm -f "$GAUGE_FILE"
mkdir -p "$TMP/agents/testenv"
(cd "$TMP/agents/testenv" && unset CLAUDE_CONFIG_DIR && CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null)
if [ -f "$GAUGE_FILE" ]; then
  agent_id=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('agent_id'))" 2>/dev/null)
  assert_eq "F11: agent_id from CWD fallback" "testenv" "$agent_id"
else
  fail "F11: gauge file NOT created via CWD fallback"
fi

# FIXTURE 12: non-fatal when dir is unwritable
chmod 000 "$GAUGE_METRICS_DIR" 2>/dev/null || true
CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  CLAUDE_CONFIG_DIR="$TMP/agents/testenv/.claude-config" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null
EXITCODE=$?
chmod 755 "$GAUGE_METRICS_DIR" 2>/dev/null || true
assert_eq "F12: gauge writer exits 0 even when dir is unwritable" "0" "$EXITCODE"

# ============================================================
echo "=== LISTENER_CHECK_TICKS=0 div-by-zero guard ==="

# FIXTURE 13: main-loop tick guard -- LISTENER_CHECK_TICKS=0 must never trigger
# (the guard is `[ TICKS -gt 0 ] && [ tick % TICKS -eq 0 ]`; we verify it's safe)
TICKS=0
TICK=5
result=0
if [ "${TICKS:-20}" -gt 0 ] && [ $(( TICK % TICKS )) -eq 0 ] 2>/dev/null; then
  result=1
fi
assert_eq "F13: LISTENER_CHECK_TICKS=0 -> check never fires (div-by-zero safe)" "0" "$result"

# ============================================================
echo "=== Integration: stale+marveen-fresh -> kill + notify ==="

KILL_LOG="$TMP/kill.log"; : > "$KILL_LOG"
NOTIFY_LOG="$TMP/notify.log"; : > "$NOTIFY_LOG"

GAUGE="$TMP/.agent-channel-integ.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$stale" "$GAUGE"
KA="$TMP/.marveen-ka-integ"
touch -d "@$fresh" "$KA"   # marveen fresh -> real drop
make_check_listener_drop "$GAUGE" 3600 "$KA"

declare -a STAMPS=()
MAX_PER_HOUR=8
under_cap() {
  local now2; now2=$(date +%s)
  local kept=(); local s
  for s in "${STAMPS[@]}"; do [ $((now2 - s)) -lt 3600 ] && kept+=("$s"); done
  STAMPS=("${kept[@]}")
  [ "${#STAMPS[@]}" -lt "$MAX_PER_HOUR" ]
}
notify_marveen() { echo "notify: $1" >> "$NOTIFY_LOG"; }
kill_session() { echo "kill: $1" >> "$KILL_LOG"; }

if ! check_listener_drop; then
  if under_cap; then
    kill_session "agent-gyore-test"
    STAMPS+=("$(date +%s)")
    notify_marveen "gyore listener-drop auto-recovery: relaunched fresh"
  fi
fi

if grep -q "kill:" "$KILL_LOG"; then pass "F14: stale+marveen-fresh -> kill called"; else fail "F14: stale+marveen-fresh -> kill NOT called"; fi
if grep -q "notify:" "$NOTIFY_LOG"; then pass "F14: stale+marveen-fresh -> marveen notified"; else fail "F14: stale+marveen-fresh -> marveen NOT notified"; fi

# Quiet period: no kill
: > "$KILL_LOG"; : > "$NOTIFY_LOG"
GAUGE="$TMP/.agent-channel-integ2.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$stale" "$GAUGE"
KA2="$TMP/.marveen-ka-quiet"
touch -d "@$stale" "$KA2"   # marveen also stale -> quiet period
make_check_listener_drop "$GAUGE" 3600 "$KA2"

if check_listener_drop; then
  pass "F15: quiet-period -> check returns 0 (no kill)"
else
  kill_session "agent-gyore-test"
  fail "F15: quiet-period -> kill WAS called (spurious)"
fi
if ! grep -q "kill:" "$KILL_LOG"; then pass "F15: quiet-period -> kill NOT in log"; else fail "F15: quiet-period -> kill IN log (false positive)"; fi

# Fresh gauge: no kill
: > "$KILL_LOG"; : > "$NOTIFY_LOG"
GAUGE="$TMP/.agent-channel-integ3.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$fresh" "$GAUGE"
KA3="$TMP/.marveen-ka-fresh"
touch -d "@$fresh" "$KA3"
make_check_listener_drop "$GAUGE" 3600 "$KA3"

check_listener_drop
assert_eq "F16: fresh gauge -> 0 (no kill, regardless of marveen)" "0" "$?"

# ============================================================
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS (0 failures)"
  exit 0
else
  echo "FAILURES: $FAIL"
  exit 1
fi
