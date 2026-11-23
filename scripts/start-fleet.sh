#!/bin/bash
# start-fleet.sh -- manual "start everything" entrypoint for the Genesis fleet
# (migration-readiness GAP G4). The human-run twin of the /etc/wsl.conf [boot]
# hook (scripts/fleet-boot.sh).
#
# WSL has no systemd, so there is no `systemctl start fleet`. This script is the
# single command to bring the whole fleet up by hand -- after a migration, after
# `wsl --shutdown`, or any time the supervisor is not running. It simply launches
# the always-on fleet-supervisor.sh, which then brings up (and keeps up) the
# dashboard, channels, watchdogs, and sub-agents on its first tick.
#
# Idempotent: fleet-supervisor.sh holds an flock, so if it is already running
# this is a no-op (it reports and exits 0). Safe to re-run.
#
# Usage: scripts/start-fleet.sh
# See docs/boot-persistence.md for the full boot chain and the autostart hook.

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUPERVISOR="$INSTALL_DIR/scripts/fleet-supervisor.sh"
LOG="$INSTALL_DIR/store/fleet-supervisor.log"

export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="${HOME:-/home/domin}"

if [ ! -f "$SUPERVISOR" ]; then
  echo "ERROR: fleet-supervisor.sh not found at $SUPERVISOR -- is this a complete checkout?" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR/store"

if pgrep -f "fleet-supervisor.sh" >/dev/null 2>&1; then
  echo "fleet-supervisor.sh already running (flock held) -- nothing to do."
  echo "Tail the log: tail -f $LOG"
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') [start-fleet] manual start -- launching fleet-supervisor" >> "$LOG"

# Detach so the supervisor outlives this shell (same model as fleet-boot.sh).
nohup bash "$SUPERVISOR" >> "$LOG" 2>&1 &
disown 2>/dev/null || true

echo "fleet-supervisor.sh launched. It brings up dashboard + channels + watchdogs on its first tick."
echo "Tail the log: tail -f $LOG"
echo "Verify the boot-persistence chain: scripts/verify-boot-persistence.sh"
exit 0
