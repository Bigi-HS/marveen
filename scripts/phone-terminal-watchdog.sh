#!/bin/bash
# Watchdog for phone-terminal (ttyd on 127.0.0.1:7681 + tailscale serve).
# Binds ONLY to loopback -- tailscale serve provides TLS + tailnet-only access.
# Auth: Tailscale-User-Login header injected by tailscale serve for every
# authenticated tailnet device -- ttyd delegates the auth decision to tailscale
# (-H/--auth-header mode) so no static credential ever appears in the process list.
# Tailscale's serve --https STRIPS any client-supplied Tailscale-User-Login before
# forwarding, so the header cannot be forged from the internet side. Funnel is OFF.
#
# DEPLOY GATE -- two tests required before going live:
# 1) POSITIVE: connect from a tailnet device to :8443/terminal/ -- expect 200.
#    If 401: header not forwarded, use fallback (unix socket or dedicated OS user).
# 2) NEGATIVE (fail-closed): curl http://127.0.0.1:7681/terminal/ (loopback, no
#    Tailscale-User-Login header) -- expect 401, not 200. Confirms fail-closed.
#
# LOCAL LOOPBACK EXPOSURE (by design, unchanged): a local process on the same
# OS user can curl 127.0.0.1:7681 with a forged header and get a shell. This
# is not a new capability -- that process can already do `tmux attach -t phone`
# directly. The old basic-auth was bypassable by reading /proc/<pid>/cmdline.
#
# CLEANUP after cutover: delete store/phone-terminal.creds (stale credential file).
#
# No systemd on WSL2 -- kept alive by this watchdog running in tmux.

INSTALL_DIR=/home/domin/marveen
TTYD="$INSTALL_DIR/store/bin/ttyd"
PORT=7681
SESSION_NAME=phone
LOG="$INSTALL_DIR/store/phone-terminal-watchdog.log"
COOLDOWN=10

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

check_ttyd() {
  # Returns 0 if ttyd is listening on 127.0.0.1:7681
  ss -tlnp 2>/dev/null | grep -q ":${PORT}.*127.0.0.1\|:${PORT}.*\[::1\]" || \
  ss -tlnp 2>/dev/null | grep -q "127.0.0.1:${PORT}"
}

start_ttyd() {
  log "Starting ttyd on 127.0.0.1:$PORT (auth-header=Tailscale-User-Login, base-path=/terminal/)"
  # -i = interface bind, -H = header name for auth proxy (tailscale injects this
  # for every authenticated tailnet device), -b = base-path for reverse-proxy.
  # No --credential flag: the static user:pass is gone from the process list.
  # Tailscale serve on port 8443 (tailnet-only) injects Tailscale-User-Login for
  # authenticated devices; ttyd accepts any non-empty value as authorized.
  nohup "$TTYD" \
    --interface 127.0.0.1 \
    --port "$PORT" \
    --auth-header Tailscale-User-Login \
    --base-path /terminal/ \
    --writable \
    tmux new-session -A -s "$SESSION_NAME" \
    >> "$LOG" 2>&1 &
  local pid=$!
  log "ttyd launched (pid=$pid)"
  sleep 2
  if check_ttyd; then
    log "ttyd confirmed listening on :$PORT"
    return 0
  else
    log "WARN: ttyd did not bind within 2s"
    return 1
  fi
}

ensure_tailscale_serve() {
  # Add the /terminal path mount, TAILNET-ONLY (never funneled -- a public shell
  # is out of the question). The port depends on whether the dashboard is being
  # published to the public internet:
  #
  #   - DEFAULT (no store/tailscale-funnel.enabled flag): the dashboard is
  #     tailnet-only on the default HTTPS port (443), and the terminal shares it
  #     at /terminal. This is the historical behavior.
  #   - PUBLIC dashboard (flag present): the dashboard is FUNNELED on 443, so the
  #     terminal MUST move off 443 or it would be published too. We serve it on a
  #     separate tailnet-only HTTPS port (8443), matching tailscale-serve-public.sh.
  #
  # Funnel is per-port, so isolating the terminal on its own port is the only way
  # to keep the shell private while the dashboard is public.
  local flag="$(dirname "$0")/../store/tailscale-funnel.enabled"
  if [ -f "$flag" ]; then
    local term_port=8443
    if tailscale serve status 2>/dev/null | grep -q ":$term_port"; then
      log "tailscale serve terminal (public-mode :$term_port) already configured"
      return 0
    fi
    log "Configuring tailscale serve (public mode): terminal tailnet-only on :$term_port -> http://127.0.0.1:$PORT/terminal"
    tailscale serve --bg --https "$term_port" --set-path /terminal "http://127.0.0.1:$PORT/terminal" >> "$LOG" 2>&1
    local rc=$?
    [ $rc -eq 0 ] && log "tailscale serve terminal (:$term_port) configured" || log "WARN: tailscale serve exited $rc"
    tailscale serve status >> "$LOG" 2>&1
    return $rc
  fi
  # DEFAULT tailnet-only path on the shared 443 mount.
  # Root / is already served by the dashboard (127.0.0.1:3420).
  if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
    log "tailscale serve /terminal already configured"
    return 0
  fi
  # Target MUST include the /terminal path: tailscale serve STRIPS the mount prefix,
  # and ttyd runs with --base-path /terminal/ -- so we re-add /terminal in the target
  # to preserve the full path end-to-end (else ttyd receives / and 404s -> "won't load").
  log "Configuring tailscale serve: /terminal -> http://127.0.0.1:$PORT/terminal"
  tailscale serve --bg --set-path /terminal "http://127.0.0.1:$PORT/terminal" >> "$LOG" 2>&1
  local rc=$?
  if [ $rc -eq 0 ]; then
    log "tailscale serve /terminal configured"
    tailscale serve status >> "$LOG" 2>&1
  else
    log "WARN: tailscale serve exited $rc ($(tailscale serve status 2>&1 | head -3))"
  fi
  return $rc
}

log "phone-terminal-watchdog started (pid=$$)"

# Initial setup
ensure_tailscale_serve

while true; do
  if ! check_ttyd; then
    log "ttyd not running -- restarting (cooldown ${COOLDOWN}s)"
    sleep "$COOLDOWN"
    start_ttyd
  fi
  sleep 30
done
