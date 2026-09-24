#!/usr/bin/env python3
"""Checkpoint stamp hook (memory-continuity Phase 1, S3).

Stamps a per-agent durable CHECKPOINT so a crash/compact/restart still leaves a
recent record to resume from. ONE thin dispatcher, reused by three triggers via
an argv tag (no new timer):

  - precompact  (PreCompact) : flush a checkpoint before the context compacts.
  - sessionend  (SessionEnd) : stamp a final checkpoint alongside S1's clean
                               shutdown marker.
  - tick        (UserPromptSubmit) : a periodic mid-session heartbeat so a hard
                               crash still has a recent checkpoint. The DB mirror
                               is throttled server-side (>=30s) so this cannot
                               storm noa.db.

Thin by design (mirrors session-end-marker.py / taskstate-replay.py): the record
shape, the atomic FS write, the throttled noa.db mirror and the TTL all live in
the dashboard (TS, unit-tested via src/web/agent-checkpoint.ts). This hook only
resolves the agent + trigger and POSTs a minimal stamp.

S3 is STORE-ONLY: it captures the durable container (ts/agent + whatever the
deterministic hook can cheaply pass). The agent ACTUALLY dumping recent turns /
observations before compaction is Phase 4 (a prompt/PreCompact-checklist change)
tracked separately -- this hook adds NO prompt-side dumping logic.

Never breaks the turn / compaction / session end: always exit 0.
"""
import sys
import os
import json
import urllib.request

API = "http://localhost:3420/api"


def _project_root():
    # scripts/hooks/ -> project root is two up.
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _token():
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token"), "r") as f:
            return f.read().strip()
    except Exception:
        return ""


def _agent_id_from_cwd(cwd):
    # agents/<name>/... -> <name>; the main agent runs from the project root.
    if not cwd:
        return None
    parts = os.path.normpath(cwd).split(os.sep)
    if "agents" in parts:
        i = parts.index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    return None


def main():
    trigger = sys.argv[1] if len(sys.argv) > 1 else "tick"
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    agent = _agent_id_from_cwd(payload.get("cwd"))
    if not agent:
        sys.exit(0)  # main agent / unknown -> no per-agent checkpoint target
    token = _token()
    if not token:
        sys.exit(0)

    # Minimal stamp: the server writes ts/agent, applies the throttle + TTL, and
    # mirrors to noa.db. focus carries the trigger for observability only.
    body = json.dumps({"focus": "checkpoint:%s" % trigger}).encode("utf-8")
    try:
        req = urllib.request.Request(
            API + "/agent-checkpoint/%s" % agent, data=body, method="POST")
        req.add_header("Authorization", "Bearer " + token)
        req.add_header("Content-Type", "application/json")
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        pass  # dashboard unavailable -> no-op (fail-open; FS/DB just miss this stamp)

    sys.exit(0)


if __name__ == "__main__":
    main()
