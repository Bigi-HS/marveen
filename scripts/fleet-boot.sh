#!/bin/bash
# fleet-boot.sh -- WSL boot entrypoint for the Genesis fleet.
#
# Invoked once at WSL start by /etc/wsl.conf:
#   [boot]
#   command = su - domin -c '/home/domin/marveen/scripts/fleet-boot.sh'
#
# The [boot] command runs as root with a bare environment; the `su - domin -c`
# wrapper re-enters domin's login shell so HOME/PATH/auth are correct. This
# script's only job is to start the always-on supervisor, which then brings up
# (and keeps up) the dashboard + channels + sub-agents on its first tick.
#
# Idempotent: fleet-supervisor.sh holds an flock, so a second invocation is a
# no-op. Safe to run by hand too: scripts/fleet-boot.sh

set -u
INSTALL_DIR="/home/domin/marveen"
LOG="$INSTALL_DIR/store/fleet-supervisor.log"
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="${HOME:-/home/domin}"

mkdir -p "$INSTALL_DIR/store"
echo "$(date '+%Y-%m-%d %H:%M:%S') [fleet-boot] WSL boot -- scheduling fleet-supervisor" >> "$LOG"

# Detach fully so the WSL [boot] command returns immediately and does not stall
# boot. The subshell waits a few seconds for networking/loopback to come up
# (first dashboard health probe + token-bearing launches need it), then starts
# the always-on supervisor.
(
  sleep 8
  nohup bash "$INSTALL_DIR/scripts/fleet-supervisor.sh" >> "$LOG" 2>&1
) >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
