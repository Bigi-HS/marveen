#!/usr/bin/env bash
# Boss mobile session bridge (card 78f0375e, Boss TG9599/9601).
# Serves a shared tmux session "boss" over a web terminal (ttyd) bound to
# LOCALHOST only, with basic auth, writable (phone can type). Tailnet exposure is
# done by the pre-existing `tailscale serve` mapping (tailnet-only, NOT funnel):
#     https://bigi.tail1a5fa5.ts.net:8443/terminal  ->  http://127.0.0.1:7681/terminal
# WSL tailscale is userspace-networking, so we cannot bind the 100.x IP directly;
# binding localhost + letting tailscale serve proxy it is the correct pattern.
#
# Access from phone (phone must be on the tailnet):
#     https://bigi.tail1a5fa5.ts.net:8443/terminal
# The desktop side joins the SAME session with:  tmux attach -t boss
# Run Claude inside that tmux and the phone sees + controls it live.
#
# Usage: scripts/boss-session-bridge.sh {start|stop|restart|status}
# Credentials file (git-ignored): store/.boss-bridge-cred  (format: user:pass)
set -euo pipefail

PORT="${BOSS_BRIDGE_PORT:-7681}"
BASEPATH="${BOSS_BRIDGE_BASE:-/terminal}"
BIND="127.0.0.1"
SESSION="boss"
CRED_FILE="/home/domin/marveen/store/.boss-bridge-cred"
PIDFILE="/tmp/boss-session-bridge.pid"

tailnet_ip() { tailscale ip -4 2>/dev/null | head -1; }

ensure_cred() {
  if [[ ! -s "$CRED_FILE" ]]; then
    local pw
    pw="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
    printf 'noa:%s' "$pw" > "$CRED_FILE"
    chmod 600 "$CRED_FILE"
  fi
}

start() {
  ensure_cred
  tmux has-session -t "=$SESSION" 2>/dev/null || tmux new-session -d -s "$SESSION"
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "already running (pid $(cat "$PIDFILE"))"; status; return 0
  fi
  local cred
  cred="$(cat "$CRED_FILE")"
  # -i 127.0.0.1: localhost only (tailscale serve does the tailnet exposure)
  # -b /terminal: base path matching the existing serve mapping
  # -c user:pass: basic auth   -W: writable   -t: terminal tweaks
  nohup ttyd -i "$BIND" -p "$PORT" -b "$BASEPATH" -c "$cred" -W \
    -t titleFixed="NoA :: boss session" -t fontSize=15 \
    tmux new-session -A -s "$SESSION" \
    >/tmp/boss-session-bridge.log 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  status
}

stop() {
  [[ -f "$PIDFILE" ]] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "stopped"
}

status() {
  local serve_url
  serve_url="$(tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+:8443' | head -1)"
  [[ -n "$serve_url" ]] && serve_url="${serve_url}${BASEPATH}" || serve_url="(tailscale serve mapping not found)"
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "RUNNING pid=$(cat "$PIDFILE")  local=http://${BIND}:${PORT}${BASEPATH}  phone=${serve_url}  user=$(cut -d: -f1 "$CRED_FILE")"
  else
    echo "NOT running"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
