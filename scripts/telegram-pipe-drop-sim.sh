#!/bin/bash
# Controlled drop-simulation for the Telegram MCP pipe, so the
# disconnect -> recovery path can be replayed on demand (Dominik's testability
# request). It kills the native Telegram plugin's `bun` MCP child for a target
# channel, exactly the death the watchdog must detect and recover.
#
# SAFETY: this NEVER uses `pkill -f`. It reads the PID from the channel's
# bot.pid file and signals ONLY that single PID, after verifying the process
# is actually the bun telegram child. Default target is the disposable Buster
# sandbox; targeting the live `main` orchestrator requires --confirm.
#
# Usage:
#   scripts/telegram-pipe-drop-sim.sh                 # target buster (safe)
#   scripts/telegram-pipe-drop-sim.sh --target buster
#   scripts/telegram-pipe-drop-sim.sh --target main --confirm
#
# After running, watch recovery with:
#   tail -f store/telegram-pipe-watchdog.log
# or run a single cycle immediately:
#   node dist/web/telegram-pipe-watchdog-cli.js

set -euo pipefail

TARGET="buster"
CONFIRM="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --confirm) CONFIRM="yes"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$TARGET" in
  buster) PIDFILE="/home/domin/marveen/agents/buster/.claude/channels/telegram/bot.pid" ;;
  main)
    PIDFILE="/home/domin/.claude/channels/telegram/bot.pid"
    if [ "$CONFIRM" != "yes" ]; then
      echo "Refusing to drop the LIVE main orchestrator pipe without --confirm." >&2
      echo "This will mute Genesis on Telegram until the watchdog (or a human /mcp) recovers it." >&2
      exit 3
    fi
    ;;
  *) echo "unknown target: $TARGET (use buster|main)" >&2; exit 2 ;;
esac

if [ ! -f "$PIDFILE" ]; then
  echo "No bot.pid at $PIDFILE -- is the $TARGET telegram pipe running?" >&2
  exit 4
fi

PID="$(cat "$PIDFILE" | tr -d '[:space:]')"
if ! [[ "$PID" =~ ^[0-9]+$ ]]; then
  echo "bot.pid does not contain a numeric PID: '$PID'" >&2
  exit 5
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID ($TARGET) is not alive -- nothing to drop." >&2
  exit 0
fi

# Verify the PID really is the bun telegram child before signalling it, so a
# recycled PID can never make us kill an unrelated process.
CMD="$(ps -o command= -p "$PID" 2>/dev/null || true)"
if ! printf '%s' "$CMD" | grep -qi 'bun'; then
  echo "PID $PID command does not look like the bun MCP child: '$CMD' -- aborting." >&2
  exit 6
fi

echo "Dropping $TARGET telegram pipe: SIGKILL pid $PID ($CMD)"
kill -9 "$PID"
echo "Dropped. The native plugin child is gone; the watchdog should detect a dead pipe on its next cycle."
echo "Watch: tail -f /home/domin/marveen/store/telegram-pipe-watchdog.log"
