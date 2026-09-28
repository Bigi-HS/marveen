#!/usr/bin/env bash
# install-skill-audit-cron.sh -- idempotently register the K-2 skill-audit
# scanner as a weekly OS-level cron job that alerts marveen on findings.
# Card 1b4a5b99.
#
# WHY CRON (not scheduled-task): a scheduled-task only fires when the agent's
# tmux session is alive. The skill-audit is a security trip-wire that should
# run regardless of which agents are up, so an OS-level cron is the right
# mechanism (same reasoning as install-skill-regression-cron.sh, card 8a04b73d).
#
# DEPLOY step: run by the operator / Genesis-GO after the PR merges. Merging
# this script is inert until it is explicitly run.
#
# Idempotent: re-running replaces the existing line (matched by the marker),
# never duplicates, and preserves every other crontab entry.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# genesis-skill-audit-k2 (card 1b4a5b99)"
LOG="${INSTALL_DIR}/store/skill-audit-cron.log"
TOKEN_FILE="${INSTALL_DIR}/store/.dashboard-token"
# Weekly on Sunday at 06:30 local -- before the fleet day so findings are
# visible before Monday standup. Adjust schedule if daily cadence is preferred.
SCHEDULE="30 6 * * 0"
CMD="cd \"${INSTALL_DIR}\" && /usr/bin/env python3 scripts/skill-audit.py --alert-agent marveen --token-file \"${TOKEN_FILE}\" >> \"${LOG}\" 2>&1 || true"
LINE="${SCHEDULE} ${CMD} ${MARKER}"

mkdir -p "${INSTALL_DIR}/store"
touch "${LOG}"
chmod 600 "${LOG}"

current="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "$current" | grep -vF "$MARKER" || true)"

{
  printf '%s\n' "$filtered" | sed '/^$/d'
  printf '%s\n' "$LINE"
} | crontab -

echo "Installed skill-audit K-2 cron:"
echo "  ${LINE}"
echo "Verify:   crontab -l | grep skill-audit"
echo "Log:      ${LOG}"
echo "Dry-run:  python3 ${INSTALL_DIR}/scripts/skill-audit.py"
