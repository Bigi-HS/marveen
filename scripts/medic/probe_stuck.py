#!/usr/bin/env python3
"""Health probe: stuck inter-agent messages.  [PHANTOM -- implement]

Contract:
  collect(ex) -> {"stuck_messages": int}
Read-only. Count rows in the agent_messages table that were ingested but never
processed -- delivered_at IS NULL older than a small grace (e.g. 120s), which is
the wedged-but-not-crashed signature. Use the parameterised read-only helper:
  ex.query("SELECT COUNT(*) FROM agent_messages "
           "WHERE delivered_at IS NULL AND created_at < ?", (ex.now() - 120,))
Return {"stuck_messages": <int>} (0 on empty/error). Parameterised SQL only --
never string-format values into the query.
"""
from __future__ import annotations

from medic.types import Executor


def collect(ex: Executor) -> dict:
    return {}  # STUB: phantom fills stuck_messages
