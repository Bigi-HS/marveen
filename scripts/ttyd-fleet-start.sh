#!/bin/bash
# ttyd fleet viewer startup (card 78f0375e)
#
# Starts ttyd on a UNIX socket (no network binding) and registers the
# socket with tailscale serve for Tailscale-HTTPS-only access.
# Read-only by default; --writable flag requires Chad gate PASS (slice 3).
#
# SETUP (one-time):
#   echo 'username:password' > store/.ttyd-credential && chmod 600 store/.ttyd-credential
#
# START (via tmux, so it survives terminal close):
#   tmux new-window -t fleet-view: "cd /home/domin/marveen && bash scripts/ttyd-fleet-start.sh"
#
# Or foreground: bash scripts/ttyd-fleet-start.sh [--writable]
#
# Access: https://bigi.tail1a5fa5.ts.net:8443/terminal (tailnet only, HTTPS, basic-auth)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"
CRED_FILE="$INSTALL_DIR/store/.ttyd-credential"
SOCK="/tmp/ttyd-fleet.sock"
SERVE_PORT=8443
SERVE_PATH="/terminal"
WRITABLE=0

for arg in "$@"; do
    case "$arg" in
        --writable) WRITABLE=1 ;;
    esac
done

if [ ! -f "$CRED_FILE" ]; then
    echo "ERROR: $CRED_FILE not found."
    echo "Create: echo 'user:password' > $CRED_FILE && chmod 600 $CRED_FILE"
    exit 1
fi
chmod 600 "$CRED_FILE"
CREDENTIAL=$(cat "$CRED_FILE")
CREDENTIAL="${CREDENTIAL%$'\n'}"
if [ -z "$CREDENTIAL" ] || [[ "$CREDENTIAL" != *:* ]]; then
    echo "ERROR: credential must be 'username:password' format."
    exit 1
fi

if [ "$WRITABLE" -eq 1 ]; then
    echo "[ttyd-fleet] WARNING: WRITABLE mode -- requires Chad gate PASS (slice 3)"
fi

# Clean up any prior socket and ttyd instance
rm -f "$SOCK"
pgrep -f "ttyd.*ttyd-fleet-selector" > /dev/null 2>&1 && \
    pgrep -f "ttyd.*ttyd-fleet-selector" | xargs kill 2>/dev/null || true
sleep 0.3

# Build ttyd args: UNIX socket, basic auth, selector command
TTYD_ARGS=(-i "$SOCK" -p 0 -c "$CREDENTIAL" "$SCRIPT_DIR/ttyd-fleet-selector.sh")
[ "$WRITABLE" -eq 1 ] && TTYD_ARGS=(-W "${TTYD_ARGS[@]}")

echo "[ttyd-fleet] Starting ttyd on unix:$SOCK (readonly=$((1 - WRITABLE)))"
ttyd "${TTYD_ARGS[@]}" &
TTYD_PID=$!

# Wait for socket to appear (up to 3s)
for i in 1 2 3 4 5 6; do
    [ -S "$SOCK" ] && break
    sleep 0.5
done
if [ ! -S "$SOCK" ]; then
    echo "ERROR: ttyd socket did not appear. Check ttyd logs."
    kill $TTYD_PID 2>/dev/null
    exit 1
fi
echo "[ttyd-fleet] ttyd up (PID $TTYD_PID, socket OK)"

# Cleanup function: kill ttyd + remove tailscale serve route on exit
cleanup() {
    echo "[ttyd-fleet] Shutting down..."
    kill "$TTYD_PID" 2>/dev/null || true
    tailscale serve --https="$SERVE_PORT" --set-path="$SERVE_PATH" off 2>/dev/null || true
    rm -f "$SOCK"
}
trap cleanup EXIT INT TERM

# Register UNIX socket with tailscale serve (tailnet-only HTTPS)
echo "[ttyd-fleet] Registering tailscale serve https:$SERVE_PORT$SERVE_PATH -> unix:$SOCK"
exec tailscale serve --https="$SERVE_PORT" --set-path="$SERVE_PATH" unix://"$SOCK"
