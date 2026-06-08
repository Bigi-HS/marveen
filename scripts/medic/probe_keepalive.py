#!/usr/bin/env python3
"""Health probe: supervisor keep-alive / watchdog freshness.  [PHANTOM]

Contract:
  collect(ex) -> {"keepalive_age_sec": float|None, "watchdogs": {name: bool}}
Read-only. keepalive_age_sec = ex.now() - mtime of the supervisor's keep-alive /
heartbeat state file under store/.fleet-supervisor/ (pick the freshest relevant
marker; return None if none). watchdogs = liveness of the known watchdog daemons
(e.g. token-outage-watch, telegram-pipe-watchdog) via `ex.run(["pgrep","-f",
"<script.sh>"])` -> True if rc==0. Never start/kill anything.
"""
from __future__ import annotations

from medic.types import Executor


def collect(ex: Executor) -> dict:
    return {}  # STUB: phantom fills keepalive_age_sec + watchdogs
