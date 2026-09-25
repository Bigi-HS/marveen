#!/bin/bash
# scripts/lib/sleep-guard.sh -- pure wake/sleep decision logic for agent sleep-mode
# (card AGENT-a2b05be5, spec docs/design/agent-sleep-mode-spec-a2b05be5.md).
#
# Sourced by scripts/sleep-agent-watchdog.sh. Defines ONLY pure functions (no
# tmux/daemon side effects on source) so every wake/sleep decision is unit-testable
# against a temp sqlite DB + a fixed `now` epoch. See scripts/test_sleep_guard.sh.
# Mirrors the pure-core + unit-test pattern of scripts/lib/ollama-local-guard.sh.
#
# CONTRACT: all DB reads take a caller-supplied DB path (resolve_live_db ->
# store/noa.db in production; NEVER the frozen legacy claudeclaw.db). All
# time-relative decisions take an explicit `now` epoch (no wall-clock read inside),
# so a test pins the clock. Every function returns a shell verdict (0=true/act,
# nonzero=false) and is safe under `set -u`.

# --- tunables (overridable via env; defaults per spec 5.2/5.3 + Boss ACs) ----
: "${SG_BOOT_LEAD_SECONDS:=150}"              # launch this far AHEAD of a due task (5.1.3, R2)
: "${SG_DUE_POLL_SEC:=15}"                    # dedicated due-check poll cadence (R2)
: "${SG_IDLE_SLEEP_SECONDS:=1800}"            # 30 min continuous idle -> sleep (5.2.3, AC1)
: "${SG_STAY_UP_HORIZON_SECONDS:=3600}"       # stay up if a task is due within 1h (5.3 AC1)
: "${SG_OBLIGATION_LOOKBACK_SECONDS:=3600}"   # 1h obligation lookback (86c3904e FINDING-1b; was 6h)
: "${SG_LAUNCH_MARKER_TTL_SECONDS:=120}"      # cold-boot window for the .launching guard (R1)

# _sg_sql_count <db> <sql> [params...]
# Run a single-row COUNT(*) query and print the integer (0 on any error: missing
# DB, bad query, locked file). The DB path AND every bind param are passed via
# argv -- NEVER string-interpolated into SQL -- so there is no injection surface.
# Opens the DB read-only so the guard can never mutate fleet state.
_sg_sql_count() {
  local db="${1:-}" sql="${2:-}"
  shift 2 2>/dev/null || return 1
  if [ -z "$db" ] || [ ! -f "$db" ]; then printf '0'; return 0; fi
  python3 -c "
import sqlite3, sys
db, sql, params = sys.argv[1], sys.argv[2], sys.argv[3:]
try:
    con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
    row = con.execute(sql, params).fetchone()
    con.close()
    print(int(row[0]) if row and row[0] is not None else 0)
except Exception:
    print(0)
" "$db" "$sql" "$@" 2>/dev/null
}

# ---------------------------------------------------------------------------
# 5.1 Wake triggers (ASLEEP -> AWAKE); any one fires.
# ---------------------------------------------------------------------------

# sg_has_undelivered_msg <db> <agent>  (5.1.1)
# True iff an inter-agent message to <agent> is still undelivered (delivered_at
# IS NULL). An asleep agent has no live session, so the router never injects and
# the row provably stays NULL (verified: message-router.ts sets delivered_at only
# after a successful live-session inject).
sg_has_undelivered_msg() {
  local n
  n="$(_sg_sql_count "$1" "SELECT COUNT(*) FROM agent_messages WHERE to_agent=? AND delivered_at IS NULL" "$2")"
  [ "${n:-0}" -gt 0 ]
}

# sg_has_active_card <db> <agent>  (5.1.2)
# True iff <agent> has an in_progress card. planned/waiting do NOT wake (not
# active work yet) so Boss can assign freely without waking a sleeper.
sg_has_active_card() {
  local n
  n="$(_sg_sql_count "$1" "SELECT COUNT(*) FROM kanban_cards WHERE assignee=? AND status='in_progress'" "$2")"
  [ "${n:-0}" -gt 0 ]
}

# sg_has_due_task <db> <agent> <now> <horizon>  (5.1.3 / 5.3 AC1)
# True iff <agent> owns an active scheduled task whose next_run is at or before
# now+horizon. Includes OVERDUE tasks (next_run in the past, missed while asleep)
# so a wake still fires and the scheduler's missing-retry re-delivers it.
sg_has_due_task() {
  local db="$1" agent="$2" now="$3" horizon="$4" cutoff n
  cutoff=$(( now + horizon ))
  n="$(_sg_sql_count "$db" "SELECT COUNT(*) FROM scheduled_tasks WHERE agent=? AND status='active' AND next_run<=?" "$agent" "$cutoff")"
  [ "${n:-0}" -gt 0 ]
}

# sg_should_wake <db> <agent> <now> [boot_lead]  (5.1)
# OR of the three wake triggers. boot_lead defaults to SG_BOOT_LEAD_SECONDS.
sg_should_wake() {
  local db="$1" agent="$2" now="$3" lead="${4:-$SG_BOOT_LEAD_SECONDS}"
  sg_has_undelivered_msg "$db" "$agent" && return 0
  sg_has_active_card "$db" "$agent" && return 0
  sg_has_due_task "$db" "$agent" "$now" "$lead" && return 0
  return 1
}

