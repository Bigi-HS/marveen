#!/usr/bin/env bash
# ACK-capability V2 SessionStart hook (card 83b7ec10).
#
# Declares THIS agent ACK-capable in the runtime registry. Wired into each
# ACK-capable agent's Claude Code settings.json as a SessionStart "startup" hook,
# so it fires whenever Claude Code initializes -- regardless of whether the tmux
# session was created by the dashboard (startAgentProcess) or by a bash watchdog
# (agent-watchdog.sh tmux new-session). This is the structural fix for the
# watchdog-launch false-negative: the launcher has zero knowledge of capability.
#
# AGENT_ID is passed as $1, baked into each agent's settings.json command line.
#
# Failure is non-fatal by design: if the dashboard is down the declare curl
# fails and the agent stays fail-closed (correct -- delivery routing is down too,
# so no capability is needed). Claude Code logs the hook failure but does not
# abort the session.
set -euo pipefail

AGENT_ID="${1:?AGENT_ID argument required}"

# Hardening (Chad INFO#1, PR#211): AGENT_ID flows into the request URL. Even
# though it is an operator-baked literal in settings.json (not attacker input),
# validate it against the same strict allowlist the server uses for agent names
# (sanitizeAgentName) and refuse anything else -- a defence-in-depth guard so a
# fat-fingered / metacharacter value can never reach curl as part of the URL.
if [[ ! "$AGENT_ID" =~ ^[a-z0-9_-]+$ ]]; then
  echo "ack-declare: invalid AGENT_ID '$AGENT_ID' (expected [a-z0-9_-]+)" >&2
  exit 1
fi

# Base URL is overridable (default = the local dashboard) so the hook is testable
# without the live server and works on a non-default deployment.
BASE_URL="${MARVEEN_DASHBOARD_URL:-http://localhost:3420}"
TOKEN_FILE="/home/domin/marveen/store/.dashboard-token"
TOKEN="$(cat "$TOKEN_FILE")"

curl -s -X POST "${BASE_URL}/api/agents/${AGENT_ID}/ack-declare" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"ttl_seconds":86400}' \
  --max-time 5 \
  --fail-with-body \
  > /dev/null
