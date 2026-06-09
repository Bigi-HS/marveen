#!/usr/bin/env python3
"""Health probe: per-agent Telegram-pipe liveness.  [PHANTOM -- implement]

Contract:
  collect(ex) -> {"pipe_alive": {agent_id: bool, ...}}
Read-only and BEST-EFFORT. The signal: when an agent's Telegram MCP poller is
alive it holds the getUpdates long-poll, so an independent getUpdates against the
same bot returns Telegram error 409 Conflict -> 409 == pipe ALIVE. This requires
each per-agent bot token; if a token is not available to Medic, omit that agent
(do not guess). If no pipe signal is obtainable at all, return {} -- diagnose
must tolerate an empty pipe map. NEVER log any bot token. (Confirm with Dave
which per-agent tokens, if any, Medic may read before wiring live 409 checks.)
"""
from __future__ import annotations

from medic.types import Executor


def collect(ex: Executor) -> dict:
    return {}  # STUB: phantom fills pipe_alive (best-effort, token-gated)
