#!/usr/bin/env bash
# update-deployed-tip.sh -- write the current origin/develop HEAD to store/.deployed-tip
#
# Called by Armorer (fleet-deploy-verify) AFTER a successful 4-point verify so that
# deploy-delta-check.py has the correct base for the next pre-deploy risk scan.
# Also called after a rollback (pass the rollback SHA explicitly).
#
# Usage:
#   bash scripts/update-deployed-tip.sh                  # uses origin/develop HEAD
#   bash scripts/update-deployed-tip.sh <sha>            # explicit tip (e.g. rollback)

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="$REPO/store/.deployed-tip"

if [[ $# -ge 1 ]]; then
  TIP="$1"
else
  TIP="$(git -C "$REPO" rev-parse origin/develop)"
fi

printf '%s\n' "$TIP" > "$MARKER"
echo "deployed-tip updated: $TIP"
