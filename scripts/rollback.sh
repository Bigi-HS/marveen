#!/usr/bin/env bash
# One-command dist rollback for Armorer. Restores a backup dist, restarts the
# dashboard server, and runs /api/gate/verify automatically.
#
# Usage:
#   scripts/rollback.sh                         -- restores the most recent timestamped backup
#   scripts/rollback.sh /tmp/marveen-deploy-backups/20260729-182403  -- specific backup
#
# Exit 0 = rollback + verify green.
# Exit 1 = rollback done but verify not fully green -- escalate.
# Exit 2 = fatal (no backup found, server won't start).

set -euo pipefail

REPO="/home/domin/marveen"
BACKUP_ROOT="/tmp/marveen-deploy-backups"

# --- locate backup dir ---
if [[ -n "${1:-}" ]]; then
  BACKUP_DIR="$1"
else
  # Most recent YYYYMMDD-HHMMSS timestamped dir (not symbolic dirs like last-prev-tip.txt)
  BACKUP_DIR=$(ls -1d "$BACKUP_ROOT"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null | sort | tail -1)
fi

if [[ -z "${BACKUP_DIR:-}" || ! -d "$BACKUP_DIR" ]]; then
  echo "ROLLBACK ERROR: no valid backup dir found (checked: ${BACKUP_DIR:-$BACKUP_ROOT})" >&2
  exit 2
fi

echo "=== ROLLBACK starting ==="
echo "Backup source : $BACKUP_DIR"
echo "Restoring to  : $REPO/dist/"

# --- write planned-restart marker so supervisor sentinel stays quiet ---
touch "$REPO/store/planned-restart.marker"

# --- restore dist (backup dir contains dist contents directly, not a dist/ subdir) ---
rsync -a --delete "$BACKUP_DIR/" "$REPO/dist/"
echo "dist restored"

# --- restart server ---
PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node)"
TMUXB="$(command -v tmux)"

env -u TMUX "$TMUXB" kill-session -t marveen 2>/dev/null || true
sleep 2
env -u TMUX "$TMUXB" new-session -d -s marveen -c "$REPO" \
  "export PATH=\"$PATH_CURATED\" && exec $NODE dist/index.js"
echo "server session restarted"

# --- wait for server up (up to 40s) ---
UP=0
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3420/api/health 2>/dev/null || echo "000")
  if [[ "$STATUS" == "200" || "$STATUS" == "401" ]]; then
    echo "server up (HTTP $STATUS) after ~$((i * 2))s"
    UP=1
    break
  fi
  sleep 2
done

if [[ "$UP" -ne 1 ]]; then
  echo "ROLLBACK ERROR: server did not respond within 40s" >&2
  rm -f "$REPO/store/planned-restart.marker"
  exit 2
fi

# --- 4-point verify via gate/verify ---
TOKEN=$(cat "$REPO/store/.dashboard-token")
VERIFY_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/gate/verify 2>/dev/null)
PASS=$(echo "$VERIFY_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(str(d.get('pass',False)).lower())" 2>/dev/null || echo "error")

echo ""
echo "gate/verify result:"
echo "$VERIFY_JSON" | python3 -m json.tool 2>/dev/null || echo "$VERIFY_JSON"
echo ""

if [[ "$PASS" == "true" ]]; then
  rm -f "$REPO/store/planned-restart.marker"
  # Update deployed-tip only if we know the exact rollback SHA.
  # NEVER call update-deployed-tip.sh with no args here: that would record
  # origin/develop HEAD instead of the actual restored dist's SHA (bug fix 2026-07-30).
  ROLLBACK_SHA_FILE="$BACKUP_DIR/deployed-sha.txt"
  if [[ -f "$ROLLBACK_SHA_FILE" ]]; then
    ROLLBACK_SHA=$(cat "$ROLLBACK_SHA_FILE")
    bash "$REPO/scripts/update-deployed-tip.sh" "$ROLLBACK_SHA" && \
      echo "deployed-tip updated to rollback SHA: $ROLLBACK_SHA" || true
  else
    echo "WARNING: deployed-sha.txt not in backup dir -- deployed-tip NOT updated."
    echo "Manually run: bash scripts/update-deployed-tip.sh <rollback-sha>"
    echo "(Current store/.deployed-tip may be stale; run deploy-delta-check.py with care.)"
  fi
  echo "=== ROLLBACK COMPLETE: verify GREEN ==="
  exit 0
else
  rm -f "$REPO/store/planned-restart.marker"
  echo "=== ROLLBACK WARNING: verify NOT fully green -- escalate to Genesis ==="
  exit 1
fi
