#!/usr/bin/env python3
"""PreToolUse guardrail: coordination-only agent Write/Edit block (card d5980e4a).

Blocks Write and Edit tool calls unconditionally. Applied to agents that are
designated coordination-only (route/review/manage, no direct implementation).

Rationale: marveen (NoA) is coordination-only per Boss decision 2026-09-03.
Direct file writes indicate the agent is implementing rather than orchestrating.
All implementation must be delegated to ephemeral eng-agents or Dave.

Block mechanism: exit 2 with a reason on stderr (fleet convention). Exit 0 = allow.
Fail-open on internal error (a crashed guard that fails CLOSED would block every
Write/Edit fleet-wide).
"""
import sys
import json


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else None
    except Exception:
        sys.exit(0)  # unreadable/malformed -> fail open

    if not isinstance(payload, dict):
        sys.exit(0)

    tool_name = payload.get('tool_name')
    if tool_name not in ('Write', 'Edit'):
        sys.exit(0)  # matched-tool-only

    try:
        file_path = (payload.get('tool_input') or {}).get('file_path', '?')
    except Exception:
        file_path = '?'

    msg = (
        "COORDINATOR TOOL-LOCK: {tool} blocked for coordination-only agent (card d5980e4a). "
        "Target: {path}. "
        "This agent is designated coordination-only -- delegate all file writes to Dave "
        "or an ephemeral eng-agent. Do NOT retry or work around this block."
    ).format(tool=tool_name, path=file_path)
    sys.stderr.write(msg + '\n')
    sys.exit(2)


if __name__ == '__main__':
    main()
