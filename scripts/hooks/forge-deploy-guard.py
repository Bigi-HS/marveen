#!/usr/bin/env python3
"""PreToolUse hook (Bash): blocks dashboard restart commands unless Genesis-GO
marker is present (store/.genesis-go). Prevents accidental live deploys.

Covered patterns (conscious scope -- all paths that restart the dashboard):
  - tmux send-keys ... dist/index.js  (fleet-deploy-verify path)
  - node dist/index.js                (direct invocation)
  - bun run dist/index.js             (bun direct)
  - dashboard.*restart                (any generic restart label)

NOT covered: kill/pkill alone (no restart implied), npm run dev (dev server).

Exit 0 = allow. Exit 2 = block (Claude Code shows the reason to the agent).
"""
import sys
import os
import json
import re

RESTART_PATTERN = re.compile(
    r'(tmux\s+send.*dist/index\.js'
    r'|(?:node|bun\s+run)\s+dist/index\.js'
    r'|dashboard.*restart)',
    re.IGNORECASE,
)

GO_MARKER_PATHS = [
    # hook lives at <install>/scripts/hooks/ -> need 3 dirname levels to reach <install>
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "store", ".genesis-go",
    ),
]


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if payload.get("tool_name") != "Bash":
        sys.exit(0)

    cmd = (payload.get("tool_input") or {}).get("command", "")
    if not RESTART_PATTERN.search(cmd):
        sys.exit(0)

    for path in GO_MARKER_PATHS:
        if os.path.exists(path):
            sys.exit(0)

    print(json.dumps({
        "reason": (
            "DEPLOY BLOCKED: dashboard restart requires Genesis-GO marker. "
            "Create store/.genesis-go (touch store/.genesis-go) after receiving "
            "explicit GO from Genesis, then retry."
        )
    }))
    sys.exit(2)


if __name__ == "__main__":
    main()
