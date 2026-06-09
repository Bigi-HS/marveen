#!/usr/bin/env python3
"""Health probe: stuck inter-agent messages.

Contract:
  collect(ex) -> {"stuck_messages": int}
Read-only. Count rows in the agent_messages table that were ingested but never
processed -- delivered_at IS NULL older than a small grace (120s), which is the
wedged-but-not-crashed signature. Parameterised read-only query only; never
string-format values into the SQL. Returns {"stuck_messages": 0} on an empty
table or any error (a broken probe must not blind the rest of triage).
"""
from __future__ import annotations

from medic.types import Executor

# Grace window: a message under delivered_at=NULL for less than this is still
# plausibly in-flight, not wedged. Matches the contract's 120s signature.
GRACE_SEC = 120.0


def collect(ex: Executor) -> dict:
    try:
        rows = ex.query(
            "SELECT COUNT(*) FROM agent_messages "
            "WHERE delivered_at IS NULL AND created_at < ?",
            (ex.now() - GRACE_SEC,),
        )
        count = int(rows[0][0]) if rows and rows[0] else 0
    except Exception:
        count = 0
    return {"stuck_messages": count}
