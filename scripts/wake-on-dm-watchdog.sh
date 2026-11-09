#!/bin/bash
# wake-on-dm-watchdog.sh -- keeps wake-on-dm-daemon.py running.
# Managed by fleet-supervisor ensure_wake_on_dm_daemon() (post-pilot).
# For the buster pilot: started manually once; this watchdog restarts on crash.

INSTALL_DIR=/home/domin/marveen
LOG="$INSTALL_DIR/store/wake-on-dm.log"
DAEMON="$INSTALL_DIR/scripts/wake-on-dm-daemon.py"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [wake-on-dm-watchdog] $*" | tee -a "$LOG" >&2; }

log "watchdog started (pid $$)"

while true; do
    if ! pgrep -f "wake-on-dm-daemon.py" >/dev/null 2>&1; then
        log "daemon not running -- starting"
        python3 "$DAEMON" &
        sleep 5
    fi
    sleep 15
done
