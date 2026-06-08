#!/usr/bin/env python3
"""Handlers: `mcp <agent>` and `restart-telegram <agent>`.  [PHANTOM -- implement]

Both ctx.arg values are PRE-VALIDATED members of dispatch.AGENTS (never re-parse).
Target session is always "agent-<arg>".

  handle_mcp(ctx) -> Reply
    Shallow pipe recovery: send "/mcp" into the agent's tmux pane, e.g.
      ex.run(["tmux", "send-keys", "-t", f"agent-{ctx.arg}", "/mcp", "Enter"])
    Report sent/failed. Read-nothing-secret.

  handle_restart_telegram(ctx) -> Reply
    Escalating recovery (card fc252db2 B): first the /mcp send-keys above; if that
    is known-insufficient, a deeper channel/MCP re-pull via the existing recovery
    script (invoke it through ex.run([...]) -- argv only, no shell). Report which
    level was applied.

argv lists only; never build a shell string from ctx.arg (it is enum-safe anyway).
These stubs keep the base green.
"""
from __future__ import annotations

from medic.types import HandlerContext, Reply


def handle_mcp(ctx: HandlerContext) -> Reply:
    return Reply("mcp: meg nincs bekotve (eng/medic-base stub).")


def handle_restart_telegram(ctx: HandlerContext) -> Reply:
    return Reply("restart-telegram: meg nincs bekotve (eng/medic-base stub).")
