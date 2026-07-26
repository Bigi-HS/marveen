#!/bin/bash
# Tailscale Serve + FUNNEL wrapper for the Genesis dashboard (card 2c16a868).
#
# Makes the localhost-bound dashboard (127.0.0.1:3420) reachable from the PUBLIC
# internet over Tailscale Funnel, so the operator can open it from any device
# (phone / tablet / laptop) with only a URL + username/password -- no Tailscale
# client required. This is the DELIBERATE opposite of tailscale-serve-private.sh,
# which hard-refuses Funnel. Use ONLY after:
#   1. Username+password credentials are configured
#      (scripts/dashboard-set-credentials.mjs) -- a public login without a
#      strong password is the dominant risk.
#   2. A security review (Chad) has PASSED the public-exposure change.
#
# CRITICAL TERMINAL ISOLATION:
#   The phone terminal (ttyd, a raw shell on 127.0.0.1:7681) must NEVER be
#   published to the public internet. Funnel is per-PORT, so the dashboard and
#   the terminal CANNOT share a funneled port. This script therefore:
#     - serves + FUNNELS the dashboard on 443            (public)
#     - serves the terminal on 8443, TAILNET-ONLY        (funnel OFF)
#   and HARD-ASSERTS that funnel is enabled for 443 ONLY and that the terminal
#   port is not funneled. It aborts if it cannot prove the terminal is private.
#
# Usage:
#   scripts/tailscale-serve-public.sh up      # dashboard public (funnel), terminal tailnet-only
#   scripts/tailscale-serve-public.sh verify   # assert dashboard-funnel-on + terminal-funnel-off
#   scripts/tailscale-serve-public.sh reset     # tear the whole serve/funnel config down
#   scripts/tailscale-serve-public.sh status    # raw serve/funnel status
#
# Pre-req: the tailnet admin console must have BOTH "HTTPS Certificates" AND
# "Funnel" enabled (Funnel also needs the `funnel` node attribute in the ACLs).

set -euo pipefail

DASH_PORT=3420       # dashboard backend (loopback)
TERM_PORT=7681       # ttyd terminal backend (loopback)
FUNNEL_PORT=443      # public HTTPS port for the dashboard
TERM_SERVE_PORT=8443 # tailnet-only HTTPS port for the terminal
TS="$(command -v tailscale || echo /usr/bin/tailscale)"

die() { echo "ERROR: $*" >&2; exit 1; }

self_dns() {
  "$TS" status --json 2>/dev/null | python3 -c 'import sys,json; print((json.load(sys.stdin).get("Self",{}).get("DNSName") or "").rstrip("."))' 2>/dev/null
}

# Read the serve config as JSON and assert the funnel topology is EXACTLY:
#   funnel ENABLED on the public dashboard port (443)
#   funnel DISABLED everywhere else (crucially the terminal port)
# Fail-CLOSED on any unreadable/unexpected status: if we cannot prove the
# terminal is private, we abort. This is the security invariant of this script.
assert_funnel_topology() {
  local j rc
  j="$("$TS" serve status --json 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "----- tailscale serve status --json (rc=$rc) -----" >&2
    printf '%s\n' "$j" >&2
    die "could not read serve status (tailscaled down?). Refusing to proceed -- cannot confirm the terminal is not publicly exposed."
  fi
  local verdict
  verdict="$(printf '%s' "$j" | FUNNEL_PORT="$FUNNEL_PORT" python3 -c '
import sys, os, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_ERROR"); sys.exit(0)
fp = os.environ["FUNNEL_PORT"]
af = d.get("AllowFunnel")
if not isinstance(af, dict):
    # No funnel map at all -> the dashboard is NOT public yet. Not the target
    # state for "up", but it is SAFE (nothing exposed). Report so cmd_up can
    # distinguish "not yet applied" from "wrong/dangerous".
    print("NO_FUNNEL"); sys.exit(0)
# Keys look like "bigi.tail1a5fa5.ts.net:443". Split off the port.
def port(k):
    return k.rsplit(":", 1)[-1]
public_ports = {port(k) for k, v in af.items() if v}
# The ONLY port allowed to be public is the dashboard funnel port.
if public_ports == {fp}:
    print("OK")
elif not public_ports:
    print("NO_FUNNEL")
else:
    # Any other port funneled (e.g. the terminal port) -> DANGER, fail closed.
    print("DANGER:" + ",".join(sorted(public_ports)))
' 2>/dev/null)"
  echo "$verdict"
}

cmd_up() {
  local dns; dns="$(self_dns)"
  [ -n "$dns" ] || die "could not resolve this host's MagicDNS name -- is tailscaled up and logged in?"
  echo "Host MagicDNS: $dns"

  # 1. Terminal FIRST, on its own tailnet-only port, BEFORE any funnel exists --
  #    so there is never a window where the terminal could be on a funneled port.
  echo "Serving terminal (tailnet-only) on :$TERM_SERVE_PORT -> 127.0.0.1:$TERM_PORT/terminal ..."
  "$TS" serve --bg --https "$TERM_SERVE_PORT" --set-path /terminal "http://127.0.0.1:$TERM_PORT/terminal" \
    || die "failed to serve the terminal on :$TERM_SERVE_PORT"

  # 2. Dashboard on the funnel port, then enable funnel for THAT port only.
  echo "Serving dashboard on :$FUNNEL_PORT -> 127.0.0.1:$DASH_PORT ..."
  "$TS" serve --bg --https "$FUNNEL_PORT" "http://127.0.0.1:$DASH_PORT" \
    || die "failed to serve the dashboard on :$FUNNEL_PORT"
  echo "Enabling PUBLIC funnel on :$FUNNEL_PORT (dashboard only) ..."
  "$TS" funnel --bg "$FUNNEL_PORT" \
    || die "failed to enable funnel on :$FUNNEL_PORT (is Funnel enabled in the tailnet ACLs?)"

  cmd_verify
  echo
  echo "Dashboard PUBLIC at:            https://$dns/           (username + password)"
  echo "Terminal tailnet-only at:      https://$dns:$TERM_SERVE_PORT/terminal"
}

cmd_verify() {
  local v; v="$(assert_funnel_topology)"
  case "$v" in
    OK) echo "VERIFY OK: funnel ON for :$FUNNEL_PORT (dashboard) ONLY; terminal NOT funneled." ;;
    NO_FUNNEL) die "no funnel is active -- the dashboard is NOT public. Run 'up' first." ;;
    DANGER:*) die "UNSAFE FUNNEL TOPOLOGY -- publicly funneled ports: ${v#DANGER:}. Expected ONLY :$FUNNEL_PORT. Run 'reset' and re-apply." ;;
    *) die "could not parse serve status -- refusing to confirm safety." ;;
  esac
  echo "== serve =="; "$TS" serve status 2>/dev/null || true
  echo "== funnel =="; "$TS" funnel status 2>/dev/null || true
}

cmd_reset() {
  echo "Tearing down funnel + serve ..."
  "$TS" funnel "$FUNNEL_PORT" off 2>/dev/null || true
  "$TS" serve reset 2>/dev/null || true
  echo "Reset complete. (No public exposure.)"
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
