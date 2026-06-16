---
name: pre-clear-snapshot
description: Self-summarize agent context into structured YAML before /clear or /compact, save to cold-tier vault
---

# Pre-Clear Snapshot

Before a hard context reset (`/clear` or `/compact`), agents self-summarize their current state into a structured YAML snapshot and save it to the cold-tier vault. This preserves essential config, flags, and task state across the reset boundary.

## When to use

- Before you run `/clear` (wipe context)
- Before you run `/compact` (shrink context)
- Optional: after major milestones or long sessions (proactive checkpoint)

## Procedure

1. **Review the schema** (see below). It's a YAML template with fields like:
   - `agent_id` (your agent name)
   - `timestamp` (epoch seconds, `date +%s`)
   - `last_task` (what you just finished)
   - `open_questions` (awaiting user/external input)
   - `active_priorities` (next 2-3 priorities)
   - `config_flags` (MAIN_AGENT_ID, SECURITY_PROFILE, etc.)
   - `key_paths` (critical files you reference)
   - `blocked_by` (impediments)

2. **Self-fill the snapshot**. Be honest and specific:
   - `last_task.brief`: 1-2 sentence summary of what you just completed or are currently on
   - `active_priorities`: top 2-3 next steps you expect to resume with
   - `config_flags`: agent-specific settings (at least MAIN_AGENT_ID if you're a sub-agent)
   - Minimal: agent_id + timestamp + last_task.brief + active_priorities (rest optional)

3. **Save to the cold-tier vault**. Use the memory API:
   ```bash
   curl -X POST http://localhost:3420/api/memories \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     -d '{
       "agent_id": "<YOUR_AGENT_ID>",
       "content": "<YOUR_YAML_SNAPSHOT>",
       "category": "cold",
       "keywords": "pre_clear_snapshot, <YOUR_AGENT_ID>"
     }'
   ```
   Replace `<YOUR_AGENT_ID>` and `<YOUR_YAML_SNAPSHOT>` (the full YAML block as a JSON string).

4. **Run `/clear` or `/compact`**.

5. **On resume**, Applegate curator will have the snapshot available in the vault (search keyword: `pre_clear_snapshot`) and can include it in your fresh session if helpful.

## Schema

```yaml
agent_id: dave              # or applegate, thor, etc.
timestamp: 1781631617       # date +%s (epoch seconds)
context_type: "pre_clear_snapshot"

last_task:
  title: "PR #192 review"
  status: done              # done|in_progress|blocked|pending
  brief: "Reviewed hot-cache SessionStart hook, approved for merge to develop."

open_questions:
  - question: "Should hot-cache be wired into sub-agents' settings.json?"
    priority: high
    blocker: no
  - question: "Path-B Ollama poller ETA before Applegate baseline-measure?"
    priority: normal
    blocker: no

active_priorities:
  - priority: "Pre-clear snapshot schema (82717c95) — define & test"
    effort: medium
    dependencies: "none"
  - priority: "Path-B Ollama poller advisory mode MVP"
    effort: large
    dependencies: "Scout spec finalization"
  - priority: "Vault dedup + tier-migration (antikvated hot->cold)"
    effort: small
    dependencies: "none"

config_flags:
  - flag_name: MAIN_AGENT_ID
    value: marveen
    reason: "Sub-agent context: I report to the main orchestrator; use correct channel IDs"
  - flag_name: SECURITY_PROFILE
    value: "developer-senior"
    reason: "Gate decisions (merge, deploy) require my green; maintain auth context"

key_paths:
  - path: "/home/domin/marveen/store/claudeclaw.db"
    purpose: "Kanban + memory vault + conversation ledger"
  - path: "/home/domin/marveen/.claude/settings.json"
    purpose: "Global hook wiring (SessionStart, PreToolUse); changes here affect fleet"
  - path: "/home/domin/marveen/scripts/hooks/"
    purpose: "Agent lifecycle hooks (memory-replay, ledger-replay, etc.)"

blocked_by:
  - "Awaiting Thor's review of PR #192 (hot-cache hook)"
  - "Waiting on Scout's updated Path-B spec (options.think=false clarification)"

notes: "The pre-clear snapshot is self-authored (advisory), not automatic. Applegate curator reviews divergences and decides write-gate thresholds later (phase-2). This is a phase-1 checkpoint mechanism."
```

## Minimal example

If you're in a hurry, at minimum fill:
- agent_id
- timestamp
- last_task.brief (1-2 sentences)
- active_priorities (≥1 item)

The rest is optional.

```yaml
agent_id: buster
timestamp: 1781631617
context_type: "pre_clear_snapshot"

last_task:
  title: "c12 harness integration"
  status: done
  brief: "Integrated hot-cache hook into c12 test harness, verified injection at startup."

active_priorities:
  - priority: "Test pre-clear snapshot saving & retrieval from vault"
    effort: medium
    dependencies: "Applegate schema finalized"

config_flags:
  - flag_name: MAIN_AGENT_ID
    value: marveen
    reason: "Sub-agent, report to marveen"
```

Then save via `curl` (see Procedure step 3).

## Pitfalls

- **Don't forget the `keywords` field** when saving. Use at least `"pre_clear_snapshot, <agent_id>"` so Applegate can find it.
- **YAML escaping**: if your snapshot contains quotes or special chars, wrap the whole YAML in double quotes and escape internal quotes as `\"`.
- **Timestamp**: use `date +%s` to get the current epoch. Frozen timestamps are OK for context snapshots (not real-time logs).
- **Confidentiality**: pre-clear snapshots are cold-tier vault entries, visible to Applegate curator. Don't include sensitive tokens, passwords, or user PII. (Use `<redacted>` if needed.)
- **After reset, Applegate decides** whether to include the snapshot in your fresh session. The curator balances "resume context" vs. "clean slate risk".

## Validation

✓ Saved to vault: `curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:3420/api/memories?agent=<id>&q=pre_clear_snapshot&category=cold"` returns your entry.
✓ JSON-valid YAML: the raw `content` field is valid YAML when parsed.
✓ Minimal fields present: agent_id + timestamp + last_task.brief + active_priorities[0].

## Related

- [memory-autoinject](../memory-autoinject/SKILL.md) — SessionStart vault injection (the inverse: auto-load memories at startup)
- [Path-B Ollama poller](../../docs/ollama-pathb-spec.md) — future reuse of this schema for memory-tiering suggestions
- Card 82717c95 (pre-clear snapshot MVP)

---

**Version:** v1 (2026-06-16). Author-driven, curator-reviewed advisory. Automation and write-gate TBD (phase-2).
