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
TOKEN_FILE="/home/domin/marveen/store/.dashboard-token"
TOKEN="$(cat "$TOKEN_FILE")"

curl -s -X POST "http://localhost:3420/api/agents/${AGENT_ID}/ack-declare" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"ttl_seconds":86400}' \
  --max-time 5 \
  --fail-with-body \
  > /dev/null
