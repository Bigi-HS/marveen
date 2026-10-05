#!/usr/bin/env bash
# lib/detector-common.sh -- shared detector primitives (W1/c2f7904b)
#
# Source this file before using any primitive:
#   source "$ROOT/lib/detector-common.sh"
#
# Feature flag (ships inert by default -- flip to 1 once callers migrate):
#   DETECTOR_COMMON_ENABLED="${DETECTOR_COMMON_ENABLED:-0}"
#
# Callers must provide a log() function. The primitives call log() for
# diagnostic output; if log() is not defined they fall back silently.
#
# Requires: date, python3 (for effect_drain_check), rm, cat, printf.
# Does NOT require fleet-supervisor.sh to be sourced; but effect_drain_check()
# calls resolve_live_db() which must be available in the caller's scope.

DETECTOR_COMMON_ENABLED="${DETECTOR_COMMON_ENABLED:-0}"

# Internal log wrapper: calls log() if defined, otherwise no-op.
_dc_log() {
  if command -v log >/dev/null 2>&1; then
    log "$@"
  fi
}

# instrument_check <probe_fn> <healthy_agent> <bad_fixture>
#
# Dual-arm calibration gate. Must be called before any detector escalates.
#
# Arm A (negative / FP-guard): probe must NOT fire on a confirmed-healthy agent.
#   Fire on healthy => instrument miscalibrated => VAK-RIASZTAS (FP risk).
# Arm B (positive / blindness-guard): probe MUST fire on a known-bad fixture.
#   Miss on bad => instrument is blind => VAK-RIASZTAS (FN risk).
#
# Returns: 0 = both arms pass (instrument healthy), 1 = suppress
instrument_check() {
  local probe_fn="$1" healthy_agent="$2" bad_fixture="$3"
  if "$probe_fn" "$healthy_agent"; then
    _dc_log "detector: instrument_check ARM-A FAIL -- fires on healthy $healthy_agent (VAK-RIASZTAS/FP)"
    return 1
  fi
  if ! "$probe_fn" "$bad_fixture"; then
    _dc_log "detector: instrument_check ARM-B FAIL -- blind on known-bad $bad_fixture (VAK-RIASZTAS/FN)"
    return 1
  fi
  return 0
}

# strike_gate <agent> <state_dir> [window_seconds] [latch_window_seconds]
#
# 2-strike persistence with confirmed-latch.
# First detection: write strike file, return 1 (no alarm yet).
# Second detection within window_seconds: confirmed, return 0.
# Stale first strike (> window_seconds ago): reset to first strike, return 1.
# Confirmed-latch: after confirmation, suppress re-confirmation for latch_window
#   seconds (prevents every-other-sweep flapping).
#
# On healthy state: callers should call strike_clear() to remove the strike file.
# Returns: 0 = confirmed (2nd strike within window), 1 = first strike or suppressed
strike_gate() {
  local agent="$1" state_dir="$2"
  local window="${3:-${STRIKE_WINDOW:-600}}"
  local latch_window="${4:-${STRIKE_LATCH_WINDOW:-$window}}"
  local strikef="$state_dir/strike-$agent"
  local latchf="$state_dir/strike-latch-$agent"
  local now ts latch_ts
  now=$(date +%s)

  # Latch check: if a recent confirmation is recorded, suppress re-confirmation.
  if [ -f "$latchf" ]; then
    latch_ts=$(cat "$latchf" 2>/dev/null || echo 0)
    case "$latch_ts" in (*[!0-9]*|'') latch_ts=0 ;; esac
    if [ $(( now - latch_ts )) -lt "$latch_window" ]; then
      return 1
    fi
    rm -f "$latchf"
  fi

  if [ ! -f "$strikef" ]; then
    printf '%s\n' "$now" > "$strikef"
    return 1
  fi

  ts=$(cat "$strikef" 2>/dev/null || echo 0)
  case "$ts" in (*[!0-9]*|'') ts=0 ;; esac

  if [ $(( now - ts )) -gt "$window" ]; then
    printf '%s\n' "$now" > "$strikef"
    return 1
  fi

  # 2nd strike confirmed: remove strike file, write latch.
  rm -f "$strikef"
  printf '%s\n' "$now" > "$latchf"
  return 0
}

# strike_clear <agent> <state_dir>
#
# Remove strike and latch files for agent (call when agent is observed healthy).
strike_clear() {
  local agent="$1" state_dir="$2"
  rm -f "$state_dir/strike-$agent" "$state_dir/strike-latch-$agent"
}

# effect_drain_check <agent> [interval_seconds]
#
# Corroboration gate: returns 0 (draining/healthy) if the agent has received
# at least one inter-agent message delivered within the last interval_seconds.
# Returns 1 (idle) if no recent messages, or if DB is unreachable (fail-open:
# an unreachable DB must NOT falsely confirm drain to suppress a real wedge).
#
# Requires: resolve_live_db() defined in caller scope.
effect_drain_check() {
  local agent="$1" interval="${2:-${FLEET_WEDGE_SWEEP_INTERVAL:-300}}" db count
  db=$(resolve_live_db 2>/dev/null) || return 1
  [ -f "$db" ] || return 1
  count=$(EFFECT_AGENT="$agent" EFFECT_SINCE="$interval" python3 -c "
import sqlite3, sys, time, os
try:
    db_path = sys.argv[1] if len(sys.argv) > 1 else ''
    agent_id = os.environ.get('EFFECT_AGENT', '')
    interval = int(os.environ.get('EFFECT_SINCE', 300))
    db = sqlite3.connect(db_path)
    since = int(time.time()) - interval
    row = db.execute('SELECT COUNT(*) FROM agent_messages WHERE to_agent=? AND delivered_at > ?',
                     (agent_id, since)).fetchone()
    print(row[0] if row else 0)
    db.close()
except Exception:
    print(0)
" "$db" 2>/dev/null) || return 1
  [ "${count:-0}" -gt 0 ]
}
