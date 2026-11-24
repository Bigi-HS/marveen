#!/usr/bin/env python3
"""Idempotent patcher: wire PostToolUse telemetry-emit.py hook into agent settings.

Card:    e810151f (P0 telemetry hook wiring)
Run by:  Genesis (marveen) after gate approval -- dave cannot edit
         settings.json directly (deny-listed).

Usage:
    python3 scripts/apply-telemetry-hook.py
    python3 scripts/apply-telemetry-hook.py --agent forge
    python3 scripts/apply-telemetry-hook.py --dry-run

Pre-conditions checked per agent:
  1. telemetry-emit.py exists in the agent's CLAUDE_PROJECT_DIR
     (scripts/hooks/telemetry-emit.py relative to the project root).
  2. .claude/settings.json exists and is valid JSON.

Idempotency guard: checks for the EXACT command fragment
  "telemetry-emit.py" in the PostToolUse hook entries -- real struct check,
  NOT a fragile string marker injected into the file.

Staged rollout: use --agent <id> to target a single agent.

Convention: agents share a common project root (repo root). The hook command
  uses the absolute path derived from scripts/hooks/telemetry-emit.py resolved
  from the script's own location (same repo).
"""

import importlib.util
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
PROJECT_ROOT = SCRIPT_DIR.parent  # scripts/ -> repo root

# ---------------------------------------------------------------------------
# Land-script-first guard (card 828fd3ad, SEC-119). Import the standalone
# verifier so this patcher REFUSES to write a settings.json that would wire a
# hook ahead of its script landing on disk (the 2026-11-22 silent-fleet-brick).
# Loaded by path because the module name contains a hyphen.
# ---------------------------------------------------------------------------
_VHW_PATH = SCRIPT_DIR / "hooks" / "verify-hook-wiring.py"
_vhw_spec = importlib.util.spec_from_file_location("verify_hook_wiring", _VHW_PATH)
_vhw = importlib.util.module_from_spec(_vhw_spec)
_vhw_spec.loader.exec_module(_vhw)

HOOK_SCRIPT_REL = Path("scripts") / "hooks" / "telemetry-emit.py"
COMPACT_HOOK_SCRIPT_REL = Path("scripts") / "hooks" / "hot-cache-sessionstart.py"
SETTINGS_REL = Path(".claude") / "settings.json"
AGENTS_DIR = PROJECT_ROOT / "agents"

# Absolute paths of hook scripts in this repo (used in settings.json commands).
HOOK_SCRIPT_ABS = str(PROJECT_ROOT / HOOK_SCRIPT_REL)
COMPACT_HOOK_SCRIPT_ABS = str(PROJECT_ROOT / COMPACT_HOOK_SCRIPT_REL)

# Agents that benefit from hot-cache rehydration after compaction (mini inject).
# marveen is handled by apply-marveen-checkpoint-hooks.py, not this patcher.
MINI_HOT_CACHE_AGENTS = frozenset({"dave", "quill"})

POST_TOOL_USE_ENTRY = {
    "matcher": ".*",
    "hooks": [
        {
            "type": "command",
            "command": f'python3 "{HOOK_SCRIPT_ABS}"',
            "timeout": 5,
        }
    ],
}

SESSION_START_COMPACT_ENTRY = {
    "matcher": "startup|compact",
    "hooks": [
        {
            "type": "command",
            "command": f'python3 "{COMPACT_HOOK_SCRIPT_ABS}"',
            "timeout": 15,
        }
    ],
}

# Fragments that uniquely identify each hook entry in the JSON struct.
_HOOK_FRAGMENT = "telemetry-emit.py"
_COMPACT_HOOK_FRAGMENT = "hot-cache-sessionstart.py"


# ---------------------------------------------------------------------------
# Core predicates
# ---------------------------------------------------------------------------

def presence_verify(agent_dir: str) -> bool:
    """Return True if telemetry-emit.py exists in agent_dir's project scripts."""
    path = Path(agent_dir) / HOOK_SCRIPT_REL
    return path.is_file()


def _entry_present(entries: list, fragment: str) -> bool:
    """Return True if any hook command in entries contains fragment."""
    for entry in entries:
        for h in entry.get("hooks", []):
            if fragment in h.get("command", ""):
                return True
    return False


def already_patched(settings: dict) -> bool:
    """True if the PostToolUse section already contains the telemetry-emit hook."""
    return _entry_present(
        settings.get("hooks", {}).get("PostToolUse", []),
        _HOOK_FRAGMENT,
    )


def presence_verify_compact(agent_dir: str) -> bool:
    """Return True if hot-cache-sessionstart.py exists in agent_dir's project scripts."""
    path = Path(agent_dir) / COMPACT_HOOK_SCRIPT_REL
    return path.is_file()


def already_compact_patched(settings: dict) -> bool:
    """True if the SessionStart section already contains the hot-cache-sessionstart hook."""
    return _entry_present(
        settings.get("hooks", {}).get("SessionStart", []),
        _COMPACT_HOOK_FRAGMENT,
    )


# ---------------------------------------------------------------------------
# Patch logic
# ---------------------------------------------------------------------------

