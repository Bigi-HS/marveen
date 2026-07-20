#!/usr/bin/env bash
# ensure-tailscaled.sh -- best-effort, idempotent reboot-persistence for the
# tailnet-only dashboard (card c2de413f). WSL here has no systemd, so neither
# tailscaled nor the `tailscale serve` config survives a reboot. The fleet
# supervisor (always-on, started reboot-safe from fleet-boot.sh) ticks this so
# the daemon and the serve config are brought back automatically.
#
# What it does, in order:
#   0. Gate on store/tailscale-serve.enabled -- INERT until the operator/Genesis
#      flips the flag (deploy switch, same pattern as store/ollama-hybrid.enabled).
#   1. Skip gracefully if the tailscale binary is absent.
#   2. If the daemon is down, start tailscaled with userspace networking.
#   3. Only (re)apply the serve config once the node is AUTHENTICATED.
#
# It NEVER performs an interactive login: the one-time `tailscale up` is the
# operator's job (it opens a browser auth URL). Once authenticated, tailscaled
# reconnects from its saved state file on its own, so subsequent daemon starts
# need no human. Best-effort throughout: every failure logs and returns 0 so it
# can never wedge or error the supervisor; the next tick retries.
#
# Env overrides (for tests / non-standard installs):
#   ENSURE_TS_FLAG, ENSURE_TS_SERVE_SCRIPT, ENSURE_TS_LOG,
#   TAILSCALE_BIN, TAILSCALED_BIN, ENSURE_TS_SUDO,
#   TAILSCALE_SOCK, TAILSCALE_STATE
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLAG="${ENSURE_TS_FLAG:-$INSTALL_DIR/store/tailscale-serve.enabled}"
SERVE_SCRIPT="${ENSURE_TS_SERVE_SCRIPT:-$INSTALL_DIR/scripts/tailscale-serve-private.sh}"
LOG="${ENSURE_TS_LOG:-$INSTALL_DIR/store/tailscaled.log}"
TS="${TAILSCALE_BIN:-tailscale}"
TSD="${TAILSCALED_BIN:-tailscaled}"
SUDO="${ENSURE_TS_SUDO:-sudo}"
SOCK="${TAILSCALE_SOCK:-/var/run/tailscale/tailscaled.sock}"
STATE="${TAILSCALE_STATE:-/var/lib/tailscale/tailscaled.state}"
# tailscaled ships in /usr/sbin, which is absent from the supervisor's non-login
# PATH -- so a bare `command -v tailscaled` fails there even when it is installed
# (card 6342be48: this silently broke reboot-persistence). Fall back to well-known
# absolute install locations. Colon-separated; overridable for tests.
TSD_FALLBACKS="${ENSURE_TS_TSD_FALLBACKS:-/usr/sbin/tailscaled:/usr/bin/tailscaled:/usr/local/bin/tailscaled}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [ensure-tailscaled] $*" >&2; }

# Resolve the tailscaled binary. An explicit absolute TSD (env override or already
# resolved) is trusted as-is. Otherwise try PATH, then the fallback locations.
# Sets TSD to an absolute path on success; returns 1 if nothing usable is found.
resolve_tsd() {
  case "$TSD" in
    /*) [ -x "$TSD" ] && return 0 || return 1 ;;
  esac
  command -v "$TSD" >/dev/null 2>&1 && return 0
  local cand
  local IFS=:
  for cand in $TSD_FALLBACKS; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      TSD="$cand"
      log "tailscaled not on PATH -- using fallback $cand"
      return 0
    fi
  done
  return 1
}

# 0) Deploy-flag gate. Inert until the operator/Genesis enables remote access.
[ -f "$FLAG" ] || exit 0

# 1) Binary present? (Absent on hosts that never opted into Tailscale.)
command -v "$TS" >/dev/null 2>&1 || { log "tailscale binary not found -- skipping"; exit 0; }

daemon_up() { "$TS" status >/dev/null 2>&1; }

# Authenticated iff the backend reports the connected "Running" state. A daemon
# that is up but logged out reports NeedsLogin/Stopped -- we must not serve then.
logged_in() {
  "$TS" status --json 2>/dev/null \
    | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("BackendState",""))
except Exception: print("")' 2>/dev/null \
    | grep -qx "Running"
}

# 2) Start the daemon if it is down. Userspace networking is the stable WSL mode
#    (no TUN device needed); needs passwordless sudo (true on this host).
if ! daemon_up; then
  resolve_tsd || { log "tailscaled binary not found (PATH or $TSD_FALLBACKS) -- skipping"; exit 0; }
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  log "tailscaled down -- starting (userspace-networking)"
  $SUDO nohup "$TSD" --tun=userspace-networking --state="$STATE" --socket="$SOCK" >> "$LOG" 2>&1 &
  disown 2>/dev/null || true
  # Give the daemon a moment to create its socket and reconnect from saved state.
  for _ in 1 2 3 4 5 6 7 8 9 10; do daemon_up && break; sleep 1; done
fi

# 3) Still not responsive? Bail without blocking; the next tick retries.
daemon_up || { log "tailscaled not responsive after start -- will retry next tick"; exit 0; }

# 4) Not authenticated -> cannot serve. The interactive login is the operator's;
#    do NOT attempt it here. Log once and leave (next `tailscale up` fixes it).
if ! logged_in; then
  log "tailscaled up but not authenticated -- awaiting operator 'tailscale up' (no interactive login here)"
  exit 0
fi

# 5) (Re)apply the tailnet-only serve config. The serve wrapper is itself
#    fail-closed on funnel and verifies tailnet-only, so this stays idempotent.
if [ -x "$SERVE_SCRIPT" ]; then
  if "$SERVE_SCRIPT" up >> "$LOG" 2>&1; then
    log "serve config applied (tailnet-only)"
  else
    log "serve apply failed -- will retry next tick"
  fi
else
  log "serve script missing or not executable: $SERVE_SCRIPT"
fi

exit 0
