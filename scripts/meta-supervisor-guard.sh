#!/bin/bash
# meta-supervisor-guard.sh -- watchdog-of-the-watchdog (card 45750614)
#
# fleet-supervisor.sh is the root of all agent/watchdog lifecycle management.
# If IT dies (without a WSL reboot), no ensure_* function fires and all watchdogs
# silently degrade. fleet-boot.sh only runs at WSL boot, so there is no
# auto-recovery until the next reboot.
#
# This tiny guard runs from system cron every 5 minutes (independent of the
# fleet). It pgrep-checks the supervisor and relaunches it the same way
# fleet-boot.sh does when absent. The supervisor's own flock(-n) ensures a
# second instance is a safe no-op if a race occurs.
#
# Cron entry (added by 45750614 implementation):
#   */5 * * * * bash /home/domin/marveen/scripts/meta-supervisor-guard.sh
#
# Verify: kill -9 <supervisor-pid>; wait up to 5 min; pgrep fleet-supervisor
# should show a new PID.

set -u

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$INSTALL_DIR/store/fleet-supervisor.log"
GUARD_LOG="$INSTALL_DIR/store/meta-supervisor-guard.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [meta-guard] $*" >> "$GUARD_LOG"; }

# pgrep matches the daemon invocation (no --once / --dry-run flags).
# The pattern is intentionally narrow: only the daemon form, not test invocations.
if pgrep -f "scripts/fleet-supervisor.sh" >/dev/null 2>&1; then
  exit 0   # supervisor alive, nothing to do (silent)
fi

log "fleet-supervisor not detected -- relaunching"
nohup bash "$INSTALL_DIR/scripts/fleet-supervisor.sh" >> "$LOG" 2>&1 &
log "relaunch dispatched (pid $!)"
