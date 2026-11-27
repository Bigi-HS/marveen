#!/bin/bash
# ttyd fleet viewer startup (card 78f0375e)
#
# Starts ttyd on a UNIX socket (no network binding) and registers the
# socket with tailscale serve for Tailscale-HTTPS-only access.
#
# Auth layers:
#   Read-only:  UNIX socket 0660 + Tailscale ACL (tailnet-only, no credential needed).
#   Writable:   Tailscale ACL + HTTP basic auth (-c from store/.ttyd-fleet-write-cred).
#               Credential auto-generated (noa:RANDOM16), chmod 600.
#               Pattern: same as boss-session-bridge.sh.
#
# START (via tmux so it survives terminal close):
#   tmux new-window -t fleet-view: "cd /home/domin/marveen && bash scripts/ttyd-fleet-start.sh"
#
# Or foreground: bash scripts/ttyd-fleet-start.sh [--writable]
#
# Access: https://bigi.tail1a5fa5.ts.net:8443/terminal-fleet  (tailnet only, HTTPS)
# Write:  same URL (browser will prompt for credentials from store/.ttyd-fleet-write-cred)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOCK="/tmp/ttyd-fleet.sock"
SERVE_PORT=8443
SERVE_PATH="/terminal-fleet"
CRED_FILE="$REPO_ROOT/store/.ttyd-fleet-write-cred"
WRITABLE=0
# Default read-only view session; override with DEFAULT_SESSION env var.
DEFAULT_SESSION="${DEFAULT_SESSION:-marveen}"

for arg in "$@"; do
    case "$arg" in
        --writable) WRITABLE=1 ;;
    esac
done

if [ "$WRITABLE" -eq 1 ]; then
    if [ "${TTYD_WRITE_AUTHORIZED:-0}" != "1" ]; then
        echo "ERROR: --writable requires TTYD_WRITE_AUTHORIZED=1 (set after Chad write-gate PASS)." >&2
        exit 2
    fi
    echo "[ttyd-fleet] WRITABLE mode authorized (TTYD_WRITE_AUTHORIZED=1)"
fi

ensure_write_cred() {
    if [ ! -s "$CRED_FILE" ]; then
        local pw
        pw="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
        printf 'noa:%s' "$pw" > "$CRED_FILE"
        chmod 600 "$CRED_FILE"
        echo "[ttyd-fleet] Write credential generated: $CRED_FILE"
    fi
}

# Clean up any prior socket and ttyd instance
rm -f "$SOCK"
pgrep -f "ttyd.*ttyd-fleet" > /dev/null 2>&1 && \
    pgrep -f "ttyd.*ttyd-fleet" | xargs kill 2>/dev/null || true
sleep 0.3

# Build ttyd command:
#   Read-only: direct attach to DEFAULT_SESSION with tmux -r flag.
#   Writable: interactive selector script + basic auth credential.
if [ "$WRITABLE" -eq 0 ]; then
    TTYD_ARGS=(-i "$SOCK" -p 0 tmux attach -t "$DEFAULT_SESSION" -r)
else
    ensure_write_cred
    local_cred="$(cat "$CRED_FILE")"
    TTYD_ARGS=(-W -c "$local_cred" -i "$SOCK" -p 0 "$SCRIPT_DIR/ttyd-fleet-selector.sh")
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

# Explicit socket permissions: 0660 (domin rw, group rw, other none).
chmod 0660 "$SOCK"

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
