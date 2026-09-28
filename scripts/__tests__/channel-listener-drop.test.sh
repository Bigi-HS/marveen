#!/bin/bash
# Tests for listener-drop detection (card 4a2683e6).
#
# Tests check_listener_drop() logic and the gauge-writer hook.
# The watchdog functions are redefined here (mirroring the implementation)
# rather than sourced, to avoid tmux/flask/loop side effects in CI.
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
assert_zero() { if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1 (expected 0, got '$2')"; fi; }
assert_nonzero() { if [ "$2" -ne 0 ]; then pass "$1"; else fail "$1 (expected non-zero, got 0)"; fi; }

# --- Mirror the watchdog's check_listener_drop logic -------------------------
# (Keeps the test self-contained; the real implementation is in gyore-watchdog.sh)
LOG="$TMP/watchdog.log"
log() { echo "$(date -Is) $*" >> "$LOG"; }

make_check_listener_drop() {
  local state_file="$1"
  local stale_seconds="$2"
  LISTENER_STATE_FILE="$state_file"
  LISTENER_STALE_SECONDS="$stale_seconds"
  SESSION="agent-gyore-test"
  check_listener_drop() {
    [ -f "$LISTENER_STATE_FILE" ] || return 0
    local mtime now age
    mtime=$(stat -c %Y "$LISTENER_STATE_FILE" 2>/dev/null || echo 0)
    now=$(date +%s)
    age=$(( now - mtime ))
    if [ "$age" -ge "$LISTENER_STALE_SECONDS" ]; then
      log "LISTENER-DROP: gauge stale ${age}s -- $SESSION listener appears dead"
      return 1
    fi
    return 0
  }
}

now=$(date +%s)
stale=$(( now - 7200 ))          # 2 hours ago -> beyond 3600s threshold
borderline=$(( now - 3540 ))     # 59 min ago -> just under 3600s threshold
fresh=$(( now - 300 ))           # 5 min ago -> healthy

# ============================================================
echo "=== check_listener_drop (gyore-watchdog logic) ==="

# FIXTURE 1: no state file (no baseline) -> return 0 (no action)
GAUGE="$TMP/.agent-channel-nofile.json"
rm -f "$GAUGE"
make_check_listener_drop "$GAUGE" 3600
check_listener_drop
assert_eq "F1: no state file -> 0 (OK, no baseline)" "0" "$?"

# FIXTURE 2: fresh gauge (5 min) -> return 0
GAUGE="$TMP/.agent-channel-fresh.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$fresh" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600
check_listener_drop
assert_eq "F2: fresh gauge -> 0 (OK)" "0" "$?"

# FIXTURE 3: stale gauge (2h) -> return 1 (drop)
GAUGE="$TMP/.agent-channel-stale.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$stale" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600
check_listener_drop
assert_eq "F3: stale gauge (2h > 1h) -> 1 (DROP)" "1" "$?"
WARN_COUNT=$(grep -c "LISTENER-DROP" "$LOG" 2>/dev/null || echo 0)
if [ "$WARN_COUNT" -gt 0 ]; then pass "F3: drop logged"; else fail "F3: drop NOT logged"; fi

# FIXTURE 4: adversarial false-drop (borderline: 59 min, threshold 60 min) -> 0
GAUGE="$TMP/.agent-channel-border.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$borderline" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600
check_listener_drop
assert_eq "F4: borderline (59min < 60min threshold) -> 0 (OK)" "0" "$?"

# FIXTURE 5: exact threshold (3600s) -> 1 (drop)
GAUGE="$TMP/.agent-channel-exact.json"
echo '{"connected":true}' > "$GAUGE"
exact=$(( now - 3600 ))
touch -d "@$exact" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600
check_listener_drop
assert_eq "F5: exactly at threshold (3600s) -> 1 (DROP)" "1" "$?"

# FIXTURE 6: empty state file (malformed) -> 0 (file exists but stat works)
GAUGE="$TMP/.agent-channel-empty.json"
> "$GAUGE"
touch -d "@$stale" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600
check_listener_drop
assert_eq "F6: empty/malformed file (stale) -> 1 (stale mtime still triggers)" "1" "$?"

# ============================================================
echo "=== gauge-writer hook (channel-listener-gauge-write.py) ==="

GAUGE_METRICS_DIR="$TMP/metrics-test"
mkdir -p "$GAUGE_METRICS_DIR"
GAUGE_FILE="$GAUGE_METRICS_DIR/.agent-channel-testenv.json"

# FIXTURE 7: gauge writer creates file with correct fields
CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  CLAUDE_CONFIG_DIR="$TMP/agents/testenv/.claude-config" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null
if [ -f "$GAUGE_FILE" ]; then
  connected=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('connected'))" 2>/dev/null)
  assert_eq "F7: gauge writer: connected=True" "True" "$connected"
  agent_id=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('agent_id'))" 2>/dev/null)
  assert_eq "F7: gauge writer: agent_id=testenv" "testenv" "$agent_id"
  ts=$(python3 -c "import json,time; d=json.load(open('$GAUGE_FILE')); print('ok' if abs(d.get('last_event_ts',0)-time.time())<5 else 'stale')" 2>/dev/null)
  assert_eq "F7: gauge writer: last_event_ts within 5s of now" "ok" "$ts"
  pass "F7: gauge file created"
