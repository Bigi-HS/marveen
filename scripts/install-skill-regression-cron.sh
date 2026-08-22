#!/usr/bin/env bash
# install-skill-regression-cron.sh -- idempotently register the skill-regression
# harness as a daily cron job that refreshes store/skill-regression-badge.json.
# Card 8a04b73d.
#
# WHY CRON (not a scheduled-task): a scheduled-task only fires when the agent's tmux
# session is alive. The badge should reflect the live ~/.claude/skills health every
# day regardless of which agents are up, so an OS-level, token-free cron is the right
# mechanism (same reasoning as the token-expiry monitor, card 1493e3e8).
#
# This is a DEPLOY step, run by the operator / Genesis-GO, NOT on merge. Merging this
# script is inert until you explicitly run it. The harness and badge writer ship in
# scripts/skill-regression.sh; this only schedules them.
#
# Idempotent: re-running replaces the existing line (matched by the marker), never
# duplicates, and preserves every other crontab entry.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# genesis-skill-regression-badge (card 8a04b73d)"
LOG="${INSTALL_DIR}/store/skill-regression-cron.log"
# Daily at 07:45 local -- before the 08:00 fleet day so the badge is fresh by morning.
SCHEDULE="45 7 * * *"
# Quote the paths so a space-bearing install dir can't break the `cd`. The harness
# does not exit-fail the cron (a WARN/BLOCK verdict is informational, the badge file
# carries the signal), so `|| true` keeps cron mail quiet on a non-zero verdict.
CMD="cd \"${INSTALL_DIR}\" && /usr/bin/env bash scripts/skill-regression.sh >> \"${LOG}\" 2>&1 || true"
LINE="${SCHEDULE} ${CMD} ${MARKER}"

# Pre-create the log so cron's `>>` appends to an existing file under a tidy umask.
mkdir -p "${INSTALL_DIR}/store"
touch "${LOG}"
chmod 600 "${LOG}"

current="$(crontab -l 2>/dev/null || true)"
# Drop any prior copy of our line (match the marker), keep everything else.
filtered="$(printf '%s\n' "$current" | grep -vF "$MARKER" || true)"

{
  printf '%s\n' "$filtered" | sed '/^$/d'
  printf '%s\n' "$LINE"
} | crontab -

echo "Installed skill-regression-badge cron:"
echo "  $LINE"
echo "Verify with: crontab -l | grep skill-regression"
echo "Badge file:  ${INSTALL_DIR}/store/skill-regression-badge.json"
