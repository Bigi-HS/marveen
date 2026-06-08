#!/usr/bin/env python3
"""Medic health assembler -- runs every probe and merges into one snapshot.

Dave-owned (stable). It imports each read-only probe module and merges the
fields each one owns into a single HealthSnapshot for `diagnose`. A probe that
raises or returns junk degrades gracefully (it is skipped), so one broken probe
never blinds the whole triage.

Phantom modules implement the individual probe_*.collect(ex) functions; this
file only wires them.
"""
from __future__ import annotations

from medic.types import Executor, HealthSnapshot
from medic import (
    probe_tmux,
    probe_token,
    probe_keepalive,
    probe_pipe,
    probe_stuck,
    probe_logscan,
)

PROBES = [
    probe_tmux.collect,
    probe_token.collect,
    probe_keepalive.collect,
    probe_pipe.collect,
    probe_stuck.collect,
    probe_logscan.collect,
]


def collect(ex: Executor) -> HealthSnapshot:
    snap = HealthSnapshot(now=ex.now())
    for probe in PROBES:
        try:
            partial = probe(ex) or {}
        except Exception:
            continue  # a broken probe must not blind the rest of triage
        if not isinstance(partial, dict):
            continue
        for key, value in partial.items():
            if hasattr(snap, key):
                setattr(snap, key, value)
    return snap
