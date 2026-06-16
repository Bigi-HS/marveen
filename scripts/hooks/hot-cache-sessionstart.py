#!/usr/bin/env python3
"""SessionStart hook: inject per-agent hot-cache context (current tasks / pending work).

This hook injects a per-agent `.claude/hot-cache.md` file into the session's
additionalContext at startup. The hot-cache contains the agent's immediate
context: last task, pending work, top-2-3 active priorities. It complements
the memory-replay hook (which injects vault memories) by providing immediate
situational awareness without a database query.

Injection policy: startup only (cold start). The hook is idempotent and
never breaks session start (always exit 0).

Hot-cache file location per agent:
  - Main agent (marveen): /home/domin/marveen/.claude/hot-cache.md
  - Sub-agents: /home/domin/marveen/agents/<name>/.claude/hot-cache.md

The file is maintained by:
  - The agent itself, OR
  - Applegate (memory curator) as part of the dream-engine consolidation

File format (markdown, ~300-500 words max):
  # <Agent Name> — Hot Cache

  **Last task:** <what was just finished or is active>
  **Pending:** <top-2-3 open items>

  [optional bullet list or prose]

If the file does not exist or is unreadable, the hook silently no-ops.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402  (reuse agent_id_from_cwd + store path)

INJECT_SOURCES = {"startup"}

# Content size limit: ~500 words / 2000 chars max (hot-cache injection budget).
# Keeps additionalContext injection bounded; truncation is lossy but safe.
CONTENT_CHAR_LIMIT = 2000

HEADER = (
    "HOT CACHE (SessionStart). Az aktuális kontextusod: "
    "utolsó feladat, pending munkák, ha újra elindulsz — az azonnali "
    "situational awareness, hogy ne kelljen memória-keresést végezned az elején. "
    "Ez az agent curator által naprakészen tartott pillanatkép."
)


def _hot_cache_path(cwd: str | None) -> Path:
    """Resolve the hot-cache file path for the agent in the given cwd."""
    agent_id = ledger_lib.agent_id_from_cwd(cwd)
    install_dir = ledger_lib._install_dir()

    if agent_id == "marveen":  # Main agent
        return Path(install_dir) / ".claude" / "hot-cache.md"
    else:  # Sub-agent
        return Path(install_dir) / "agents" / agent_id / ".claude" / "hot-cache.md"


def _read_hot_cache(path: Path) -> str | None:
    """Read the hot-cache file if it exists and is readable. Returns None on error."""
    try:
        if path.exists() and path.is_file():
            content = path.read_text("utf-8").strip()
            return content if content else None
    except Exception:
        pass
    return None


def main():
    cwd = None
    source = "startup"
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd")
        source = payload.get("source") or "startup"
    except Exception:
        pass

    if source not in INJECT_SOURCES:
        sys.exit(0)

    cache_path = _hot_cache_path(cwd)
    content = _read_hot_cache(cache_path)

    if not content:
        sys.exit(0)  # no cache available, no-op

    # Truncate to char limit if needed (generous budget; ~500 words).
    if len(content) > CONTENT_CHAR_LIMIT:
        content = content[:CONTENT_CHAR_LIMIT].rstrip() + "\n[truncated]"

    block = f"{HEADER}\n\n{content}"
    out = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": block,
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
