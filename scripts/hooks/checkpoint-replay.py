#!/usr/bin/env python3
"""SessionStart hook: re-inject a sub-agent's durable CHECKPOINT after a
crash/compact/restart (memory-continuity Phase 1, S3).

The checkpoint is a SUPERSET of the task-state (taskstate-replay.py): it carries
the recent-turns window, focus and pendingObservations bucket on top of the
task-state fields, and it wins over bare task-state on a crash-resume. Runs
BEFORE ledger-replay.py so the server can stamp the one-boot ledger-suppression
marker (dedup) before ledger-replay reads it.

Thin by design (mirrors taskstate-replay.py): the decision (source/consumed/TTL/
empty + the S1 crash-gate, flag-gated on both sides), the FS->DB fallback, the
combined-budget cap and the ledger-suppression stamp all live in the dashboard
(TS, unit-tested). This hook only carries source, prints what the dashboard
returns, then confirms consume.

Ordering (deliberate): read -> inject(print) -> mark consumed. If we die before
printing, the record stays consumed=false so the next start still catches it.
Never breaks session start (always exit 0).
"""
import sys
import os
import json
import urllib.request

API = "http://localhost:3420/api"


def _project_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _token():
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token"), "r") as f:
            return f.read().strip()
    except Exception:
        return ""


def _agent_id_from_cwd(cwd):
    if not cwd:
        return None
    parts = os.path.normpath(cwd).split(os.sep)
    if "agents" in parts:
        i = parts.index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    return None


def _req(method, path, token):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    source = payload.get("source") or ""
    agent = _agent_id_from_cwd(payload.get("cwd"))
    if not agent:
        sys.exit(0)  # main agent / unknown -> not a sub-agent checkpoint target
    token = _token()
    if not token:
        sys.exit(0)

    # READ: the dashboard applies source/consumed/TTL/empty + the flag-gated S1
    # crash-gate, resolves FS-primary-else-DB, and (if lastTurns present) stamps
    # the ledger-suppression marker as a side effect.
    try:
        res = _req("GET", "/agent-checkpoint/%s/replay?source=%s" % (agent, source), token)
    except Exception:
        sys.exit(0)  # dashboard unavailable -> no-op (fail-safe)
    inject = (res or {}).get("additionalContext")
    if not inject:
        sys.exit(0)  # nothing to replay

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": inject,
        }
    }, ensure_ascii=False))
    sys.stdout.flush()

    # MARK CONSUMED -- only AFTER a successful print, so a crash before this
    # leaves the record re-injectable on the next start.
    try:
        _req("POST", "/agent-checkpoint/%s/consume" % agent, token)
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
