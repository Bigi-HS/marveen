#!/usr/bin/env bash
# Commit all agents/*/agent-config.json to develop before any git reset --hard deploy.
# Prevents model-tier config clobber (config-landmine W3, card ce001e4d).
# Idempotent: exits 0 if nothing changed. Must run from INSTALL_DIR.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/home/domin/marveen}"
cd "$INSTALL_DIR"

mapfile -t CONFIGS < <(find agents -maxdepth 2 -name "agent-config.json" -type f 2>/dev/null | sort)

if [ "${#CONFIGS[@]}" -eq 0 ]; then
    echo "commit-agent-configs: no agent-config.json found -- nothing to commit."
    exit 0
fi

git add -- "${CONFIGS[@]}"

if git diff --cached --quiet -- "${CONFIGS[@]}"; then
    echo "commit-agent-configs: ${#CONFIGS[@]} configs already committed (clean)."
    exit 0
fi

git diff --cached --stat -- "${CONFIGS[@]}"

git commit -m "chore(config): sync agent-configs before deploy (W3/ce001e4d)

Prevents git reset --hard origin/develop from clobbering local model-tier
overrides (e.g. sonnet->opus regression). Auto-committed by this script."

echo "commit-agent-configs: committed ${#CONFIGS[@]} files."
