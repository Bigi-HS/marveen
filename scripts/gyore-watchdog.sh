#!/bin/bash
# Watchdog for agent-gyore (QA/tester agent, per-agent Telegram channel).
#
# Unlike dave-watchdog (which relaunches with --continue for task continuity),
# Györe is a CHANNEL agent: a --continue relaunch loses the --channels activation
# state ("server not in --channels list") and can hit the "No deferred tool
# marker" immediate-exit. So Györe is ALWAYS relaunched FRESH with --channels +
# its own TELEGRAM_STATE_DIR. Györe's durable state lives in the memory system,
# not the session transcript, so a fresh session is safe.
#
# Model is read from agent-config.json on every (re)launch.
#
# LISTENER-DROP DETECTION (card 4a2683e6): periodically check the per-agent
# gauge file written by scripts/hooks/channel-listener-gauge-write.py. If the
# file is stale (> LISTENER_STALE_SECONDS) while the tmux session is alive, the
# Telegram channel listener has silently dropped. Recovery: kill + fresh relaunch
# + inter-agent notify marveen.

SESSION=agent-gyore
AGENT_DIR=/home/domin/marveen/agents/gyore
CFG="$AGENT_DIR/.claude-config"
STATE="$AGENT_DIR/.claude/channels/telegram"
ACONF="$AGENT_DIR/agent-config.json"
LOG=/home/domin/marveen/store/gyore-watchdog.log
COOLDOWN=60
MAX_PER_HOUR=8

# Listener-drop config (env-overridable for Buster sandbox tests).
LISTENER_STATE_FILE="${GYORE_LISTENER_STATE_FILE:-/tmp/metrics/.agent-channel-gyore.json}"
LISTENER_STALE_SECONDS="${GYORE_LISTENER_STALE_SECONDS:-3600}"   # 60 min
LISTENER_CHECK_TICKS="${GYORE_LISTENER_CHECK_TICKS:-20}"         # check every 20 * 15s = 5 min; 0 = disable
DASH_PORT="${DASH_PORT:-3420}"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Cross-reference: marveen's inbound keepalive. If this is also stale, the whole
# fleet is quiet -- not a Gyore-specific listener drop. Env-overridable for tests.
MARVEEN_KEEPALIVE_FILE="${GYORE_MARVEEN_KEEPALIVE_FILE:-$INSTALL_DIR/store/.channel-keepalive}"

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

log "gyore-watchdog started (pid $$)"

# Relaunch-rate cap: file-backed sliding 1h window (0b282eb0 Phase-3).
STAMP_FILE="/tmp/wd-stamps-gyore"

# Send inter-agent message to marveen (best-effort, never blocks watchdog).
# Token is passed via env (not argv) to avoid ps-visibility.
notify_marveen() {
  local msg="$1"
  local token_file="$INSTALL_DIR/store/.dashboard-token"
  [ -f "$token_file" ] || return 0
  local tok; tok=$(cat "$token_file" 2>/dev/null) || return 0
  NOTIFY_TOKEN="$tok" python3 - "$msg" <<'PY' 2>/dev/null || true
import json, sys, os, urllib.request, urllib.error
token = os.environ.get('NOTIFY_TOKEN', '')
if not token:
    sys.exit(0)
msg = sys.argv[1]
body = json.dumps({'from': 'gyore', 'to': 'marveen', 'content': msg}).encode()
req = urllib.request.Request('http://localhost:3420/api/messages',
    data=body, method='POST',
    headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
try:
    urllib.request.urlopen(req, timeout=10)
except Exception:
    pass
PY
}

# Check if the Telegram listener is still alive.
# Returns 0 = OK (or no baseline / quiet period), 1 = confirmed listener drop.
#
# A stale gauge alone is NOT sufficient to declare a drop: a healthy-but-silent
# agent (no incoming Boss messages to reply to) produces a stale gauge naturally.
# Cross-check: if marveen's inbound keepalive is also stale for the same window,
# the whole fleet is quiet -- no Boss messages arrived at all. Only when marveen's
# keepalive is FRESH (Boss is sending, but Gyore hasn't replied) is the stale gauge
# a genuine drop signal. (acd7fa13 live-re-probe pattern, adapted for bash mtime.)
check_listener_drop() {
  [ -f "$LISTENER_STATE_FILE" ] || return 0   # no gauge: no baseline, don't trigger

  local mtime now age
  mtime=$(stat -c %Y "$LISTENER_STATE_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$(( now - mtime ))

  [ "$age" -ge "$LISTENER_STALE_SECONDS" ] || return 0   # gauge fresh -> OK

  # Gauge stale: cross-check marveen's inbound keepalive before declaring drop.
  if [ -f "$MARVEEN_KEEPALIVE_FILE" ]; then
    local ka_mtime ka_age
    ka_mtime=$(stat -c %Y "$MARVEEN_KEEPALIVE_FILE" 2>/dev/null || echo 0)
    ka_age=$(( now - ka_mtime ))
    if [ "$ka_age" -ge "$LISTENER_STALE_SECONDS" ]; then
      # Marveen is also quiet: fleet-wide quiet period, not a Gyore-specific drop.
      log "check_listener_drop: gauge stale ${age}s but marveen keepalive also stale ${ka_age}s -- quiet period, no action"
      return 0
    fi
  fi

  log "LISTENER-DROP: gauge stale ${age}s, marveen keepalive fresh -- $SESSION listener appears dead"
  return 1
}

_tick=0
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
  else
    # Session is alive -- periodically probe for silent listener drop.
    # LISTENER_CHECK_TICKS=0 disables the check (guard against div-by-zero).
    _tick=$(( _tick + 1 ))
    if [ "${LISTENER_CHECK_TICKS:-20}" -gt 0 ] && [ $(( _tick % LISTENER_CHECK_TICKS )) -eq 0 ]; then
      if ! check_listener_drop; then
        if wd_under_cap_file "$STAMP_FILE" "$MAX_PER_HOUR"; then
          log "LISTENER-DROP: killing $SESSION and performing fresh --channels relaunch"
          tmux kill-session -t "=$SESSION" 2>/dev/null || true
          sleep 2
          wd_under_cap_stamp "$STAMP_FILE"
          launch
          notify_marveen "gyore listener-drop auto-recovery: session killed and relaunched fresh (--channels). Messages received during the drop window may have been missed."
        else
          log "LISTENER-DROP: drop detected but relaunch cap (${MAX_PER_HOUR}/h) reached -- backing off"
          notify_marveen "gyore listener-drop detected but relaunch cap reached -- manual intervention may be needed."
        fi
      fi
    fi
  fi
  sleep 15
done
