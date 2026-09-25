#!/bin/bash
# scripts/sleep-agent-watchdog.sh -- ON-DEMAND watchdog for a sleep-eligible,
# channel-less specialist (card AGENT-a2b05be5, spec docs/design/agent-sleep-mode-spec-a2b05be5.md).
#
# Behavioral INVERSION of agent-watchdog.sh: this loop does NOT keep a session
# alive. While ASLEEP (no tmux session) it launches ONLY when a wake trigger
# fires (sleep-guard sg_should_wake: undelivered message / in_progress card /
# imminent scheduled task). While AWAKE it evaluates the auto-sleep condition
# (sg_should_sleep) and KILLS the session when the agent has been idle 30 min
# with no obligation/card/imminent-task/pin. Sleeping = 0 running process =>
# reclaimed RAM (~200-350 MB per agent).
#
# Launch is FRESH (no --continue): durable state lives in the memory system, so a
# stale summary resume is slower and unnecessary for a cold specialist. The router
# (always-on dashboard process) drains the queued message once the woken session
# reaches idle -- there is NO SessionStart inbox-drain hook and this watchdog must
# not add one (verified: message-router delivers; watchdog-replay only touches
# delivered-but-incomplete rows).
#
# Gated by the caller: fleet-supervisor starts this ONLY when
# store/agent-sleep-mode.enabled is present, and then removes the eligible ids
# from the always-on agent-watchdog list (mutual exclusion -- two loops must never
# fight over one session). Usage: sleep-agent-watchdog.sh <name>

NAME="$1"
[ -z "$NAME" ] && echo "usage: sleep-agent-watchdog.sh <name>" >&2 && exit 2
SESSION="agent-$NAME"
INSTALL_DIR="/home/domin/marveen"
AGENT_DIR="$INSTALL_DIR/agents/$NAME"
CFG="$AGENT_DIR/.claude-config"
ACONF="$AGENT_DIR/agent-config.json"
LOG="$INSTALL_DIR/store/${NAME}-sleep-watchdog.log"

STATE_DIR="$INSTALL_DIR/store/.sleep-state"
PIN_DIR="$INSTALL_DIR/store/.sleep-pin"
MARKER="$STATE_DIR/${NAME}.launching"
IDLE_FILE="$STATE_DIR/${NAME}.idle-since"
BUSY_FILE="$STATE_DIR/${NAME}.busy-count"   # FINDING-2 debounce: consecutive ambiguous polls
PIN="$PIN_DIR/${NAME}"
mkdir -p "$STATE_DIR" 2>/dev/null || true

MAX_PER_HOUR=8       # relaunch cap (R3/R6): a pathological trigger cannot spin cold boots unbounded
LONG_BACKOFF=600

log() { echo "$(date -Is) $*" >> "$LOG"; }

# Fail CLOSED: if a required lib is missing/broken, exit rather than loop half-blind
# and risk a wrong wake/sleep decision on live agent lifecycle.
. "$(dirname "$0")/lib/watchdog-common.sh" || { log "FATAL: watchdog-common.sh source failed"; exit 1; }
. "$(dirname "$0")/lib/sleep-guard.sh"     || { log "FATAL: sleep-guard.sh source failed"; exit 1; }
. "$(dirname "$0")/lib/pane-idle.sh"       || { log "FATAL: pane-idle.sh source failed"; exit 1; }
WD_LOG_FILE="$LOG"

