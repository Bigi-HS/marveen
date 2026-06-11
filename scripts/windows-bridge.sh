#!/usr/bin/env bash
# windows-bridge.sh -- reusable WSL<->Windows scripting bridge helper for the Big Ben
# content pipeline. Generalizes the proven Meld bridge (port 13376): a netsh portproxy
# on the Windows host listens on the WSL->Windows gateway IP and forwards to a Windows
# app bound to 127.0.0.1, so WSL can reach Windows apps that only listen on localhost.
#
# This tool NEVER activates a portproxy live. Adding a portproxy + firewall rule needs
# Administrator on the Windows host, which WSL cannot elevate -- so that is Dominik's /
# the deploy step. The tool only:
#   gateway        print the detected WSL->Windows gateway IP
#   plan <port>    EMIT the exact Admin-PowerShell (netsh portproxy add + firewall rule)
#   verify <port>  probe http://<gw>:<port>, degrading gracefully when the app-side
#                  server is not enabled yet (reports "waiting", not an error)
#   list           show the current portproxy table (via netsh.exe interop, if present)
#
# The portproxy + firewall rule are persistent across reboot (proven by the Meld bridge),
# BUT the WSL->Windows gateway IP can change on reboot. If `verify` reports unreachable
# after a reboot, re-run `gateway` and, if it changed, re-run `plan` and re-apply.
#
# Env overrides (tests / non-standard setups):
#   WIN_BRIDGE_GATEWAY  override the detected gateway IP
#   WIN_BRIDGE_CURL     curl binary (default: curl)
#   WIN_BRIDGE_NETSH    netsh.exe binary for `list` (default: netsh.exe)
#   CURL_EXIT           (test hook) ignored here; stubs read it themselves
set -uo pipefail

CURL="${WIN_BRIDGE_CURL:-curl}"
NETSH="${WIN_BRIDGE_NETSH:-netsh.exe}"

usage() {
  cat >&2 <<'EOF'
usage: windows-bridge.sh <command> [args]

  gateway                       print the detected WSL->Windows gateway IP
  plan <port> [--app NAME] [--connect-port N]
                                emit the Admin-PowerShell to set up the portproxy
                                + firewall rule for <port> (does NOT execute)
  verify <port> [--app NAME] [--path PATH]
                                probe http://<gw>:<port><path>; graceful "waiting"
                                if the app server is not enabled yet
  list                          show the current netsh portproxy table (interop)
EOF
}

detect_gateway() {
  if [ -n "${WIN_BRIDGE_GATEWAY:-}" ]; then
    echo "$WIN_BRIDGE_GATEWAY"
    return 0
  fi
  # WSL default route next-hop = the Windows host gateway.
  ip route 2>/dev/null | awk '/^default/ {print $3; exit}'
}

cmd_gateway() {
  local gw; gw="$(detect_gateway)"
  if [ -z "$gw" ]; then
    echo "could not detect WSL->Windows gateway IP" >&2
    return 1
  fi
  echo "$gw"
}

cmd_plan() {
  local port="${1:-}"; shift || true
  local app="app" connect_port=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --app) app="${2:-app}"; shift 2 ;;
      --connect-port) connect_port="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -z "$port" ]; then usage; return 2; fi
  [ -n "$connect_port" ] || connect_port="$port"

  local gw; gw="$(detect_gateway)"
  if [ -z "$gw" ]; then echo "could not detect gateway IP" >&2; return 1; fi

  local rule="WSL-${app}-${port}"
  cat <<EOF
# --- WSL<->Windows bridge plan: ${app} (port ${port}) ---
# Detected WSL->Windows gateway IP: ${gw}
# Run the block below in an ELEVATED (Administrator) PowerShell on the WINDOWS host.
# It is idempotent: the netsh 'delete' clears any stale entry before re-adding.

netsh interface portproxy delete v4tov4 listenaddress=${gw} listenport=${port} 2>\$null
netsh interface portproxy add    v4tov4 listenaddress=${gw} listenport=${port} connectaddress=127.0.0.1 connectport=${connect_port}

if (-not (Get-NetFirewallRule -DisplayName "${rule}" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "${rule}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any
}

# Verify from WSL afterwards:  scripts/windows-bridge.sh verify ${port} --app ${app}
# --- end plan ---
EOF
}

cmd_verify() {
  local port="${1:-}"; shift || true
  local app="app" path="/"
  while [ $# -gt 0 ]; do
    case "$1" in
      --app) app="${2:-app}"; shift 2 ;;
      --path) path="${2:-/}"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -z "$port" ]; then usage; return 2; fi

  local gw; gw="$(detect_gateway)"
  if [ -z "$gw" ]; then echo "could not detect gateway IP" >&2; return 1; fi

  local url="http://${gw}:${port}${path}"
  "$CURL" -sS -m 5 -o /dev/null "$url"
  local rc=$?
  case "$rc" in
    0)
      echo "OK: ${app} reachable on ${gw}:${port}"
      return 0 ;;
    7|52|56)
      # 7 refused, 52 empty reply, 56 reset: portproxy may be up but the app-side
      # server is not listening yet -- expected before the operator enables it.
      echo "waiting: ${app} not enabled yet (no server on Windows 127.0.0.1:${port}); ${gw}:${port}"
      return 0 ;;
    28)
      echo "unreachable: ${gw}:${port} timed out -- portproxy/firewall missing or gateway IP changed (re-run 'gateway' + 'plan')" >&2
      return 1 ;;
    *)
      echo "unreachable: ${app} probe to ${url} failed (curl exit ${rc})" >&2
      return 1 ;;
  esac
}

cmd_list() {
  if ! command -v "$NETSH" >/dev/null 2>&1; then
    echo "netsh.exe not reachable from WSL (interop off?) -- run 'netsh interface portproxy show all' on Windows" >&2
    return 1
  fi
  "$NETSH" interface portproxy show all
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    gateway) cmd_gateway "$@" ;;
    plan)    cmd_plan "$@" ;;
    verify)  cmd_verify "$@" ;;
    list)    cmd_list "$@" ;;
    ""|-h|--help|help) usage; [ -z "$cmd" ] && return 2 || return 0 ;;
    *) echo "unknown command: $cmd" >&2; usage; return 2 ;;
  esac
}

main "$@"
