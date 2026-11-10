#!/usr/bin/env bash
# Commit all agents/*/agent-config.json to develop before any git reset --hard deploy.
# Prevents model-tier config clobber (config-landmine W3, card ce001e4d).
# Idempotent: exits 0 if nothing changed. Must run from INSTALL_DIR.
#
# W3 follow-up (card 54638a53): validates securityProfile against templates/profiles/
# at commit-time. A config with an unknown or missing securityProfile causes exit 1
# (fail-closed). If templates/profiles/ is absent or empty, skips validation with a
# warning (graceful degradation).
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/home/domin/marveen}"
cd "$INSTALL_DIR"

mapfile -t CONFIGS < <(find agents -maxdepth 2 -name "agent-config.json" -type f 2>/dev/null | sort)

if [ "${#CONFIGS[@]}" -eq 0 ]; then
    echo "commit-agent-configs: no agent-config.json found -- nothing to commit."
    exit 0
fi

# --- securityProfile validation (W3 follow-up, card 54638a53) ----------------
PROFILES_DIR="${PROFILES_DIR:-templates/profiles}"

# Collect valid profile names (filenames without .json extension)
mapfile -t VALID_PROFILES < <(find "$PROFILES_DIR" -maxdepth 1 -name "*.json" -type f 2>/dev/null | xargs -r -I{} basename {} .json | sort)

if [ "${#VALID_PROFILES[@]}" -eq 0 ]; then
    echo "commit-agent-configs: WARNING -- $PROFILES_DIR is empty or missing; skipping securityProfile validation."
else
    VALIDATION_FAILED=0
    for cfg in "${CONFIGS[@]}"; do
        # Extract securityProfile value using python3 (no jq required)
        profile=$(python3 -c "
import json, sys
try:
    d = json.load(open('$cfg'))
    v = d.get('securityProfile', '')
    print(v)
except Exception as e:
    sys.exit(1)
" 2>/dev/null) || {
            echo "commit-agent-configs: ERROR -- could not parse $cfg as JSON." >&2
            VALIDATION_FAILED=1
            continue
        }

        if [ -z "$profile" ]; then
            echo "commit-agent-configs: ERROR -- $cfg has no securityProfile field." >&2
            VALIDATION_FAILED=1
            continue
        fi

        # Check if profile exists in templates/profiles/
        if [ ! -f "$PROFILES_DIR/${profile}.json" ]; then
            echo "commit-agent-configs: ERROR -- $cfg securityProfile='$profile' not found in $PROFILES_DIR/." >&2
            echo "  Valid profiles: ${VALID_PROFILES[*]}" >&2
            VALIDATION_FAILED=1
        fi
    done

    if [ "$VALIDATION_FAILED" -ne 0 ]; then
        echo "commit-agent-configs: ABORT -- one or more configs have invalid securityProfile. Fix before committing." >&2
        exit 1
    fi

    echo "commit-agent-configs: securityProfile validation passed for ${#CONFIGS[@]} config(s)."
fi
# --- end validation -----------------------------------------------------------

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
