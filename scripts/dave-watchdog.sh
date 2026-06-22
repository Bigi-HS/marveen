#!/bin/bash
# STOPGAP watchdog: keeps agent-dave alive and auto-resumes his task with
# --continue after a death (429 rate-limit / token exhaustion or a crash).
# Bridge until Dave's permanent token-resilience supervisor (kanban f323c9de)
# ships. Remove this once that lands.
#
# Model is read from agent-config.json on every (re)launch, so switching Dave's
# model = edit that file; both manual relaunch and this watchdog pick it up.
# Backoff: after a death, wait COOLDOWN before relaunch (avoid hammering during
# a 429 storm). Caps relaunches per hour.

CFG=/home/domin/marveen/agents/dave/.claude-config
ACONF=/home/domin/marveen/agents/dave/agent-config.json
LOG=/home/domin/marveen/store/dave-watchdog.log
COOLDOWN=60
MAX_PER_HOUR=8

# T8 (Thor stack-review spec-gap): this reads the EXPLICIT `model` field only.
# It does NOT know about archetype-based resolution (PR#8
# resolveAgentModelFromConfig). Today both Dave and Thor carry an explicit model,
# so the fallback below never fires -- but if a future archetype migration REMOVES
# the explicit model field, this watchdog would silently relaunch on the
# claude-sonnet-4-6 fallback instead of the archetype-resolved model. DO NOT drop
# the explicit `model` field from agent-config.json while these bash watchdogs are
# in use, or teach read_model the archetype map first.
read_model() {
  # Prints the configured model on the happy path. On a missing/unparseable
  # config or absent 'model' field, emit a LOUD warning (log + stderr) so the
  # misconfig is visible, then still default (don't hard-stop the agent).
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
       echo "WARN read_model: $ACONF missing or unparseable -> defaulting to claude-sonnet-4-6" >&2
       echo claude-sonnet-4-6 ;;
    *) log "WARN read_model: $ACONF has no 'model' field -> defaulting to claude-sonnet-4-6"
       echo "WARN read_model: $ACONF has no 'model' field -> defaulting to claude-sonnet-4-6" >&2
       echo claude-sonnet-4-6 ;;
  esac
}

# claude --continue on an old/large session shows an interactive menu:
#   "This session is Xh old and N tokens.
#    1. Resume from summary (recommended)  2. Resume full  3. Don't ask again"
# A detached tmux launch has NO ONE to answer it, so Dave freezes at the menu,
# does zero work, and gets reaped ~235s later. THIS was the real cause of the
# "dies after 235s, likely 429" loop -- it was never a rate limit, just an
# unanswered prompt. Poll the pane and pick "1" (resume from summary = cheapest)
# when the menu shows. If the session is fresh/small the menu never appears and
# we return as soon as the normal prompt is up.
answer_resume_prompt() {
  local i pane
  for i in $(seq 1 20); do
    sleep 2
    pane="$(tmux capture-pane -t agent-dave -p 2>/dev/null)"
    if printf '%s' "$pane" | grep -q 'Resume from summary'; then
      tmux send-keys -t agent-dave '1'; sleep 1; tmux send-keys -t agent-dave Enter
      log "answered resume-prompt -> 1 (resume from summary)"
      return 0
    fi
    if printf '%s' "$pane" | grep -q 'bypass permissions on'; then
      log "agent-dave reached active prompt (no resume menu)"
      return 0
    fi
  done
  log "WARN: neither resume menu nor active prompt seen within 40s"
}

launch() {
  local model; model="$(read_model)"
  local cmd="export PATH=\"/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && cd \"/home/domin/marveen/agents/dave\" && export FLEET_ROOT=/home/domin/marveen && . /home/domin/marveen/scripts/lib/fleet-oauth-env.sh && /usr/bin/claude --continue --dangerously-skip-permissions --model '$model'"
  tmux new-session -d -s agent-dave "$cmd"
  log "launched agent-dave (--continue, model=$model) -- watching for resume menu"
  answer_resume_prompt
}

