#!/usr/bin/env python3
"""Handler: `status`.  [PHANTOM -- implement handle()]

Contract:
  handle(ctx: HandlerContext) -> Reply        (ctx.arg is None for status)
Read-only summary for Boss: which sessions are alive (reuse probe_tmux.collect or
`ex.run(["tmux","ls"])`) + the main OAuth token expiry in human terms (reuse
probe_token.collect; format token_expires_at as a Europe/Budapest time and the
remaining hours). Keep it short and plain-text. NEVER print the token value.
Example reply:
  "status: 16/16 session el. Fo token lejar: 2026-06-08 20:57 (~7.8h)."
This stub keeps the base green.
"""
from __future__ import annotations

from medic.types import HandlerContext, Reply


def handle(ctx: HandlerContext) -> Reply:
    return Reply("status: meg nincs bekotve (eng/medic-base stub).")