# ---------------------------------------------------------------------------
# 5.2 / 5.3 Auto-sleep condition + exceptions.
# ---------------------------------------------------------------------------

# sg_has_open_obligation <db> <agent> <now> [lookback]  (5.2.1)
# True iff <agent> has an incomplete inbound message (completed_at IS NULL) created
# within the lookback window that is a GENUINE obligation: either still undelivered
# (delivered_at IS NULL -- also a wake trigger, so the agent will wake and handle it)
# OR delivered with the sender expecting an ack/action (ack_expected=1).
#
# 86c3904e FINDING-1: the old predicate counted ANY uncompleted row, so a delivered
# FYI/status message (ack_expected 0/NULL, which never gets completed_at) pinned an
# eligible agent awake for the whole lookback. On a chatty fleet that meant sleep
# almost never fired. Narrowing to (delivered_at IS NULL OR ack_expected=1) keeps R4
# safe (a real delegation-wait arrives undelivered -> blocks + wakes; active work
# keeps the pane busy / an in_progress card blocks) while letting FYIs pass.
sg_has_open_obligation() {
  local db="$1" agent="$2" now="$3" lookback="${4:-$SG_OBLIGATION_LOOKBACK_SECONDS}" cutoff n
  cutoff=$(( now - lookback ))
  n="$(_sg_sql_count "$db" "SELECT COUNT(*) FROM agent_messages WHERE to_agent=? AND completed_at IS NULL AND created_at>? AND (delivered_at IS NULL OR ack_expected=1)" "$agent" "$cutoff")"
  [ "${n:-0}" -gt 0 ]
}

# sg_pin_active <pin_file> <now>  (5.4 / 5.3 AC2)
# True iff the pin marker exists AND holds a numeric expiry epoch AND now is
# before it. A missing or malformed marker is inactive (fail-safe: normal sleep).
sg_pin_active() {
  local pin="$1" now="$2" expiry
  [ -f "$pin" ] || return 1
  expiry="$(head -n1 "$pin" 2>/dev/null | tr -d '[:space:]')"
  case "$expiry" in ''|*[!0-9]*) return 1 ;; esac
  [ "$now" -lt "$expiry" ]
}

# sg_next_0500_epoch <now>  (5.3 AC2 / 5.4)
# Print the epoch of the next 05:00 Europe/Budapest strictly after <now>. Used to
# stamp a pin's auto-expiry. Pure: derived from <now> via TZ, so it is testable.
sg_next_0500_epoch() {
  local now="$1" day today0500 nextday
  day="$(TZ=Europe/Budapest date -d "@$now" +%Y-%m-%d 2>/dev/null)"
  today0500="$(TZ=Europe/Budapest date -d "$day 05:00" +%s 2>/dev/null)"
  if [ -n "$today0500" ] && [ "$today0500" -gt "$now" ]; then
    printf '%s' "$today0500"
    return 0
  fi
  nextday="$(TZ=Europe/Budapest date -d "@$((now+86400))" +%Y-%m-%d 2>/dev/null)"
  TZ=Europe/Budapest date -d "$nextday 05:00" +%s 2>/dev/null
}

# sg_launch_allowed <marker_file> <now> <session_exists> [ttl]  (7 R1)
# Guard against a double-launch during the ~60-80s cold-boot window. Allow a
# launch iff there is NO live session AND no in-flight .launching marker younger
# than ttl. A stale marker (boot died) older than ttl allows a self-healing
# relaunch; an unreadable marker also allows (fail-open to recovery).
#   session_exists: "1" if a tmux session already exists (already awake -> deny).
sg_launch_allowed() {
  local marker="$1" now="$2" session_exists="$3" ttl="${4:-$SG_LAUNCH_MARKER_TTL_SECONDS}" started age
  [ "$session_exists" = "1" ] && return 1
  [ -f "$marker" ] || return 0
  started="$(head -n1 "$marker" 2>/dev/null | tr -d '[:space:]')"
  case "$started" in ''|*[!0-9]*) return 0 ;; esac
  age=$(( now - started ))
  [ "$age" -ge "$ttl" ]
}

# sg_should_sleep <db> <agent> <now> <idle_since> <pin_file>  (5.2 + 5.3)
# The full auto-sleep decision: return 0 (SLEEP) iff ALL of 5.2 hold AND no 5.3
# exception applies. idle_since is the epoch the pane became continuously idle
# (0/empty -> never idle -> stay). Ordered cheap-checks first; any blocker -> stay.
sg_should_sleep() {
  local db="$1" agent="$2" now="$3" idle_since="$4" pin="$5"
  # 5.2.3: pane continuously idle for >= threshold.
  case "$idle_since" in ''|*[!0-9]*) return 1 ;; esac
  [ "$idle_since" -gt 0 ] || return 1
  [ $(( now - idle_since )) -ge "$SG_IDLE_SLEEP_SECONDS" ] || return 1
  # 5.3 AC2: a pinned agent never sleeps before its 05:00 expiry.
  sg_pin_active "$pin" "$now" && return 1
  # 5.2.1: no open obligation (undelivered or mid-task).
  sg_has_open_obligation "$db" "$agent" "$now" && return 1
  # 5.2.2: no active (in_progress) card.
  sg_has_active_card "$db" "$agent" && return 1
  # 5.3 AC1: no task due within the stay-up horizon.
  sg_has_due_task "$db" "$agent" "$now" "$SG_STAY_UP_HORIZON_SECONDS" && return 1
  return 0
}
