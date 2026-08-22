#!/usr/bin/env python3
"""UserPromptSubmit hook: long-session anti-bloat freshness nudge (card 705381e3).

Targets the TG3000 incident (2026-07-01: a mid-session user message misread as a
boilerplate no-op under a bloated context). Binds to UserPromptSubmit -- the
natural "a new task arrives" event -- because SessionStart cannot catch a
mid-session turn. Threshold-gated (only long / bloated sessions fire) and
rate-limited (a cooldown between nudges) so normal turns stay quiet. Session age is
tracked from the first prompt seen for the session_id; bloat is proxied by the
transcript file size. Fail-open: any error exits 0 without touching the prompt.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402
import session_enforce_lib as lib  # noqa: E402


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    try:
        agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
        session_id = payload.get("session_id") or "unknown"
        now = time.time()
        cfg = lib.DEFAULT_NUDGE_CONFIG

        path = lib.state_path(lib._install_dir(), agent_id)
        state = lib.load_state(path)
        lib.prune_sessions(state, now, cfg["session_prune_s"])
        entry = lib.get_session_entry(state, session_id, now)

        tbytes = lib.transcript_bytes(payload.get("transcript_path"))
        fire = lib.should_nudge(entry, now, tbytes, cfg)
        if fire:
            entry["last_nudge"] = now
        # Persist unconditionally: even when not firing we must keep first_seen and
        # the pruned map so age accrues across turns.
        lib.save_state(path, state)
    except Exception:
        sys.exit(0)

    if not fire:
        sys.exit(0)

    out = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": lib.build_longsession_nudge(),
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
