#!/usr/bin/env python3
"""Health probe: recent log error-signature scan.  [PHANTOM -- implement]

Contract:
  collect(ex) -> {"log_errors": [signature_code, ...]}
Read-only. Scan the tail of the relevant fleet logs under store/ (e.g.
token-outage-watch.log, fleet-supervisor log, dashboard log) and map raw lines to
a small set of STABLE signature codes -- never return raw log text. Suggested
codes (extend as needed, keep them stable for the matcher/tests):
  "oauth_expired"   <- "Invalid bearer token" / "OAuth token expired" / re-auth prompt
  "usage_limit"     <- usage-limit / "wait for reset" menu
  "pipe_closed"     <- "connection closed" / MCP transport closed
  "session_crash"   <- process exit / traceback markers
Return de-duplicated codes only. Read a bounded tail (last N KB) so a huge log
never blocks. NEVER surface secrets or raw user/log content.
"""
from __future__ import annotations

from medic.types import Executor


def collect(ex: Executor) -> dict:
    return {}  # STUB: phantom fills log_errors (stable signature codes only)