def patch(settings: dict) -> dict:
    """Add the PostToolUse telemetry-emit entry to settings (idempotent)."""
    hooks = settings.setdefault("hooks", {})
    if not _entry_present(hooks.get("PostToolUse", []), _HOOK_FRAGMENT):
        pt_list = hooks.setdefault("PostToolUse", [])
        pt_list.append(POST_TOOL_USE_ENTRY)
    return settings


def patch_compact_matcher(settings: dict) -> dict:
    """Add the SessionStart compact-matcher hot-cache-sessionstart entry (idempotent)."""
    hooks = settings.setdefault("hooks", {})
    if not _entry_present(hooks.get("SessionStart", []), _COMPACT_HOOK_FRAGMENT):
        ss_list = hooks.setdefault("SessionStart", [])
        ss_list.append(SESSION_START_COMPACT_ENTRY)
    return settings


# ---------------------------------------------------------------------------
# Per-agent patching
# ---------------------------------------------------------------------------

def patch_agent(agent_dir: str, dry_run: bool = False) -> bool:
    """Patch a single agent's settings.json. Returns True on success/already-patched."""
    agent_path = Path(agent_dir)
    agent_id = agent_path.name

    if not agent_path.is_dir():
        print(f"WARNING: agent dir not found, skipping: {agent_dir}", file=sys.stderr)
        return False

    if not presence_verify(agent_dir):
        print(
            f"WARNING: telemetry-emit.py not found in {agent_dir}, skipping",
            file=sys.stderr,
        )
        return False

    settings_path = agent_path / SETTINGS_REL
    if not settings_path.is_file():
        print(
            f"WARNING: settings.json not found at {settings_path}, skipping",
            file=sys.stderr,
        )
        return False

    try:
        with open(settings_path, encoding="utf-8") as f:
            settings = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"WARNING: could not parse {settings_path}: {exc}", file=sys.stderr)
        return False

    modified = False

    if not already_patched(settings):
        settings = patch(settings)
        modified = True

    # Wire compact-matcher for context-sensitive agents (MINI_HOT_CACHE_AGENTS).
    if agent_id in MINI_HOT_CACHE_AGENTS:
        if not presence_verify_compact(agent_dir):
            print(
                f"WARNING: hot-cache-sessionstart.py not found in {agent_dir}, "
                f"skipping compact-matcher",
                file=sys.stderr,
            )
        elif not already_compact_patched(settings):
            settings = patch_compact_matcher(settings)
            modified = True

    if not modified:
        print(f"ALREADY: {agent_dir} -- all hooks already present")
        return True

    # Land-script-first guard: REFUSE to write if the resulting settings would
    # wire ANY hook whose script is missing on disk (card 828fd3ad). The agent's
    # own project dir is the repo root (shared-root fleet convention), so we use
    # PROJECT_ROOT for $CLAUDE_PROJECT_DIR resolution.
    try:
        _vhw.assert_scripts_present(settings, str(PROJECT_ROOT))
    except _vhw.HookWiringError as exc:
        print(
            f"ERROR: refusing to patch {agent_dir} -- land-script-first violation:\n{exc}",
            file=sys.stderr,
        )
        return False

    if dry_run:
        print(f"DRY RUN: would patch {agent_dir}")
        print(json.dumps(settings, indent=2, ensure_ascii=False))
        return True

    try:
        with open(settings_path, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"PATCHED: {agent_dir} -- hooks updated")
        return True
    except OSError as exc:
        print(f"ERROR: could not write {settings_path}: {exc}", file=sys.stderr)
        return False


def patch_all(agent_dirs: list, dry_run: bool = False) -> dict:
    """Patch all agents. Returns {agent_dir: bool} result map."""
    results = {}
    for agent_dir in agent_dirs:
        results[agent_dir] = patch_agent(agent_dir, dry_run=dry_run)
    return results


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _discover_agents() -> list:
    """Return list of agent dir paths from the agents/ directory."""
    if not AGENTS_DIR.is_dir():
        return []
    return [
        str(AGENTS_DIR / name)
        for name in sorted(os.listdir(AGENTS_DIR))
        if (AGENTS_DIR / name).is_dir()
    ]


def main() -> int:
    args = sys.argv[1:]
    dry_run = "--dry-run" in args

    # Staged rollout: --agent <id> targets a single agent
    if "--agent" in args:
        idx = args.index("--agent")
        if idx + 1 >= len(args):
            print("ERROR: --agent requires an argument", file=sys.stderr)
            return 1
        agent_id = args[idx + 1]
        agent_dir = str(AGENTS_DIR / agent_id)
        ok = patch_agent(agent_dir, dry_run=dry_run)
        return 0 if ok else 1

    # Default: all agents
    agent_dirs = _discover_agents()
    if not agent_dirs:
        print("WARNING: no agents found in", AGENTS_DIR, file=sys.stderr)
        return 0

    results = patch_all(agent_dirs, dry_run=dry_run)
    patched = sum(1 for v in results.values() if v)
    skipped = len(results) - patched
    print(f"DONE: {patched} patched/already-patched, {skipped} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
