#!/usr/bin/env python3
"""Handler: `restart <target>`.  [PHANTOM -- implement handle()]

Contract:
  handle(ctx: HandlerContext) -> Reply
ctx.arg is a PRE-VALIDATED member of dispatch.RESTART_TARGETS (an agent id, or
"genesis", or "all"); never re-parse or trust free text. Map the target to the
supervisor's EXISTING safe relaunch path -- PID/session-scoped only, NEVER
`pkill -f`. Resolve sessions:
  agent id  -> "agent-<id>"
  "genesis" -> orchestrator sessions ("marveen", "marveen-channels")
  "all"     -> every "agent-<id>" (ALL_INCLUDES_ORCHESTRATOR=False by default --
               do NOT bounce the orchestrator on "all" unless Dave flips it)
Prefer invoking the existing relaunch script via ex.run([...]) over ad-hoc tmux
kill+spawn. Report what was restarted. This stub keeps the base green.
"""
from __future__ import annotations

from medic.types import HandlerContext, Reply

# Whether "restart all" also bounces the orchestrator (marveen/marveen-channels).
# Default False: a single "all" must not risk the brain of the fleet.
ALL_INCLUDES_ORCHESTRATOR = False


def handle(ctx: HandlerContext) -> Reply:
    return Reply("restart: meg nincs bekotve (eng/medic-base stub).")
