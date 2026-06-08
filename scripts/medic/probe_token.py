#!/usr/bin/env python3
"""Health probe: main OAuth token expiry + refresh age.  [PHANTOM -- implement]

Contract:
  collect(ex) -> {"token_expires_at": float|None, "token_refreshed_age_sec": float|None}
Read-only. Read ~/.claude/.credentials.json via ex.read_text(); parse
claudeAiOauth.expiresAt (stored in MILLISECONDS -> divide by 1000 for epoch sec).
token_refreshed_age_sec = ex.now() - ex.path_mtime(<cred path>) (how long since
the token file was last rewritten). On any parse/read failure return {} (the
field stays None and diagnose treats it as unknown). NEVER read or surface the
token VALUE -- only the numeric expiry/mtime.
"""
from __future__ import annotations

import os

from medic.types import Executor

CRED_PATH = os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json")


def collect(ex: Executor) -> dict:
    return {}  # STUB: phantom fills token_expires_at + token_refreshed_age_sec
