#!/bin/bash
# Standalone token-outage auto-ACK watcher (P3, Boss #1: keep Genesis usable
# token-free during a Claude account usage-limit outage).
#
# WHY a separate process: when the shared Claude account hits its usage limit the
# main orchestrator (marveen-channels) freezes on the limit menu and silently
# stops processing inbound (the token-reset-idle-gap). This loop is deterministic
# and uses ZERO Claude tokens: each ~30s cycle the node CLI captures the main
# session's pane, and on the healthy<->limited EDGE it ACKs the operator on
# Telegram + captures the queued inbound to a kanban card; on reset it sends a
# back-online message and re-dispatches the queue (reusing the main-session
# --continue respawn). It is independent of the dashboard so it keeps working
# even while the account is limited.
#
# Cadence is 30s for a low ack latency. The CLI is short-timeout bounded, so the
# loop never wedges. Events are logged to store/token-outage-watch.sh.log.

ROOT=/home/domin/marveen
LOG="$ROOT/store/token-outage-watch.sh.log"
INTERVAL=30

# Curated PATH so node/tmux resolve the same way the supervisor launches them.
PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$PATH_CURATED"
NODE="$(command -v node)"

# Operator chat for the ACK / back-online messages (Dominik's chat).
export WATCHDOG_ALERT_CHAT_ID="${WATCHDOG_ALERT_CHAT_ID:-8643929442}"
export MARVEEN_ROOT="$ROOT"

log() { echo "$(date -Is) $*" >> "$LOG"; }
log "token-outage-watch started (pid $$, interval ${INTERVAL}s)"

while true; do
  if [ -z "$NODE" ]; then
    log "ERROR: node not found on PATH -- skipping cycle"
  elif [ ! -f "$ROOT/dist/web/token-outage-cli.js" ]; then
    log "ERROR: CLI not built (dist/web/token-outage-cli.js missing) -- run npm run build"
  else
    out="$(cd "$ROOT" && timeout 45 "$NODE" dist/web/token-outage-cli.js 2>>"$LOG")"
    log "cycle: ${out:-<no output / timeout>}"
  fi
  sleep "$INTERVAL"
done
