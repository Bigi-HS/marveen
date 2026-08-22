#!/usr/bin/env python3
"""SessionStart hook: surface per-agent enforcement reminders (card 03a4f57d).

Config-driven from session_enforce_lib.AGENT_SESSIONSTART_CHECKS: hibiki gets the
inbox-check reminder, claudia the email ask-first reminder, every other agent gets
nothing. Deliberately does NOT duplicate the hot-cache staleness guard
(hot-cache-sessionstart.py / fedb4b5f). Fail-open: any error exits 0 silently so
SessionStart is never blocked.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402
import session_enforce_lib as lib  # noqa: E402


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
    reminder = lib.sessionstart_reminder(agent_id)
    if not reminder:
        sys.exit(0)

    out = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": reminder,
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
