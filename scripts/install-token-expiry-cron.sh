#!/usr/bin/env bash
# install-token-expiry-cron.sh -- idempotently register the proactive token-expiry
# monitor as a daily cron job. Card 1493e3e8.
#
# WHY CRON (not a scheduled-task): a scheduled-task only fires when the agent's tmux
# session is alive. This monitor must run precisely when the fleet may be DOWN
# (auth-dead), so it has to be OS-level + token-free. Same reasoning as Hibiki's
# survival and the Medic break-glass watchdog.
#
# This is a DEPLOY step, run by the operator / Genesis-GO, NOT on merge. Merging the
# monitor is inert until this installs the cron line.
#
# Idempotent: re-running replaces the existing line (matched by the marker), never
# duplicates, and preserves every other crontab entry.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# genesis-token-expiry-monitor (card 1493e3e8)"
# Daily at 08:30 local. A 21-day warning window makes once-a-day ample.
SCHEDULE="30 8 * * *"
CMD="cd ${INSTALL_DIR} && /usr/bin/python3 scripts/token-expiry-monitor.py --once >> ${INSTALL_DIR}/store/token-expiry-monitor.log 2>&1"
LINE="${SCHEDULE} ${CMD} ${MARKER}"

current="$(crontab -l 2>/dev/null || true)"
# Drop any prior copy of our line (match the marker), keep everything else.
filtered="$(printf '%s\n' "$current" | grep -vF "$MARKER" || true)"

{
  printf '%s\n' "$filtered" | sed '/^$/d'
  printf '%s\n' "$LINE"
} | crontab -

echo "Installed token-expiry-monitor cron:"
echo "  $LINE"
echo "Verify with: crontab -l | grep token-expiry"