else
  fail "F7: gauge file NOT created at $GAUGE_FILE"
fi

# FIXTURE 8: gauge writer increments event_count on successive calls
count1=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('event_count',0))" 2>/dev/null)
CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  CLAUDE_CONFIG_DIR="$TMP/agents/testenv/.claude-config" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null
count2=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('event_count',0))" 2>/dev/null)
if [ "$count2" -gt "$count1" ] 2>/dev/null; then pass "F8: event_count increments on second call"; else fail "F8: event_count did NOT increment ($count1 -> $count2)"; fi

# FIXTURE 9: gauge writer extracts agent_id from CWD fallback
rm -f "$GAUGE_METRICS_DIR/.agent-channel-testenv.json"
mkdir -p "$TMP/agents/testenv"
# Unset CLAUDE_CONFIG_DIR so the CWD regex fallback actually fires
(cd "$TMP/agents/testenv" && unset CLAUDE_CONFIG_DIR && CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null)
if [ -f "$GAUGE_FILE" ]; then
  agent_id=$(python3 -c "import json; d=json.load(open('$GAUGE_FILE')); print(d.get('agent_id'))" 2>/dev/null)
  assert_eq "F9: agent_id from CWD fallback" "testenv" "$agent_id"
else
  fail "F9: gauge file NOT created via CWD fallback"
fi

# FIXTURE 10: gauge writer is non-fatal when CHANNEL_GAUGE_METRICS_DIR is unwritable
chmod 000 "$GAUGE_METRICS_DIR" 2>/dev/null || true
CHANNEL_GAUGE_METRICS_DIR="$GAUGE_METRICS_DIR" \
  CLAUDE_CONFIG_DIR="$TMP/agents/testenv/.claude-config" \
  python3 "$INSTALL_DIR/scripts/hooks/channel-listener-gauge-write.py" 2>/dev/null
EXITCODE=$?
chmod 755 "$GAUGE_METRICS_DIR" 2>/dev/null || true
assert_eq "F10: gauge writer exits 0 even when dir is unwritable (non-fatal)" "0" "$EXITCODE"

# ============================================================
echo "=== Integration: stale-drop triggers kill + notify (simulated) ==="

KILL_LOG="$TMP/kill.log"; : > "$KILL_LOG"
NOTIFY_LOG="$TMP/notify.log"; : > "$NOTIFY_LOG"

# Simulate the main loop's listener-drop branch
GAUGE="$TMP/.agent-channel-integ.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$stale" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600

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

if grep -q "kill:" "$KILL_LOG"; then pass "F11: stale -> kill called"; else fail "F11: stale -> kill NOT called"; fi
if grep -q "notify:" "$NOTIFY_LOG"; then pass "F11: stale -> marveen notified"; else fail "F11: stale -> marveen NOT notified"; fi

# With a fresh gauge: no kill
: > "$KILL_LOG"; : > "$NOTIFY_LOG"
GAUGE="$TMP/.agent-channel-integ2.json"
echo '{"connected":true}' > "$GAUGE"
touch -d "@$fresh" "$GAUGE"
make_check_listener_drop "$GAUGE" 3600
if check_listener_drop; then
  pass "F12: fresh gauge -> no kill (check returned 0)"
else
  kill_session "agent-gyore-test"
  fail "F12: fresh gauge -> kill WAS called (should not happen)"
fi
if ! grep -q "kill:" "$KILL_LOG"; then pass "F12: fresh -> kill NOT in log"; else fail "F12: fresh -> kill IN log (spurious)"; fi

# ============================================================
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS (0 failures)"
  exit 0
else
  echo "FAILURES: $FAIL"
  exit 1
fi
