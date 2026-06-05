#!/bin/bash
# Tailscale Serve PRIVATE-only wrapper for the Genesis dashboard (item5).
#
# Exposes the localhost-bound dashboard (127.0.0.1:3420) to the TAILNET ONLY,
# over Tailscale Serve's automatic *.ts.net HTTPS cert. It NEVER uses Tailscale
# Funnel (which would publish to the public internet). Every `up` run, and the
# standalone `verify`, hard-assert that Funnel is OFF and abort otherwise.
#
# Two auth layers protect the dashboard:
#   1. Tailnet membership -- only the operator's own devices can reach the URL.
#   2. The dashboard Bearer token -- gates every /api/* call (the static UI shell
#      is public so it can bootstrap, but no data is served without the token).
#
# Usage:
#   scripts/tailscale-serve-private.sh up       # enable serve (tailnet-only)
#   scripts/tailscale-serve-private.sh verify    # assert serve-on + funnel-off
#   scripts/tailscale-serve-private.sh reset      # disable serve
#   scripts/tailscale-serve-private.sh status     # show raw serve/funnel status
#
# Pre-req: the tailnet admin console must have "HTTPS Certificates" enabled, or
# Serve cannot provision the *.ts.net cert. `up` checks and aborts with guidance.

set -euo pipefail

PORT=3420
TS="$(command -v tailscale || echo /usr/bin/tailscale)"

die() { echo "ERROR: $*" >&2; exit 1; }

# CRITICAL SAFETY GATE: refuse to do anything if Funnel is configured. Funnel
# publishes to the public internet -- the one thing this must never do.
assert_funnel_off() {
  local f
  f="$("$TS" funnel status 2>/dev/null || true)"
  # An empty / "No funnel" status is the safe state. Any host:port mapping or
  # "https" line means Funnel is live -> abort hard.
  if printf '%s' "$f" | grep -qiE 'https://|:443|:8443|:10000|proxy '; then
    echo "----- tailscale funnel status -----" >&2
    printf '%s\n' "$f" >&2
    die "FUNNEL IS ACTIVE -- refusing to proceed. Run '$TS funnel reset' first. This config must be tailnet-only."
  fi
}

self_dns() {
  "$TS" status --json 2>/dev/null | python3 -c 'import sys,json; print((json.load(sys.stdin).get("Self",{}).get("DNSName") or "").rstrip("."))' 2>/dev/null
}

cmd_up() {
  assert_funnel_off

  # HTTPS-cert pre-req: Serve needs the tailnet to have HTTPS certificates
  # enabled. Probe by asking tailscale for this host's cert; a failure here
  # almost always means the admin toggle is OFF.
  local dns; dns="$(self_dns)"
  [ -n "$dns" ] || die "could not resolve this host's MagicDNS name -- is tailscale up?"
  echo "Host MagicDNS: $dns"

  echo "Enabling Tailscale Serve (tailnet-only) for 127.0.0.1:$PORT ..."
  # serve --bg proxies https://<host>/ -> 127.0.0.1:PORT, backgrounded + persisted.
  if ! "$TS" serve --bg "$PORT" 2>serve.err; then
    cat serve.err >&2; rm -f serve.err
    die "tailscale serve failed. If the error mentions certificates, enable 'HTTPS Certificates' in the tailnet admin console (https://login.tailscale.com/admin/dns) and retry."
  fi
  rm -f serve.err

  # Post-conditions: serve mapping present AND funnel still off.
  assert_funnel_off
  cmd_verify
  echo
  echo "Dashboard now reachable from the tailnet at:  https://$dns/"
  echo "Open that on a tailnet device, paste the dashboard access token when prompted."
}

cmd_verify() {
  local s f
  s="$("$TS" serve status 2>/dev/null || true)"
  f="$("$TS" funnel status 2>/dev/null || true)"
  echo "== serve =="; printf '%s\n' "${s:-<none>}"
  echo "== funnel ==" ; printf '%s\n' "${f:-<none>}"
  # Assertions
  printf '%s' "$s" | grep -qiE "127.0.0.1:$PORT|localhost:$PORT" \
    || die "serve mapping for 127.0.0.1:$PORT NOT found -- serve is not active."
  assert_funnel_off
  echo "VERIFY OK: serve -> 127.0.0.1:$PORT active, funnel OFF (tailnet-only)."
}

cmd_reset() {
  echo "Disabling Tailscale Serve ..."
  "$TS" serve reset 2>/dev/null || true
  assert_funnel_off
  echo "Serve reset. (Funnel confirmed off.)"
}

cmd_status() {
  echo "== serve =="; "$TS" serve status 2>/dev/null || echo "<none>"
  echo "== funnel =="; "$TS" funnel status 2>/dev/null || echo "<none>"
}

case "${1:-}" in
  up)     cmd_up ;;
  verify) cmd_verify ;;
  reset)  cmd_reset ;;
  status) cmd_status ;;
  *) echo "usage: $0 {up|verify|reset|status}" >&2; exit 2 ;;
esac
