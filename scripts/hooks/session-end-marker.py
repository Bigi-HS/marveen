#!/usr/bin/env python3
"""SessionEnd hook: stamp a per-agent CLEAN-shutdown marker (memory-continuity
Phase 1, S1).

A crash (SIGKILL / OOM / panic) never fires SessionEnd, so the mere fact that
this hook runs means the session ended in an orderly way -> stamp clean. At the
next SessionStart the ABSENCE of the marker therefore reads as a crash (wired in
S2). S1 only writes the marker; nothing reads it yet -> ZERO behavior change.

Thin by design (mirrors taskstate-replay.py): the marker format + fail-open write
live in the dashboard (TS, unit-tested via src/web/shutdown-marker.ts). This hook
only resolves the agent and POSTs the stamp. Never breaks session end (exit 0).
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
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    agent = _agent_id_from_cwd(payload.get("cwd"))
    if not agent:
        sys.exit(0)  # main agent / unknown -> no per-agent marker target
    token = _token()
    if not token:
        sys.exit(0)

    try:
        req = urllib.request.Request(
            API + "/shutdown-marker/%s/stamp" % agent, method="POST")
        req.add_header("Authorization", "Bearer " + token)
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        pass  # dashboard unavailable -> no-op (fail-open; absence just reads as crash)

    sys.exit(0)


if __name__ == "__main__":
    main()