# resolve_db: honor NOA_DB_PATH only if it is a .db under INSTALL_DIR (no parent
# traversal); else the live store/noa.db. NEVER the frozen legacy claudeclaw.db.
# Mirrors fleet-supervisor.sh resolve_live_db.
resolve_db() {
  local raw="${NOA_DB_PATH:-}"
  raw="${raw#"${raw%%[![:space:]]*}"}"; raw="${raw%"${raw##*[![:space:]]}"}"
  if [ -n "$raw" ]; then
    local cand
    case "$raw" in /*) cand="$raw" ;; *) cand="$INSTALL_DIR/$raw" ;; esac
    case "$cand" in
      *..*) : ;;
      "$INSTALL_DIR"/*.db) printf '%s' "$cand"; return 0 ;;
    esac
  fi
  printf '%s' "$INSTALL_DIR/store/noa.db"
}
DB="$(resolve_db)"

read_model() { wd_read_model "$ACONF"; }

# Pane idle/working detection lives in lib/pane-idle.sh (pane_capture_classify +
# pane_idle_accrue), shared verbatim with fleet-supervisor.sh so the parse can
# never diverge (FINDING-2 card 089e78db). The old exact-empty `^❯[[:space:]]*$`
# regex on `capture-pane -p` never matched (empty composer is `❯`+U+00A0, and
# ghost-text autosuggestions are indistinguishable once ANSI is stripped); the
# shared classifier reads `-e` output and discriminates by SGR.

# launch_fresh: mirror of agent-watchdog.sh launch_fresh (no --continue). Same env
# scrub + CLAUDE_CONFIG_DIR + fleet-oauth-env sourcing so a woken specialist boots
# identically to a normal channel-less relaunch, minus the resume menu (fresh has none).
launch_fresh() {
  local model; model="$(read_model)"
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
  local cmd="export PATH=\"\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && cd \"$AGENT_DIR\" && export FLEET_ROOT=$INSTALL_DIR && . $INSTALL_DIR/scripts/lib/fleet-oauth-env.sh && /usr/bin/claude --dangerously-skip-permissions --model '$model'"
  tmux new-session -d -s "$SESSION" "$cmd"
  log "woke $SESSION (FRESH, model=$model)"
}

declare -a STAMPS=()
under_cap() {
  local now; now=$(date +%s); local kept=(); local s
  for s in "${STAMPS[@]}"; do [ $((now - s)) -lt 3600 ] && kept+=("$s"); done
  STAMPS=("${kept[@]}"); [ "${#STAMPS[@]}" -lt "$MAX_PER_HOUR" ]
}

log "sleep-watchdog started for $SESSION (pid $$, db=$DB)"
POLL="${SG_DUE_POLL_SEC:-15}"
while true; do
  now=$(date +%s)
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    # AWAKE: the boot succeeded -> clear the in-flight marker; track pane idle;
    # sleep when the full condition holds.
    rm -f "$MARKER"
    # Classify the pane (working/idle/ambiguous) and fold it into the debounced
    # idle timer. idle_since=0 means "not idle right now" -> sg_should_sleep stays
    # (never sleeps mid-input or on a single ambiguous redraw frame, R5).
    pane_state="$(pane_capture_classify "$SESSION")"
    idle_since="$(pane_idle_accrue "$pane_state" "$IDLE_FILE" "$BUSY_FILE" "$now")"
    if sg_should_sleep "$DB" "$NAME" "$now" "${idle_since:-0}" "$PIN"; then
      tmux kill-session -t "=$SESSION" 2>/dev/null || true
      rm -f "$IDLE_FILE" "$BUSY_FILE" "$MARKER"
      log "slept $SESSION (idle>=${SG_IDLE_SLEEP_SECONDS}s; no obligation/card/due-task/pin)"
    fi
  else
    # ASLEEP: no session, no idle timer.
    rm -f "$IDLE_FILE" "$BUSY_FILE"
    if sg_should_wake "$DB" "$NAME" "$now"; then
      # R1: only launch if no live session and no in-flight boot younger than the
      # cold-boot TTL. Mark BEFORE launch so a duplicate trigger cannot double-fire.
      if sg_launch_allowed "$MARKER" "$now" 0; then
        if under_cap; then
          echo "$now" > "$MARKER"
          STAMPS+=("$now")
          launch_fresh
        else
          log "$SESSION wake-trigger but relaunch cap (${MAX_PER_HOUR}/h) reached -- backoff ${LONG_BACKOFF}s"
          sleep "$LONG_BACKOFF"
        fi
      fi
    fi
  fi
  sleep "$POLL"
done
