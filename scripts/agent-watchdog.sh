#!/bin/bash
# Generic watchdog for a CHANNEL-LESS fleet sub-agent (Forge / Quill / Scout /
# Gauge / ...). Usage: agent-watchdog.sh <name>
#
# Channel-less: launches WITHOUT --channels, scrubs channel tokens, points
# CLAUDE_CONFIG_DIR at the agent's isolated config dir. Relaunch uses --continue
# for task continuity (these are NOT channel agents, so the --channels-activation
# loss that forces thor-watchdog to go fresh does not apply here). The resume
# menu on an old/large session is auto-answered with "1" (resume from summary).
#
# Model is read from agent-config.json on every (re)launch. Hourly relaunch cap
# with a sliding window so a genuine crash/429-storm cannot loop unbounded.

NAME="$1"
[ -z "$NAME" ] && echo "usage: agent-watchdog.sh <name>" >&2 && exit 2
SESSION="agent-$NAME"
AGENT_DIR="/home/domin/marveen/agents/$NAME"
CFG="$AGENT_DIR/.claude-config"
ACONF="$AGENT_DIR/agent-config.json"
LOG="/home/domin/marveen/store/${NAME}-watchdog.log"
COOLDOWN=60
MAX_PER_HOUR=8
SHORT_LIVED=180
LONG_BACKOFF=600

log() { echo "$(date -Is) $*" >> "$LOG"; }
read_model() {
  # NOTE: explicit model field only; not archetype-aware (see dave-watchdog T8).
  python3 -c "import json;print(json.load(open('$ACONF')).get('model','claude-sonnet-4-6'))" 2>/dev/null || echo claude-sonnet-4-6
}

answer_resume_prompt() {
  local i pane
  for i in $(seq 1 20); do
    sleep 2
    pane="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null)"
    if printf '%s' "$pane" | grep -q 'Resume from summary'; then
      tmux send-keys -t "$SESSION" '1'; sleep 1; tmux send-keys -t "$SESSION" Enter
      log "answered resume-prompt -> 1"; return 0
    fi
    printf '%s' "$pane" | grep -q 'bypass permissions on' && { log "$SESSION active prompt"; return 0; }
  done
  log "WARN: neither resume menu nor active prompt within 40s"
}

launch() {
  local model; model="$(read_model)"
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
  local cmd="export PATH=\"\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && cd \"$AGENT_DIR\" && /usr/bin/claude --continue --dangerously-skip-permissions --model '$model'"
  tmux new-session -d -s "$SESSION" "$cmd"
  log "launched $SESSION (channel-less, --continue, model=$model)"
  answer_resume_prompt
}

log "watchdog started for $SESSION (pid $$)"
declare -a STAMPS=()
under_cap() {
  local now; now=$(date +%s); local kept=(); local s
  for s in "${STAMPS[@]}"; do [ $((now - s)) -lt 3600 ] && kept+=("$s"); done
  STAMPS=("${kept[@]}"); [ "${#STAMPS[@]}" -lt "$MAX_PER_HOUR" ]
}
last_launch=0
while true; do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    now=$(date +%s); lived=$(( now - last_launch ))
    if [ "$last_launch" -ne 0 ] && [ "$lived" -lt "$SHORT_LIVED" ]; then
      log "$SESSION died after only ${lived}s -- backoff ${LONG_BACKOFF}s"; sleep "$LONG_BACKOFF"
    else
      log "$SESSION DOWN (lived ${lived}s) -- cooldown ${COOLDOWN}s"; sleep "$COOLDOWN"
    fi
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      if under_cap; then STAMPS+=("$(date +%s)"); launch; last_launch=$(date +%s)
      else log "$SESSION DOWN but cap (${MAX_PER_HOUR}/h) reached -- backoff ${LONG_BACKOFF}s"; sleep "$LONG_BACKOFF"; fi
    fi
  fi
  sleep 30
done
