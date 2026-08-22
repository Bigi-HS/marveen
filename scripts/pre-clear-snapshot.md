# Pre-Clear Snapshot Schema

Before `/clear` or `/compact`, agents are encouraged to self-summarize their current context into the cold-tier vault. This structured snapshot preserves essential state (tasks, configs, flags) across the hard context reset, enabling a coherent resume without blind re-discovery.

## Schema

```yaml
# pre-clear-snapshot
# Structured snapshot of agent context before /clear or /compact.
# Saved to cold-tier vault by the agent (via memory API / curator).
# Owner: Applegate (curator); author-driven before context reset.

agent_id: <agent-id>
timestamp: <epoch-seconds>
context_type: "pre_clear_snapshot"

## Last completed task
last_task:
  title: <task title or "none">
  status: <done|in_progress|blocked|pending>
  brief: <1-2 sentence summary>

## Open questions / pending decisions (awaiting user/external input)
open_questions:
  - question: <text>
    priority: <high|normal|low>
    blocker: <yes|no>

## Top 2-3 active priorities / next steps
active_priorities:
  - priority: <text>
    effort: <small|medium|large>
    dependencies: <text or "none">

## Agent-specific config flags / settings (preserve across reset)
config_flags:
  - flag_name: <e.g., MAIN_AGENT_ID, SECURITY_PROFILE>
    value: <value>
    reason: <why this matters>

## Key file paths / contexts
key_paths:
  - path: <path>
    purpose: <what it is>

## Blockers / impediments
blocked_by:
  - <description>

## Optional free-form notes
notes: <any additional context>

## Minimal required fields (advisory mode)

At minimum, capture:
- agent_id
- timestamp
- last_task.brief
- active_priorities (at least 1 item)

Everything else is optional per agent preference.
```

## Usage (Agent-Driven)

1. Before running `/clear` or `/compact`, the agent opens this prompt as a template.
2. Agent self-fills the YAML snapshot with their current state.
3. Agent saves to the cold-tier vault using the memory API:
   ```bash
   curl -X POST http://localhost:3420/api/memories \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     -d '{"agent_id":"<id>","content":"<yaml>","category":"cold","keywords":"pre_clear_snapshot, <agent_id>"}'
   ```
4. Agent runs `/clear` or `/compact`.
5. After the reset, Applegate curator can retrieve the snapshot (`query: pre_clear_snapshot`) and include it in the resume session if needed.

## Path-B Integration (Future)

The same structured YAML schema will be reused by the Ollama-based Path-B memory-tiering poller (card 6006f513, advisory mode). The poller will see pre-clear snapshots as examples of "agent intent + config" to inform its tiering suggestions.

## Version

v1 (2026-06-16): schema definition only. Author-driven, curator-reviewed advisory. Write-gate and automation TBD.
