#!/bin/bash
# Watchdog for agent-blackbart (junior-developer member agent, per-agent Telegram
# channel; own bot).
#
# Like chad/bond-watchdog: Black Bart is a CHANNEL agent, so a --continue
# relaunch loses the --channels activation state ("server not in --channels
# list") and can hit the "No deferred tool marker" immediate-exit. So Black Bart
# is ALWAYS relaunched FRESH with --channels + its own TELEGRAM_STATE_DIR. Black
# Bart's durable state lives in the memory system + kanban, not the session
# transcript, so a fresh session is safe.
#
# Black Bart also needs its genesis/agent token for inter-agent + PR ops, so the
# fresh launch sources agent-token-env.sh with GENESIS_AGENT_ID=blackbart (this
# is the extra over the chad/bond launch, matching Black Bart's live launch cmd).
#
# Model is read from agent-config.json on every (re)launch.

SESSION=agent-blackbart
AGENT_DIR=/home/domin/marveen/agents/blackbart
CFG="$AGENT_DIR/.claude-config"
STATE="$AGENT_DIR/.claude/channels/telegram"
ACONF="$AGENT_DIR/agent-config.json"
LOG=/home/domin/marveen/store/blackbart-watchdog.log
COOLDOWN=60
MAX_PER_HOUR=8

log() { echo "$(date -Is) $*" >> "$LOG"; }

# Shared watchdog helpers (card 0b282eb0 A1). F1: fail CLOSED -- if the lib is
# missing/broken, exit rather than silently degrade to a false-healthy loop.
. "$(dirname "$0")/lib/watchdog-common.sh" || { log "FATAL: watchdog-common.sh source failed"; exit 1; }
WD_LOG_FILE="$LOG"

# read_model: thin wrapper over the shared wd_read_model (keeps the call sites
# below unchanged). Reads the explicit `.model` from $ACONF; LOUD-warns (log +
# stderr) and defaults to claude-sonnet-4-6 on a missing/unparseable config or
# absent model field.
read_model() { wd_read_model "$ACONF"; }

# Fresh channel launch + first-run dialog guard (mirrors channels.sh). No
# --continue: keeps --channels activation intact. Auto-accept the Bypass
# Permissions / trust prompts so the headless session never parks on a dialog.
launch() {
  local model; model="$(read_model)"
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
  local cmd="export PATH=\"/opt/homebrew/bin:\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && export TELEGRAM_STATE_DIR=\"$STATE\" && cd \"$AGENT_DIR\" && export FLEET_ROOT=/home/domin/marveen && . /home/domin/marveen/scripts/lib/fleet-oauth-env.sh && export GENESIS_AGENT_ID=\"blackbart\" && . /home/domin/marveen/scripts/lib/agent-token-env.sh && /usr/bin/claude --dangerously-skip-permissions --model '$model' --channels plugin:telegram@claude-plugins-official"
  tmux new-session -d -s "$SESSION" "$cmd"
  log "launched $SESSION (fresh, --channels, model=$model)"
  local i pane
  for i in $(seq 1 20); do
    sleep 1
    pane="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)"
    case "$pane" in
      *"Bypass Permissions mode"*"Yes, I accept"*) tmux send-keys -t "$SESSION" "2" Enter; sleep 1 ;;
      *"Do you trust the files"*) tmux send-keys -t "$SESSION" "1" Enter; sleep 1 ;;
      *"Welcome to Claude Code"*) tmux send-keys -t "$SESSION" Enter; sleep 1 ;;
      *"Listening for channel messages"*) log "$SESSION ready (channel listening)"; return 0 ;;
    esac
  done
  log "WARN: $SESSION did not reach channel-listening within 20s"
}

log "blackbart-watchdog started (pid $$)"

# Relaunch-rate cap with hourly window.
declare -a STAMPS=()
under_cap() {
  local now; now=$(date +%s)
  local kept=(); local s
  for s in "${STAMPS[@]}"; do [ $((now - s)) -lt 3600 ] && kept+=("$s"); done
  STAMPS=("${kept[@]}")
  [ "${#STAMPS[@]}" -lt "$MAX_PER_HOUR" ]
}

while true; do
  if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
    if under_cap; then
      log "$SESSION DOWN -- cooldown ${COOLDOWN}s then fresh relaunch"
      sleep "$COOLDOWN"
      STAMPS+=("$(date +%s)")
      launch
    else
      log "$SESSION DOWN but relaunch cap (${MAX_PER_HOUR}/h) reached -- backing off 600s"
      sleep 600
    fi
  fi
  sleep 15
done
