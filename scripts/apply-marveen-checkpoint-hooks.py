#!/usr/bin/env python3
"""
Idempotent patcher: wire PreCompact + SessionEnd checkpoint-write.py hooks
into marveen's root .claude/settings.json.

Card:    e810151f (orchestrator checkpoint-wiring)
Run by:  Genesis (marveen) after gate approval -- blackbeard/dave cannot edit
         settings.json directly (deny-listed).

Usage:
    python3 scripts/apply-marveen-checkpoint-hooks.py
    python3 scripts/apply-marveen-checkpoint-hooks.py --dry-run

Pre-conditions checked:
  1. checkpoint-write.py exists at the expected path.
  2. settings.json exists and is valid JSON.

Idempotency:
  - Checks for the PATCH_MARKER string before modifying.
  - Running twice produces the same result.
"""

import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

SETTINGS_PATH = os.path.join(PROJECT_ROOT, ".claude", "settings.json")
HOOK_SCRIPT = os.path.join(PROJECT_ROOT, "scripts", "hooks", "checkpoint-write.py")

# Sentinel that marks an already-patched settings.json.
PATCH_MARKER = "checkpoint-write.py precompact"

PRECOMPACT_ENTRY = {
    "type": "command",
    "command": 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/checkpoint-write.py" precompact',
    "timeout": 5,
}

SESSIONEND_ENTRY = {
    "type": "command",
    "command": 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/checkpoint-write.py" sessionend',
    "timeout": 5,
}


def verify_preconditions():
    if not os.path.isfile(HOOK_SCRIPT):
        print(f"ERROR: hook script not found: {HOOK_SCRIPT}", file=sys.stderr)
        return False
    if not os.path.isfile(SETTINGS_PATH):
        print(f"ERROR: settings.json not found: {SETTINGS_PATH}", file=sys.stderr)
        return False
    return True


def load_settings():
    with open(SETTINGS_PATH, encoding="utf-8") as f:
        return json.load(f)


def already_patched(settings: dict) -> bool:
    raw = json.dumps(settings)
    return PATCH_MARKER in raw


def _ensure_hook_list(hooks: dict, event: str) -> list:
    if event not in hooks:
        hooks[event] = []
    return hooks[event]


def _entry_present(entries: list, command_fragment: str) -> bool:
    for entry in entries:
        hooks = entry.get("hooks", [])
        for h in hooks:
            if command_fragment in h.get("command", ""):
                return True
    return False


def patch(settings: dict) -> dict:
    hooks = settings.setdefault("hooks", {})

    # 1. PreCompact -- add a new matcher block at the end if not present.
    if not _entry_present(hooks.get("PreCompact", []), "checkpoint-write.py"):
        pc_list = _ensure_hook_list(hooks, "PreCompact")
        pc_list.append({"matcher": "auto", "hooks": [PRECOMPACT_ENTRY]})

    # 2. SessionEnd -- append checkpoint-write entry to first (unconditional) block,
    #    or create a new block if none exists.
    if not _entry_present(hooks.get("SessionEnd", []), "checkpoint-write.py"):
        se_list = _ensure_hook_list(hooks, "SessionEnd")
        # Find first unconditional block (no matcher key or matcher='')
        unconditional = next(
            (e for e in se_list if not e.get("matcher")), None
        )
        if unconditional is not None:
            unconditional.setdefault("hooks", []).append(SESSIONEND_ENTRY)
        else:
            se_list.append({"hooks": [SESSIONEND_ENTRY]})

    return settings


def write_settings(settings: dict):
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    dry_run = "--dry-run" in sys.argv

    if not verify_preconditions():
        sys.exit(1)

    settings = load_settings()

    if already_patched(settings):
        print("ALREADY: marveen settings.json already contains checkpoint-write hooks")
        sys.exit(0)

    patched = patch(settings)

    if dry_run:
        print("DRY RUN -- no changes written")
        print(json.dumps(patched, indent=2, ensure_ascii=False))
        sys.exit(0)

    write_settings(patched)
    print("PATCHED: marveen .claude/settings.json -- PreCompact + SessionEnd checkpoint-write hooks added")
    sys.exit(0)


if __name__ == "__main__":
    main()
