#!/usr/bin/env python3
"""Diagnose: known-failure-signature table + matcher.  [PHANTOM -- implement]

Contract:
  diagnose(snap: HealthSnapshot) -> Diagnosis
Pure function over the merged HealthSnapshot. Walk an ORDERED table of known
failure signatures (most specific / most severe first) and return the first
match as a Diagnosis(cause, detail, fix_command). Causes map to the unstick-
wedged-agent skill's modes:

  cause="token_expired"  when token_expires_in() <= 0 (or oauth_expired log sig)
                         -> fix_command "token-refresh"
  cause="pipe_dead"      when an agent's pipe_alive is False (or pipe_closed sig)
                         -> fix_command "mcp <agent>" / "restart-telegram <agent>"
  cause="session_crash"  when an expected session is down (sessions[x] False)
                         -> fix_command "restart <agent>"
  cause="wedged"         when sessions look alive but stuck_messages > 0
                         (ingested-but-not-processed) -> fix_command "restart <agent>"
  cause="healthy"        when nothing matches and core signals look fine
  cause="unknown"        when signals are too sparse to decide

`detail` is a short human sentence (no secrets, no raw log text). `fix_command`
is a literal Medic command Boss can run next. Keep causes/codes STABLE -- the
test-suite asserts on them. This stub returns "unknown" so the base stays green.
"""
from __future__ import annotations

from medic.types import Diagnosis, HealthSnapshot


def diagnose(snap: HealthSnapshot) -> Diagnosis:
    # STUB: phantom implements the ordered signature table.
    return Diagnosis("unknown", "Triazs meg nincs bekotve (eng/medic-base stub).", "status")
