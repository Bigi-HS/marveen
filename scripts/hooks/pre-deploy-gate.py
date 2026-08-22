#!/usr/bin/env python3
"""PreToolUse hook (Bash): pre-deploy test-freshness gate.

Complements forge-deploy-guard.py (which enforces the Genesis-GO marker). This
hook enforces a SEPARATE precondition: a live dashboard deploy must sit on a
recent GREEN typecheck. It blocks a restart/deploy command unless a fresh
`store/.typecheck-green` marker exists and is younger than MAX_AGE_MINUTES.

Why a second gate: Genesis-GO proves the deploy is authorized; this proves the
code being deployed actually compiles. Both PreToolUse(Bash) hooks coexist --
they match the same restart patterns but assert different, non-overlapping
preconditions (authorization vs. build health).

Marker contract (CI / the deploying agent writes it after a clean run):
    npm run typecheck && touch store/.typecheck-green
The marker's mtime is the freshness signal; its contents are ignored.

Covered restart patterns mirror forge-deploy-guard.py for consistency:
  - tmux send-keys ... dist/index.js
  - node / bun run dist/index.js
  - dashboard.*restart

Exit 0 = allow. Exit 2 = block (Claude Code shows the reason to the agent).
"""
import sys
import os
import json
import re
import time

MAX_AGE_MINUTES = 30

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GREEN_MARKER = os.path.join(INSTALL_DIR, "store", ".typecheck-green")

RESTART_PATTERN = re.compile(
    r'(tmux\s+send.*dist/index\.js'
    r'|(?:node|bun\s+run)\s+dist/index\.js'
    r'|dashboard.*restart)',
    re.IGNORECASE,
)


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

    if os.path.exists(GREEN_MARKER):
        age_min = (time.time() - os.path.getmtime(GREEN_MARKER)) / 60.0
        if age_min <= MAX_AGE_MINUTES:
            sys.exit(0)
        stale_note = (
            f"the green-typecheck marker is stale ({age_min:.0f} min old, "
            f"limit {MAX_AGE_MINUTES} min)"
        )
    else:
        stale_note = "no green-typecheck marker found"

    print(json.dumps({
        "reason": (
            f"DEPLOY BLOCKED by pre-deploy test gate: {stale_note}. "
            "Run a clean typecheck first, then mark it: "
            "`npm run typecheck && touch store/.typecheck-green`, and retry the deploy."
        )
    }))
    sys.exit(2)


if __name__ == "__main__":
    main()
