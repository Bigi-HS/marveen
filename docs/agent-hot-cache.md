# Agent Hot-Cache SessionStart Hook

**Feature**: Per-agent session memory cache snapshot on SessionStart, reducing context-load on agent restart.

## Overview

Each agent maintains a **hot memory** tier: ephemeral tasks, pending decisions, in-flight work that changes frequently. On SessionStart, the agent's hot tier can exceed the context window when the session is long-lived or highly active.

This feature snapshots the **last N hot memories** + **pending top-K tasks** into a formatted summary that SessionStart injects once per session, so the agent re-orients fast without context bloat.

## Implementation

### SessionStart hook (per-agent)

```bash
# ~/.claude/projects/<AGENT_ID>/settings.json or global hook
"hooks": {
  "SessionStart": {
    "command": "python3 ~/.claude/scripts/inject-hot-cache.py",
    "timeout": 5000
  }
}
```

### Hot-cache snapshot script

`scripts/inject-hot-cache.py`:

```python
import json
from pathlib import Path
from datetime import datetime

# Query memories (hot tier) + kanban (assignee=self)
# Format: "## Hot tasks (as of HH:MM):\n- [title]: status\n\n## Latest decisions:\n- [content_preview]"
# Output: inject into pane as prompt prefix or context-setting message
```

### Activation

- **SessionStart only** (not every prompt)
- **Once per session** (cache invalidates on `/clear`)
- **Opt-in per agent** (warm/cold agents skip, or use default-empty)

## Benefits

- **Fast re-orient**: agent sees last 3-5 hot items on restart
- **No context bloat**: 300-500 words, not full memory dump
- **Task continuity**: pending work visible even after context-compaction or `/clear`

## Limitations

- Hot cache is **snapshot-stale** after the session starts (real hot tier evolves live)
- **Not a memory replacement**: hot memories still persist in the vault; this is an **index**, not storage
- **Applegate curator can omit hot items** that are too transient (flagged `do_not_cache=true`)

## Configuration per agent

Agents can customize via `cache_size` (default 5), `include_kanban` (default true), `snapshot_on_clear` (false → cache invalidates on `/clear`).

Example (Dave engineer):

```json
{
  "hot_cache": {
    "enabled": true,
    "max_items": 3,
    "include_kanban": true,
    "snapshot_on_clear": false
  }
}
```

## Related

- [[applegate-memory-curator]]: Applegate marks hot memories as transient (`do_not_cache`) if needed
- [[SessionStart-memory-autoinject]]: Merges with the memory autoinject hook (both fire on SessionStart)
