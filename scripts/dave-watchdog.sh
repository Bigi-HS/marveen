#!/bin/bash
# Watchdog: keeps agent-dave alive and auto-resumes after a death (429
# rate-limit / token exhaustion or a crash).
#
# Dave is a CHANNEL agent (@DAVE_KALOZ_BOT, per-agent Telegram channel). Like
# thor-watchdog, he is ALWAYS relaunched FRESH with --channels + his own
# TELEGRAM_STATE_DIR. A --continue relaunch loses the --channels activation
# state ("server not in --channels list"), which left Dave channel-less and
# unable to receive Boss-DM after any watchdog restart (card a87a2398). Dave's
# durable state lives in the memory system (CLAUDE.md reloads it), not the
# session transcript, so a fresh session is safe -- context loss is minimal.
#
# Model is read from agent-config.json on every (re)launch, so switching Dave's
# model = edit that file; both manual relaunch and this watchdog pick it up.
# Backoff: after a death, wait COOLDOWN before relaunch (avoid hammering during
# a 429 storm). Caps relaunches per hour.

SESSION=agent-dave
AGENT_DIR=/home/domin/marveen/agents/dave
CFG="$AGENT_DIR/.claude-config"
STATE="$AGENT_DIR/.claude/channels/telegram"
ACONF="$AGENT_DIR/agent-config.json"
LOG=/home/domin/marveen/store/dave-watchdog.log
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

# Fresh channel launch + first-run dialog guard (mirrors thor-watchdog /
# channels.sh). No --continue: keeps --channels activation intact so Dave keeps
# receiving Boss-DM. Auto-accept the Bypass Permissions / trust prompts so the
# headless session never parks on a dialog, and wait for the channel-listening
# surface before returning.
launch() {
  local model; model="$(read_model)"
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
  local cmd="export PATH=\"/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && export TELEGRAM_STATE_DIR=\"$STATE\" && cd \"$AGENT_DIR\" && export FLEET_ROOT=/home/domin/marveen && . /home/domin/marveen/scripts/lib/fleet-oauth-env.sh && /usr/bin/claude --dangerously-skip-permissions --model '$model' --channels plugin:telegram@claude-plugins-official"
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

# Alert marveen via inter-agent API when a crash-loop is detected. Token is read
# inside Python (not passed via argv) to avoid ps-visible secret.
alert_crash_loop() {
  local count="$1"
  python3 - "$count" <<'PY' 2>/dev/null || log "WARN: alert_crash_loop could not reach dashboard API"
import urllib.request, json, sys
count = sys.argv[1]
try:
    tok = open("/home/domin/marveen/store/.dashboard-token").read().strip()
except OSError:
    sys.exit(1)
msg = f"CRASH-LOOP alert: agent-dave had {count} consecutive sub-120s deaths -- still relaunching fresh+channels. Check store/dave-watchdog.log."
data = json.dumps({"from":"forge","to":"marveen","content":msg}).encode()
req = urllib.request.Request("http://localhost:3420/api/messages", data=data,
      headers={"Content-Type":"application/json","Authorization":f"Bearer {tok}"}, method="POST")
urllib.request.urlopen(req, timeout=5)
PY
}

log "watchdog started (pid $$)"

# Adaptive backoff for GENUINE crash loops. If Dave dies quickly after a fresh
# relaunch it's a real crash (or, occasionally, an actual 429) -- back off so we
# don't hammer.
SHORT_LIVED=180
LONG_BACKOFF=600
# Crash-loop detection: N consecutive deaths each lived <THRESHOLD -> alert.
# Observed 2026-06-22: poisoned/large session hits session-limit ~60s post-launch
# and loops forever. Ref: dave-634k-session-limit-incident.
# Threshold is 120s (not 90s): opus-1M cold boot can take 60-80s, so a session that
# dies at 100s from tmux-start is still within boot time and should not count as a
# crash-loop candidate at a tighter threshold.
CRASH_LOOP_THRESHOLD=120
CRASH_LOOP_N=3
last_launch=0
consecutive_short=0

# T9 (Thor stack-review): MAX_PER_HOUR was defined but never enforced, so a
# genuine crash/429-storm could relaunch Dave without bound. Enforce an hourly
# relaunch cap with a sliding 1h window (mirrors thor-watchdog under_cap()).
declare -a STAMPS=()
under_cap() {
  local now; now=$(date +%s)
  local kept=(); local s
  for s in "${STAMPS[@]}"; do [ $((now - s)) -lt 3600 ] && kept+=("$s"); done
  STAMPS=("${kept[@]}")
  [ "${#STAMPS[@]}" -lt "$MAX_PER_HOUR" ]
}

while true; do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    now=$(date +%s); lived=$(( now - last_launch ))
    if [ "$last_launch" -ne 0 ] && [ "$lived" -lt "$CRASH_LOOP_THRESHOLD" ]; then
      consecutive_short=$((consecutive_short + 1))
      log "$SESSION sub-${CRASH_LOOP_THRESHOLD}s death #${consecutive_short} (lived ${lived}s) -- backoff ${LONG_BACKOFF}s"
      sleep "$LONG_BACKOFF"
    elif [ "$last_launch" -ne 0 ] && [ "$lived" -lt "$SHORT_LIVED" ]; then
      consecutive_short=0
      log "$SESSION died after only ${lived}s (genuine crash or real 429) -- backoff ${LONG_BACKOFF}s"
      sleep "$LONG_BACKOFF"
    else
      consecutive_short=0
      log "$SESSION DOWN (lived ${lived}s) -- cooldown ${COOLDOWN}s then fresh+channels relaunch"
      sleep "$COOLDOWN"
    fi
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      if under_cap; then
        STAMPS+=("$(date +%s)")
        if [ "$consecutive_short" -ge "$CRASH_LOOP_N" ]; then
          log "CRASH-LOOP: ${consecutive_short} consecutive sub-${CRASH_LOOP_THRESHOLD}s deaths -- alerting marveen, relaunching fresh+channels"
          alert_crash_loop "$consecutive_short"
          consecutive_short=0
        fi
        launch
        last_launch=$(date +%s)
      else
        log "$SESSION DOWN but relaunch cap (${MAX_PER_HOUR}/h) reached -- backing off ${LONG_BACKOFF}s"
        sleep "$LONG_BACKOFF"
      fi
    fi
  fi
  sleep 30
done
