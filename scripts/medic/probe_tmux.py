#!/usr/bin/env python3
"""Health probe: tmux session liveness.  [PHANTOM module -- implement collect()]

Contract:
  collect(ex) -> {"sessions": {session_name: bool, ...}}
Read-only. List tmux sessions via `ex.run(["tmux", "ls"])` (or
`["tmux", "list-sessions", "-F", "#{session_name}"]`) and map every expected
session to alive/dead. Expected names: "agent-<id>" for each dispatch.AGENTS,
plus "marveen" and "marveen-channels" (the orchestrator). A missing session is
False. Never start/kill anything.
"""
from __future__ import annotations

from medic.types import Executor


def collect(ex: Executor) -> dict:
    return {}  # STUB: phantom fills {"sessions": {...}}
