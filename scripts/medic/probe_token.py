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

import json
import os

from medic.types import Executor

CRED_PATH = os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json")


def collect(ex: Executor) -> dict:
    """Read-only probe: main OAuth token absolute expiry + refresh age.

    Returns {"token_expires_at": <epoch sec>, "token_refreshed_age_sec": <sec>}.
    Each field is included only when it can be derived; any read/parse failure
    yields {} for that part (the snapshot field stays None and diagnose treats
    it as unknown). NEVER reads, parses, or surfaces the token VALUE -- only the
    numeric expiry and the credential file's mtime.
    """
    out: dict = {}

    # Absolute expiry: claudeAiOauth.expiresAt is in MILLISECONDS -> epoch sec.
    raw = ex.read_text(CRED_PATH)
    if raw is not None:
        try:
            data = json.loads(raw)
            expires_ms = data["claudeAiOauth"]["expiresAt"]
            # Guard against bool (a bool is an int subclass) and non-numerics.
            if isinstance(expires_ms, (int, float)) and not isinstance(expires_ms, bool):
                out["token_expires_at"] = float(expires_ms) / 1000.0
        except (ValueError, TypeError, KeyError):
            pass  # malformed credentials -> leave token_expires_at unknown

    # Refresh age: how long since the credential file was last rewritten.
    mtime = ex.path_mtime(CRED_PATH)
    if mtime is not None:
        try:
            out["token_refreshed_age_sec"] = float(ex.now()) - float(mtime)
        except (ValueError, TypeError):
            pass

    return out
