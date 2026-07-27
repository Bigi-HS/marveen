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
# 120s not 90s: opus-1M cold boot can take 60-80s; tighter threshold causes
# false crash-loop detection on a slow-but-legitimate boot.
CRASH_LOOP_THRESHOLD=${CRASH_LOOP_THRESHOLD:-120}
CRASH_LOOP_N=${CRASH_LOOP_N:-3}

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
  local cmd="export PATH=\"\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && cd \"$AGENT_DIR\" && export FLEET_ROOT=/home/domin/marveen && . /home/domin/marveen/scripts/lib/fleet-oauth-env.sh && /usr/bin/claude --continue --dangerously-skip-permissions --model '$model'"
  tmux new-session -d -s "$SESSION" "$cmd"
  log "launched $SESSION (channel-less, --continue, model=$model)"
  answer_resume_prompt
}

launch_fresh() {
  local model; model="$(read_model)"
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
  local cmd="export PATH=\"\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && cd \"$AGENT_DIR\" && export FLEET_ROOT=/home/domin/marveen && . /home/domin/marveen/scripts/lib/fleet-oauth-env.sh && /usr/bin/claude --dangerously-skip-permissions --model '$model'"
  tmux new-session -d -s "$SESSION" "$cmd"
  log "launched $SESSION (FRESH/no --continue, model=$model) -- crash-loop recovery"
}

alert_crash_loop() {
  local count="$1"
  python3 - "$count" "$NAME" "$CRASH_LOOP_THRESHOLD" <<'PY' 2>/dev/null || log "WARN: alert_crash_loop could not reach dashboard API"
import urllib.request, json, sys
count, name = sys.argv[1], sys.argv[2]
try:
    tok = open("/home/domin/marveen/store/.dashboard-token").read().strip()
except OSError:
    sys.exit(1)
threshold = sys.argv[3] if len(sys.argv) > 3 else "120"
msg = f"CRASH-LOOP alert: agent-{name} had {count} consecutive sub-{threshold}s deaths -- did ONE fresh relaunch (dropped --continue). Check store/{name}-watchdog.log."
data = json.dumps({"from":name,"to":"marveen","content":msg}).encode()
req = urllib.request.Request("http://localhost:3420/api/messages", data=data,
      headers={"Content-Type":"application/json","Authorization":f"Bearer {tok}"}, method="POST")
urllib.request.urlopen(req, timeout=5)
PY
}

log "watchdog started for $SESSION (pid $$)"
declare -a STAMPS=()
under_cap() {
  local now; now=$(date +%s); local kept=(); local s
  for s in "${STAMPS[@]}"; do [ $((now - s)) -lt 3600 ] && kept+=("$s"); done
  STAMPS=("${kept[@]}"); [ "${#STAMPS[@]}" -lt "$MAX_PER_HOUR" ]
}
last_launch=0
consecutive_short=0
while true; do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    now=$(date +%s); lived=$(( now - last_launch ))
    if [ "$last_launch" -ne 0 ] && [ "$lived" -lt "$CRASH_LOOP_THRESHOLD" ]; then
      consecutive_short=$((consecutive_short + 1))
      log "$SESSION sub-${CRASH_LOOP_THRESHOLD}s death #${consecutive_short} (lived ${lived}s) -- backoff ${LONG_BACKOFF}s"; sleep "$LONG_BACKOFF"
    elif [ "$last_launch" -ne 0 ] && [ "$lived" -lt "$SHORT_LIVED" ]; then
      consecutive_short=0
      log "$SESSION died after only ${lived}s -- backoff ${LONG_BACKOFF}s"; sleep "$LONG_BACKOFF"
    else
      consecutive_short=0
      log "$SESSION DOWN (lived ${lived}s) -- cooldown ${COOLDOWN}s"; sleep "$COOLDOWN"
    fi
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      if under_cap; then
        STAMPS+=("$(date +%s)")
        if [ "$consecutive_short" -ge "$CRASH_LOOP_N" ]; then
          log "CRASH-LOOP: ${consecutive_short} consecutive sub-${CRASH_LOOP_THRESHOLD}s deaths -- ONE fresh relaunch (drop --continue)"
          alert_crash_loop "$consecutive_short"
          consecutive_short=0
          launch_fresh
        else
          launch
        fi
        last_launch=$(date +%s)
      else log "$SESSION DOWN but cap (${MAX_PER_HOUR}/h) reached -- backoff ${LONG_BACKOFF}s"; sleep "$LONG_BACKOFF"; fi
    fi
  fi
  sleep 30
done
