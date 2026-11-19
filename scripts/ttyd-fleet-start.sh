#!/bin/bash
# ttyd fleet viewer startup (card 78f0375e)
#
# Starts ttyd on a UNIX socket (no network binding) and registers the
# socket with tailscale serve for Tailscale-HTTPS-only access.
#
# Auth: UNIX socket 0660 (domin-only) + Tailscale ACL (tailnet-isolated single-user).
# No --credential flag: credential plaintext leaks in ps aux (Chad MEDIUM, resolved).
#
# Read-only (default): direct tmux attach to DEFAULT_SESSION, no interactive selector.
# Writable (slice 3): selector UI -- requires separate Chad gate PASS (not yet).
#
# START (via tmux so it survives terminal close):
#   tmux new-window -t fleet-view: "cd /home/domin/marveen && bash scripts/ttyd-fleet-start.sh"
#
# Or foreground: bash scripts/ttyd-fleet-start.sh [--writable]
#
# Access: https://bigi.tail1a5fa5.ts.net:8443/terminal  (tailnet only, HTTPS)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOCK="/tmp/ttyd-fleet.sock"
SERVE_PORT=8443
SERVE_PATH="/terminal"
WRITABLE=0
# Default read-only view session; override with DEFAULT_SESSION env var.
DEFAULT_SESSION="${DEFAULT_SESSION:-marveen}"

for arg in "$@"; do
    case "$arg" in
        --writable) WRITABLE=1 ;;
    esac
done

if [ "$WRITABLE" -eq 1 ]; then
    echo "[ttyd-fleet] WARNING: WRITABLE mode -- separate Chad gate PASS required (slice 3)"
fi

# Clean up any prior socket and ttyd instance
rm -f "$SOCK"
pgrep -f "ttyd.*ttyd-fleet" > /dev/null 2>&1 && \
    pgrep -f "ttyd.*ttyd-fleet" | xargs kill 2>/dev/null || true
sleep 0.3

# Build ttyd command:
#   Read-only: direct attach to DEFAULT_SESSION with tmux -r flag (belt+suspenders).
#   Writable (slice 3): interactive selector script.
if [ "$WRITABLE" -eq 0 ]; then
    TTYD_CMD=(tmux attach -t "$DEFAULT_SESSION" -r)
    TTYD_ARGS=(-i "$SOCK" -p 0 "${TTYD_CMD[@]}")
else
    TTYD_ARGS=(-W -i "$SOCK" -p 0 "$SCRIPT_DIR/ttyd-fleet-selector.sh")
fi

echo "[ttyd-fleet] Starting ttyd on unix:$SOCK (readonly=$((1 - WRITABLE)), session=${DEFAULT_SESSION})"
ttyd "${TTYD_ARGS[@]}" &
TTYD_PID=$!

# Wait for socket to appear (up to 3s)
for i in 1 2 3 4 5 6; do
    [ -S "$SOCK" ] && break
    sleep 0.5
done
if [ ! -S "$SOCK" ]; then
    echo "ERROR: ttyd socket did not appear."
    kill "$TTYD_PID" 2>/dev/null
    exit 1
fi
echo "[ttyd-fleet] ttyd up (PID $TTYD_PID, socket OK)"

# Guard: verify no TCP port was opened (ttyd must stay on UNIX socket only)
if ss -tlnp 2>/dev/null | grep -q "ttyd"; then
    echo "ERROR: ttyd opened a TCP port -- unexpected. Aborting."
    kill "$TTYD_PID" 2>/dev/null
    rm -f "$SOCK"
    exit 1
fi

# Cleanup: kill ttyd + remove tailscale serve route on EXIT/INT/TERM.
# MUST be set before the tailscale serve call (not after exec) so the trap survives.
cleanup() {
    echo "[ttyd-fleet] Shutting down..."
    kill "$TTYD_PID" 2>/dev/null || true
    tailscale serve --https="$SERVE_PORT" --set-path="$SERVE_PATH" off 2>/dev/null || true
    rm -f "$SOCK"
}
trap cleanup EXIT INT TERM

# Register UNIX socket with tailscale serve (tailnet-only HTTPS).
# Run as background + wait (NOT exec) so the trap above survives tailscale exit.
echo "[ttyd-fleet] Registering tailscale serve https:$SERVE_PORT$SERVE_PATH -> unix:$SOCK"
tailscale serve --https="$SERVE_PORT" --set-path="$SERVE_PATH" unix://"$SOCK" &
TS_PID=$!
wait "$TS_PID"
