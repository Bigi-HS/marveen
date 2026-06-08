#!/usr/bin/env python3
"""Health probe: recent log error-signature scan.

Contract:
  collect(ex) -> {"log_errors": [signature_code, ...]}
Read-only. Scan a bounded tail of the fleet logs under store/*.log and map raw
lines to a small set of STABLE signature codes -- raw log text is NEVER returned.
Stable codes (kept stable for patterns.py / the test-suite):
  "oauth_expired"   <- invalid/expired bearer token, OAuth expiry, re-auth prompt
  "usage_limit"     <- usage-limit / "wait for reset" / upgrade menu
  "pipe_closed"     <- MCP transport / connection closed, broken pipe
  "session_crash"   <- process exit / traceback markers

Bounded by design: only the last TAIL_BYTES of each log are inspected so a huge
log never blocks triage, and at most MAX_LOGS files are read. Discovery lists the
store/ directory; all file CONTENT is read through the injected Executor
(ex.read_text) so the probe stays fully mockable and the read-only contract holds.
"""
from __future__ import annotations

import glob
import os
from typing import List

from medic.types import Executor

# This module lives at <repo>/scripts/medic/probe_logscan.py; the logs are under
# <repo>/store/*.log. Derive the repo root the same way bot.py's INSTALL_DIR does.
_INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STORE_GLOB = os.path.join(_INSTALL_DIR, "store", "*.log")

# Bounds: never read more than this many bytes from the end of a log, and never
# scan more than this many log files -- a runaway log must not block triage.
TAIL_BYTES = 64 * 1024
MAX_LOGS = 60

# Ordered (code, substrings) signature table. A line that contains ANY of a
# code's substrings (case-insensitive) contributes that code. Substrings are
# deliberately generic markers, never secrets. Keep codes STABLE.
_SIGNATURES = (
    ("oauth_expired", (
        "invalid bearer token",
        "oauth token expired",
        "token expired",
        "401 unauthorized",
        "please re-authenticate",
        "re-auth",
        "authentication_error",
        "invalid_grant",
    )),
    ("usage_limit", (
        "usage limit",
        "usage-limit",
        "wait for reset",
        "approaching usage limit",
        "rate limit",
        "rate_limit",
        "429",
        "upgrade to continue",
        "credits required",
    )),
    ("pipe_closed", (
        "connection closed",
        "transport closed",
        "mcp transport",
        "broken pipe",
        "pipe closed",
        "epipe",
        "econnreset",
        "server disconnected",
    )),
    ("session_crash", (
        "traceback (most recent call last)",
        "segmentation fault",
        "fatal error",
        "process exited",
        "exited with code",
        "uncaughtexception",
        "panic:",
        "core dumped",
        "killed",
    )),
)


def _tail(text: str, limit: int = TAIL_BYTES) -> str:
    """Return at most the last `limit` characters of `text`. Bounding on the
    string is enough here -- read_text already returns decoded text -- and keeps
    the probe stdlib-only and executor-agnostic."""
    if len(text) <= limit:
        return text
    return text[-limit:]


def collect(ex: Executor) -> dict:
    """Scan a bounded tail of store/*.log and return matched stable signature
    codes (de-duplicated, sorted). Best-effort: any unreadable log is skipped and
    an empty result is returned rather than raising."""
    found = set()
    try:
        paths = sorted(glob.glob(STORE_GLOB))
    except OSError:
        return {"log_errors": []}

    for path in paths[:MAX_LOGS]:
        content = ex.read_text(path)
        if not content:
            continue
        haystack = _tail(content).lower()
        for code, markers in _SIGNATURES:
            if code in found:
                continue  # already matched elsewhere; skip the substring scan
            for marker in markers:
                if marker in haystack:
                    found.add(code)
                    break

    codes: List[str] = sorted(found)
    return {"log_errors": codes}
