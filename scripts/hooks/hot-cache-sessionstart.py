#!/usr/bin/env python3
"""SessionStart hook: inject per-agent hot-cache context (current tasks / pending work).

Injection policy (card 847237f4 F3 -- cut fixed per-fire priming):

  - resume / clear: full hot-cache for every agent (~2000 chars). Resuming an
    existing session needs immediate situational awareness.
  - startup (cold start):
      * context-sensitive agents (dave, quill): mini hot-cache (<= 800 chars).
        These agents carry long-lived state and benefit from a brief reminder
        even on a fresh start.
      * stateless agents (thor, gauge, and all others): skip entirely. Cold
        starts don't need the hot-cache; the memory-replay hook supplies vault
        facts. Saving these injections removes ~25-35K tokens/day fleet-wide.

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
import ledger_lib  # noqa: E402

# resume + clear: full inject for all agents.
FULL_INJECT_SOURCES = {"resume", "clear"}

# startup: only context-sensitive agents get a mini inject.
MINI_HOT_CACHE_AGENTS = {"dave", "quill"}

# Full inject limit (~500 words).
CONTENT_CHAR_LIMIT = 2000
# Mini inject limit (startup budget for context-sensitive agents, ~200 tokens).
MINI_CONTENT_CHAR_LIMIT = 800

HEADER = (
    "HOT CACHE (SessionStart). Az aktuális kontextusod: "
    "utolsó feladat, pending munkák, ha újra elindulsz — az azonnali "
    "situational awareness, hogy ne kelljen memória-keresést végezned az elején. "
    "Ez az agent curator által naprakészen tartott pillanatkép."
)


def _agent_id(cwd: str | None) -> str:
    return ledger_lib.agent_id_from_cwd(cwd)


def _hot_cache_path(cwd: str | None) -> Path:
    agent_id = _agent_id(cwd)
    install_dir = ledger_lib._install_dir()
    if agent_id == "marveen":
        return Path(install_dir) / ".claude" / "hot-cache.md"
    return Path(install_dir) / "agents" / agent_id / ".claude" / "hot-cache.md"


def _read_hot_cache(path: Path) -> str | None:
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

    # Determine inject mode for this source + agent combination.
    if source in FULL_INJECT_SOURCES:
        char_limit = CONTENT_CHAR_LIMIT
    elif source == "startup" and _agent_id(cwd) in MINI_HOT_CACHE_AGENTS:
        char_limit = MINI_CONTENT_CHAR_LIMIT
    else:
        # startup + stateless agent: skip.
        sys.exit(0)

    cache_path = _hot_cache_path(cwd)
    content = _read_hot_cache(cache_path)

    if not content:
        sys.exit(0)

    if len(content) > char_limit:
        content = content[:char_limit].rstrip() + "\n[truncated]"

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
