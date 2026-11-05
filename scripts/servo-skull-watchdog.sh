#!/bin/bash
# Watchdog for agent-servo-skull (event-organizer assistant, GEEKCON/HTC;
# per-agent Telegram channel). Boss-requested 2026-10-05: servo-skull had NO
# watchdog, so when it died in the 14:37 fleet restart nothing brought it back.
#
# Like Claudia, servo-skull is a CHANNEL agent: a --continue relaunch loses the
# --channels activation state ("server not in --channels list"), so it is ALWAYS
# relaunched FRESH with --channels + its own TELEGRAM_STATE_DIR. Durable state
# lives in the memory system / store, not the session transcript, so fresh is safe.
#
# No agent-config.json exists for servo-skull (roster: "no agent-config"), so
# wd_read_model LOUD-warns and defaults to claude-sonnet-4-6 -- the correct
# token-efficient tier for a worker agent.

SESSION=agent-servo-skull
AGENT_DIR=/home/domin/marveen/agents/servo-skull
CFG="$AGENT_DIR/.claude-config"
STATE="$AGENT_DIR/.claude/channels/telegram"
ACONF="$AGENT_DIR/agent-config.json"
LOG=/home/domin/marveen/store/servo-skull-watchdog.log
COOLDOWN=60
MAX_PER_HOUR=8

log() { echo "$(date -Is) $*" >> "$LOG"; }

# Shared watchdog helpers (card 0b282eb0 A1). F1: fail CLOSED -- if the lib is
# missing/broken, exit rather than silently degrade to a false-healthy loop.
. "$(dirname "$0")/lib/watchdog-common.sh" || { log "FATAL: watchdog-common.sh source failed"; exit 1; }
WD_LOG_FILE="$LOG"

# read_model: thin wrapper over the shared wd_read_model. Reads the explicit
# `.model` from $ACONF; LOUD-warns and defaults to claude-sonnet-4-6 on a
# missing/unparseable config or absent model field (servo-skull has none).
read_model() { wd_read_model "$ACONF"; }

# Fresh channel launch + first-run dialog guard (mirrors channels.sh). No
# --continue: keeps --channels activation intact. Auto-accept the Bypass
# Permissions / trust prompts so the headless session never parks on a dialog.
launch() {
  local model; model="$(read_model)"
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
  local cmd="export PATH=\"\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && export TELEGRAM_STATE_DIR=\"$STATE\" && cd \"$AGENT_DIR\" && export FLEET_ROOT=/home/domin/marveen && . /home/domin/marveen/scripts/lib/fleet-oauth-env.sh && /usr/bin/claude --dangerously-skip-permissions --model '$model' --channels plugin:telegram@claude-plugins-official"
  tmux new-session -d -s "$SESSION" "$cmd"
  log "launched $SESSION (fresh, --channels, model=$model)"
  local i pane
  for i in $(seq 1 20); do
    sleep 1
    pane="$(tmux capture-pane -t "=$SESSION:" -p 2>/dev/null || true)"
    case "$pane" in
      *"Bypass Permissions mode"*"Yes, I accept"*) tmux send-keys -t "=$SESSION:" "2" Enter; sleep 1 ;;
      *"Do you trust the files"*) tmux send-keys -t "=$SESSION:" "1" Enter; sleep 1 ;;
      *"Welcome to Claude Code"*) tmux send-keys -t "=$SESSION:" Enter; sleep 1 ;;
      *"Listening for channel messages"*) log "$SESSION ready (channel listening)"; return 0 ;;
    esac
  done
  log "WARN: $SESSION did not reach channel-listening within 20s"
}

log "servo-skull-watchdog started (pid $$)"

# Relaunch-rate cap: file-backed sliding 1h window (0b282eb0 Phase-3).
STAMP_FILE="/tmp/wd-stamps-servo-skull"

while true; do
  if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
    if wd_under_cap_file "$STAMP_FILE" "$MAX_PER_HOUR"; then
      log "$SESSION DOWN -- cooldown ${COOLDOWN}s then fresh relaunch"
      sleep "$COOLDOWN"
      wd_under_cap_stamp "$STAMP_FILE"
      launch
    else
      log "$SESSION DOWN but relaunch cap (${MAX_PER_HOUR}/h) reached -- backing off 600s"
      sleep 600
    fi
  fi
  sleep 15
done
