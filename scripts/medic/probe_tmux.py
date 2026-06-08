#!/usr/bin/env python3
"""Health probe: tmux session liveness.

Contract:
  collect(ex) -> {"sessions": {session_name: bool, ...}}
Read-only. List tmux sessions via `ex.run(["tmux", "ls"])` and map every
expected session to alive/dead. Expected names: "agent-<id>" for each
dispatch.AGENTS, plus "marveen" and "marveen-channels" (the orchestrator). A
missing session is False. Never start/kill anything.
"""
from __future__ import annotations

from typing import Set

from medic.types import Executor
from medic.dispatch import AGENTS

# The orchestrator's two sessions, alongside the per-agent "agent-<id>" ones.
ORCHESTRATOR = ("marveen", "marveen-channels")

# Every session Medic expects to find alive: one per supervised agent plus the
# two orchestrator sessions. Built once from the dispatch allowlist so this
# never drifts from the contract.
EXPECTED = tuple("agent-" + agent for agent in AGENTS) + ORCHESTRATOR


def _live_sessions(ex: Executor) -> Set[str]:
    """Parse `tmux ls` into the set of currently live session names.

    `tmux ls` prints one session per line as "name: N windows (...)". We take
    the substring before the first ":" on each non-empty line. If tmux is not
    running (no server) it exits non-zero with an empty/error body -> no live
    sessions. Read-only: we only list, never touch a session.
    """
    result = ex.run(["tmux", "ls"])
    live: Set[str] = set()
    if result.code != 0:
        return live  # no server / no sessions -> everything reads as dead
    for line in result.out.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        name = line.split(":", 1)[0].strip()
        if name:
            live.add(name)
    return live


def collect(ex: Executor) -> dict:
    live = _live_sessions(ex)
    sessions = {name: (name in live) for name in EXPECTED}
    return {"sessions": sessions}
