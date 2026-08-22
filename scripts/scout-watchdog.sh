#!/bin/bash
# Watchdog for agent-scout (Dr. Stone, research + per-agent Telegram @Dr_Stone_scientist_bot).
#
# Scout is a CHANNEL agent (own bot): a --continue relaunch loses the --channels
# activation state. Scout is ALWAYS relaunched FRESH with --channels + its own
# TELEGRAM_STATE_DIR. Durable state lives in noa.db + the memory system, so a
# fresh session is safe (mirrors bond-watchdog).
#
# Model is read from agent-config.json on every (re)launch.

SESSION=agent-scout
AGENT_DIR=/home/domin/marveen/agents/scout
CFG="$AGENT_DIR/.claude-config"
STATE="$AGENT_DIR/.claude/channels/telegram"
ACONF="$AGENT_DIR/agent-config.json"
LOG=/home/domin/marveen/store/scout-watchdog.log
COOLDOWN=60
MAX_PER_HOUR=8

log() { echo "$(date -Is) $*" >> "$LOG"; }

read_model() {
  local model
  model="$(python3 -c "import json,sys
try:
    m=json.load(open('$ACONF')).get('model')
except Exception:
    sys.exit(3)
if not m:
    sys.exit(4)
print(m)" 2>/dev/null)"
  case "$?" in
    0) printf '%s\n' "$model" ;;
    3) log "WARN read_model: $ACONF missing or unparseable -> defaulting to claude-sonnet-4-6"
       echo claude-sonnet-4-6 ;;
    *) log "WARN read_model: $ACONF has no 'model' field -> defaulting to claude-sonnet-4-6"
       echo claude-sonnet-4-6 ;;
  esac
}

launch() {
  local model; model="$(read_model)"
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
  local cmd="export PATH=\"\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && export TELEGRAM_STATE_DIR=\"$STATE\" && cd \"$AGENT_DIR\" && export FLEET_ROOT=/home/domin/marveen && . /home/domin/marveen/scripts/lib/fleet-oauth-env.sh && /usr/bin/claude --dangerously-skip-permissions --model '$model' --channels plugin:telegram@claude-plugins-official"
  tmux new-session -d -s "$SESSION" "$cmd"
  log "launched $SESSION (fresh, --channels, model=$model)"
  local i pane
  for i in $(seq 1 20); do
    sleep 1
    pane="$(tmux capture-pane -t "=${SESSION}:" -p 2>/dev/null || true)"
    case "$pane" in
      *"Bypass Permissions mode"*"Yes, I accept"*) tmux send-keys -t "=${SESSION}:" "2" Enter; sleep 1 ;;
      *"Do you trust the files"*) tmux send-keys -t "=${SESSION}:" "1" Enter; sleep 1 ;;
      *"Welcome to Claude Code"*) tmux send-keys -t "=${SESSION}:" Enter; sleep 1 ;;
      *"Listening for channel messages"*) log "$SESSION ready (channel listening)"; return 0 ;;
    esac
  done
  log "WARN: $SESSION did not reach channel-listening within 20s"
}

log "scout-watchdog started (pid $$)"

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