# Fresh launch without --continue: used when a crash-loop is detected (session
# too large or poisoned -- resuming it would just loop again immediately).
launch_fresh() {
  local model; model="$(read_model)"
  local cmd="export PATH=\"/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CONFIG_DIR=\"$CFG\" && cd \"/home/domin/marveen/agents/dave\" && export FLEET_ROOT=/home/domin/marveen && . /home/domin/marveen/scripts/lib/fleet-oauth-env.sh && /usr/bin/claude --dangerously-skip-permissions --model '$model'"
  tmux new-session -d -s agent-dave "$cmd"
  log "launched agent-dave (FRESH/no --continue, model=$model) -- crash-loop recovery"
}

# Alert marveen via inter-agent API when a crash-loop forces a fresh relaunch.
alert_crash_loop() {
  local count="$1"
  local tok; tok=$(cat /home/domin/marveen/store/.dashboard-token 2>/dev/null) || return
  python3 - "$count" "$tok" <<'PY' 2>/dev/null || log "WARN: alert_crash_loop could not reach dashboard API"
import urllib.request, json, sys
count, tok = sys.argv[1], sys.argv[2]
msg = f"CRASH-LOOP alert: agent-dave had {count} consecutive sub-90s deaths -- did ONE fresh relaunch (dropped --continue). Check store/dave-watchdog.log."
data = json.dumps({"from":"forge","to":"marveen","content":msg}).encode()
req = urllib.request.Request("http://localhost:3420/api/messages", data=data,
      headers={"Content-Type":"application/json","Authorization":f"Bearer {tok}"}, method="POST")
urllib.request.urlopen(req, timeout=5)
PY
}

log() { echo "$(date -Is) $*" >> "$LOG"; }
log "watchdog started (pid $$)"

# Adaptive backoff for GENUINE crash loops only. The old "dies after 235s = 429"
# theory was a misdiagnosis: the real cause was the unanswered resume menu, now
# handled by answer_resume_prompt(). If Dave still dies quickly after that fix,
# it's a real crash (or, occasionally, an actual 429) -- back off so we don't
# hammer, but not for the old absurd 30min, since the frozen-menu case is gone.
SHORT_LIVED=180
LONG_BACKOFF=600
# Crash-loop detection: N consecutive deaths each lived <THRESHOLD -> fresh relaunch.
# Observed 2026-06-22: poisoned/large session hits session-limit ~60s post-launch
# and loops forever on --continue. Ref: dave-634k-session-limit-incident.
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
  if ! tmux has-session -t agent-dave 2>/dev/null; then
    now=$(date +%s); lived=$(( now - last_launch ))
    if [ "$last_launch" -ne 0 ] && [ "$lived" -lt "$CRASH_LOOP_THRESHOLD" ]; then
      consecutive_short=$((consecutive_short + 1))
      log "agent-dave sub-${CRASH_LOOP_THRESHOLD}s death #${consecutive_short} (lived ${lived}s) -- backoff ${LONG_BACKOFF}s"
      sleep "$LONG_BACKOFF"
    elif [ "$last_launch" -ne 0 ] && [ "$lived" -lt "$SHORT_LIVED" ]; then
      consecutive_short=0
      log "agent-dave died after only ${lived}s (genuine crash or real 429) -- backoff ${LONG_BACKOFF}s"
      sleep "$LONG_BACKOFF"
    else
      consecutive_short=0
      log "agent-dave DOWN (lived ${lived}s) -- cooldown ${COOLDOWN}s then --continue relaunch"
      sleep "$COOLDOWN"
    fi
    if ! tmux has-session -t agent-dave 2>/dev/null; then
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
      else
        log "agent-dave DOWN but relaunch cap (${MAX_PER_HOUR}/h) reached -- backing off ${LONG_BACKOFF}s"
        sleep "$LONG_BACKOFF"
      fi
    fi
  fi
  sleep 30
done
