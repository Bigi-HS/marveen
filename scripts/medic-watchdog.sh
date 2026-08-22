#!/bin/bash
# Medic break-glass operator bot watchdog (card fc252db2).
#
# WHY a watchdog: Medic (scripts/medic/bot.py) is the token-free, model-free
# Telegram recovery bot -- its whole value is being ALWAYS-ON so the Boss can
# command it even when the OAuth token is dead and the Claude fleet is frozen.
# A bot that can silently die defeats its own purpose, so this loop keeps it up.
#
# Medic is pure-Python stdlib (no Claude session, no MCP, no channels plugin),
# so the relaunch is trivial: if the bot.py process is gone, start it again in
# the `medic` tmux session. No --continue / --channels / resume-menu dance like
# the Claude agents -- that machinery does not apply to a plain daemon.
#
# Reboot-persistence is provided by fleet-supervisor.sh (ensure_medic_watchdog),
# which pgrep-skips a running watchdog and relaunches it otherwise; this script
# is launched 9>&- so it never inherits the supervisor flock fd.

ROOT=/home/domin/marveen
SESSION=medic
BOT="$ROOT/scripts/medic/bot.py"
ENV_FILE="$ROOT/store/medic-bot.env"
LOG="$ROOT/store/medic-watchdog.log"
BOT_LOG="$ROOT/store/medic.log"
INTERVAL=30

PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$PATH_CURATED"
PY="$(command -v python3)"

log() { echo "$(date -Is) $*" >> "$LOG"; }

bot_alive() { pgrep -f "scripts/medic/bot.py" >/dev/null 2>&1; }

launch() {
  # Fail closed if prerequisites are missing -- never spin a hot relaunch loop.
  if [ -z "$PY" ];        then log "ERROR: python3 not on PATH -- cannot launch";   return 1; fi
  if [ ! -f "$BOT" ];     then log "ERROR: $BOT missing -- not installed";          return 1; fi
  if [ ! -f "$ENV_FILE" ];then log "ERROR: $ENV_FILE missing -- no bot token";      return 1; fi
  tmux kill-session -t "=$SESSION" 2>/dev/null || true
  tmux new-session -d -s "$SESSION" \
    "cd '$ROOT' && exec '$PY' scripts/medic/bot.py 2>>'$BOT_LOG'"
  sleep 2
  if bot_alive; then log "launched Medic (tmux=$SESSION)"; else log "ERROR: Medic exited immediately after launch -- see $BOT_LOG"; fi
}

log "medic-watchdog started (pid $$, interval ${INTERVAL}s)"
while true; do
  if ! bot_alive; then
    log "Medic down -- relaunching"
    launch
  fi
  sleep "$INTERVAL"
done
