#!/bin/bash
# Rotate the dashboard Bearer token. General-purpose credential rotation; kept
# on standby (NOT run for the Tailscale-Serve phone test -- Dominik chose option
# B, no rotation). Run this whenever the token needs invalidating.
#
# Steps: generate a fresh 32-byte hex token, write it to store/.dashboard-token
# (mode 0600), then restart the marveen dashboard so it loads the new token
# (loadOrCreateDashboardToken reads the file at startup). The marveen-channels
# orchestrator is NOT touched. Any browser holding the old token in localStorage
# must re-paste the new one.
#
# Usage: scripts/rotate-dashboard-token.sh         # rotate + restart
#        scripts/rotate-dashboard-token.sh --print  # also echo the new token

set -euo pipefail

ROOT=/home/domin/marveen
TOKEN_PATH="$ROOT/store/.dashboard-token"
PRINT="no"; [ "${1:-}" = "--print" ] && PRINT="yes"

NEW="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
umask 077
printf '%s' "$NEW" > "$TOKEN_PATH"
chmod 600 "$TOKEN_PATH"
echo "New dashboard token written to $TOKEN_PATH (mode 0600)."

# Restart marveen with the supervisor's exact command so it reloads the token.
PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$PATH_CURATED"
NODE="$(command -v node)"; TMUXB="$(command -v tmux)"
env -u TMUX "$TMUXB" kill-session -t "=marveen" 2>/dev/null || true
env -u TMUX "$TMUXB" new-session -d -s marveen -c "$ROOT" "export PATH=\"$PATH_CURATED\" && exec $NODE dist/index.js"
echo "marveen dashboard restarted (marveen-channels untouched)."

# Wait for the server to come back up.
for i in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3420/api/health 2>/dev/null || true)"
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then echo "server up (http=$code)"; break; fi
  sleep 2
done

if [ "$PRINT" = "yes" ]; then
  echo "NEW TOKEN: $NEW"
else
  echo "Token rotated. (Re-run with --print to display it, or read $TOKEN_PATH.)"
fi
