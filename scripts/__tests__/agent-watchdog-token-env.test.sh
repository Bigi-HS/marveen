#!/bin/bash
# Regression guard: per-agent watchdog scripts must source agent-token-env.sh
# in their launch command (card c65875ed / eng/watchdog-agent-token-env-wiring).
#
# Without this sourcing, a watchdog relaunch after token rotation produces a
# token-less session: GENESIS_AGENT_TOKEN is absent -> buster-ci-runner.py falls
# back to the shared operator token -> recorded_by=marveen -> CI independence
# invariant broken (gate.ts:186). Same issue affects gate:approve agents (chad/thor).
#
# Run: bash scripts/__tests__/agent-watchdog-token-env.test.sh

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

WATCHDOGS=(
    buster
    chad
    thor
    claudia
    forge
    scout
    hibiki
    percy
    bond
    gyore
    devil-advocate
    bigben
    dave
    blackbart
)

for agent in "${WATCHDOGS[@]}"; do
    wf="$ROOT/scripts/${agent}-watchdog.sh"
    if [[ ! -f "$wf" ]]; then
        bad "${agent}-watchdog.sh: file not found"
        continue
    fi

    # Must have agent-token-env.sh sourcing
    if grep -q "agent-token-env\.sh" "$wf"; then
        ok "${agent}-watchdog.sh: has agent-token-env.sh sourcing"
    else
        bad "${agent}-watchdog.sh: MISSING agent-token-env.sh sourcing in launch cmd"
        continue
    fi

    # Must set GENESIS_AGENT_ID
    if grep -q "GENESIS_AGENT_ID" "$wf"; then
        ok "${agent}-watchdog.sh: sets GENESIS_AGENT_ID"
    else
        bad "${agent}-watchdog.sh: MISSING GENESIS_AGENT_ID export"
        continue
    fi

    # Ordering within the launch line: fleet-oauth-env.sh must appear before
    # agent-token-env.sh. When both are on the same line (inlined cmd string),
    # check string position; when on separate lines, check line numbers.
    # grep -n returns "lineno:content"; extract the first match of each.
    # Skip comment lines (lines starting with optional-whitespace then #).
    oauth_match=$(grep -n "fleet-oauth-env\.sh" "$wf" | grep -v '^[0-9]*:[[:space:]]*#' | head -1)
    token_match=$(grep -n "agent-token-env\.sh" "$wf" | grep -v '^[0-9]*:[[:space:]]*#' | head -1)
    oauth_line=$(echo "$oauth_match" | cut -d: -f1)
    token_line=$(echo "$token_match" | cut -d: -f1)

    if [[ "$oauth_line" -lt "$token_line" ]]; then
        ok "${agent}-watchdog.sh: fleet-oauth before agent-token (separate lines)"
    elif [[ "$oauth_line" -eq "$token_line" ]]; then
        # Same line (inlined cmd string) -- check string position within the line
        line_content=$(sed -n "${oauth_line}p" "$wf")
        oauth_pos=$(echo "$line_content" | grep -bo "fleet-oauth-env\.sh" | head -1 | cut -d: -f1)
        token_pos=$(echo "$line_content" | grep -bo "agent-token-env\.sh" | head -1 | cut -d: -f1)
        if [[ -n "$oauth_pos" && -n "$token_pos" && "$oauth_pos" -lt "$token_pos" ]]; then
            ok "${agent}-watchdog.sh: fleet-oauth before agent-token (same line, correct order)"
        else
            bad "${agent}-watchdog.sh: ordering wrong within line (oauth@${oauth_pos} token@${token_pos})"
        fi
    else
        bad "${agent}-watchdog.sh: agent-token-env.sh appears BEFORE fleet-oauth-env.sh"
    fi
done

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
