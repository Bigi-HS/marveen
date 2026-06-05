# Forge Observability Baseline

Forge owns fleet observability alongside deploy/release (scope confirmed 2026-06-05).
This document defines the four signal categories and the hook wiring.

## Signal Categories

### 1. Watchdog Logs
Location: `store/*-watchdog.log`, `store/fleet-supervisor.log`

Watch for:
- `rapid-exit after 0s` -- agent died on startup (config/token problem)
- `absent -- launching` -- session gone, watchdog restarting
- `relaunching` -- fleet-supervisor detected unresponsive dashboard
- `death-loop` pattern: more than 2 restarts within 5 minutes for the same agent

Current gap: no aggregate "restart storm" detector. Future: cron heartbeat that tails
last 5 min of all watchdog logs and alerts Genesis if any agent restarts >2x.

### 2. Token Telemetry
Source: `GET /api/agents` -> `contextTokens` per agent

Watch for:
- `contextTokens > 150000` -- approaching compaction threshold; agent may stall
- `running: false` with `runningSince` set -- process died, watchdog hasn't recovered yet
- `runningSince` gap: agent not seen for > 10 min despite watchdog active

Current gap: /api/agents `last_seen` is not populated (returns null). Until that field
is wired, use fleet-supervisor.log timestamps as proxy.

### 3. Channel Pipe Health
Sources: `store/channels.log`, `store/channels-failures.log`, fleet-supervisor.log

Watch for:
- `channels-failures.log` entries -- Telegram pipe errors
- `channels absent -- launching` in fleet-supervisor -- pipe died, being restarted
- Elnémulás pattern: Genesis (marveen) goes silent > 2 min after a dashboard restart
  -> MCP pipe killed (bun child doesn't respawn), needs `/mcp` reconnect

Recovery (item3, already live): the channel-poller reap loop in
`src/web/channel-poller-reap.ts` auto-reconnects after ~60-105s. If silence > 2 min
post-restart, that is a regression -> escalate.

### 4. Elnémulás Detection
Definition: an agent that has ingested a message but has not replied within expected
window (>10 min for channel agents, >30 min for background agents).

Existing mechanism: `watchdog-inbound-prober.py` -- detects inbound-ingested-but-not-
processed and triggers `--continue` respawn.

Gap: prober only covers the main session (marveen). Sub-agents (Dave, Thor, etc.) rely
on watchdog restart without inbound-replay. Future: extend prober to sub-agents.

## Hook Wiring (Forge settings.json)

Three hooks in `scripts/hooks/`:

| Script | Event | Action |
|---|---|---|
| `forge-deploy-guard.py` | PreToolUse (Bash) | Blocks restart if no `store/.genesis-go` marker |
| `forge-anomaly-scan.py` | PostToolUse (Bash) | Appends fleet anomalies to `store/forge-obs.log` |
| `forge-session-close.py` | Stop | Appends session boundary to `store/forge-obs.log` |

Settings.json snippet (add to Forge's `.claude-config/settings.json`):

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "python3 /home/domin/marveen/scripts/hooks/forge-deploy-guard.py"
        }
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "python3 /home/domin/marveen/scripts/hooks/forge-anomaly-scan.py"
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "python3 /home/domin/marveen/scripts/hooks/forge-session-close.py"
        }
      ]
    }
  ]
}
```

### Genesis-GO marker protocol
- Forge receives Genesis-GO via inter-agent message
- Forge creates `store/.genesis-go` manually before starting the live restart
- After deploy + verify completes (pass or rollback), Forge removes the marker
- The deploy-guard hook enforces this at the tool level (exit 2 if marker absent)

## Security Note (Chad scope)
The `forge-deploy-guard.py` PreToolUse hook is Forge-owned infra enforcement.
Chad's PII/injection scan (POST /api/messages filter) is a separate layer -- both
can coexist on PreToolUse without conflict since they match different patterns.
