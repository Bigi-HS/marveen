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

# The supervisor (scripts/fleet-supervisor.sh) refreshes per-component marker
# files under this dir every tick: "<comp>.launched" (touched on each launch),
# "<comp>.next" / "<comp>.fails" (backoff state). The freshest of these is the
# fleet keeper's keep-alive heartbeat -- if the supervisor stops ticking, none of
# them advance and the age climbs. Relative to the repo root.
STATE_DIR = "store/.fleet-supervisor"

# Marker files the supervisor writes per tick. We probe each candidate's mtime
# and keep the freshest (largest mtime). Read-only; missing files are ignored.
KEEPALIVE_MARKERS = (
    "channels.launched",
    "channels.next",
    "hibiki-push.next",
)

# Known watchdog daemons whose liveness Medic reports. Keys are stable short
# names (what diagnose/status display); values are the script path each daemon
# runs under, matched the same way the supervisor itself matches them
# (pgrep -f "scripts/<name>.sh"). Read-only liveness only -- never start/kill.
WATCHDOGS = {
    "fleet-supervisor": "scripts/fleet-supervisor.sh",
    "token-outage-watch": "scripts/token-outage-watch.sh",
    "telegram-pipe-watchdog": "scripts/telegram-pipe-watchdog.sh",
}


def _keepalive_age_sec(ex: Executor):
    """Age (sec) of the freshest supervisor marker, or None if none exist."""
    newest = None
    for marker in KEEPALIVE_MARKERS:
        mtime = ex.path_mtime(STATE_DIR + "/" + marker)
        if mtime is not None and (newest is None or mtime > newest):
            newest = mtime
    if newest is None:
        return None
    age = ex.now() - newest
    # Clamp a future mtime (clock skew) to 0 rather than reporting a negative age.
    return age if age > 0 else 0.0


def _watchdog_alive(ex: Executor, script: str) -> bool:
    """True iff a process matching the watchdog script is running (rc==0)."""
    return ex.run(["pgrep", "-f", script]).code == 0


def collect(ex: Executor) -> dict:
    return {
        "keepalive_age_sec": _keepalive_age_sec(ex),
        "watchdogs": {
            name: _watchdog_alive(ex, script)
            for name, script in WATCHDOGS.items()
        },
    }
