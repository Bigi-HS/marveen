#!/usr/bin/env python3
"""Handlers: `mcp <agent>` and `restart-telegram <agent>`.

Both ctx.arg values are PRE-VALIDATED members of dispatch.AGENTS (the dispatcher
rejects anything not in the closed enum), so the handlers NEVER re-parse or
re-validate the argument. The target tmux session is always "agent-<arg>".

All system access goes through ctx.ex.run(argv) -- an argv LIST, never a shell
string, never eval, never shell=True, never pkill -f. ctx.arg is enum-safe, but
we still only ever place it inside an argv element ("agent-<arg>"), so no shell
metacharacter could matter even if the enum changed.

  handle_mcp(ctx) -> Reply
    Shallow Telegram-pipe recovery: send "/mcp" into the agent's tmux pane to
    trigger an interactive MCP reconnect. Reports sent/failed. Reads nothing
    secret.

  handle_restart_telegram(ctx) -> Reply
    Escalating recovery (card fc252db2 B): LEVEL 1 is the same "/mcp" send-keys.
    LEVEL 2 (a deeper channel/MCP re-pull via an existing per-agent recovery
    script) is NOT wired here: no per-agent deep re-pull script exists in the
    repo yet (orchestrator-mcp-reconnect.sh is marveen-channels-only). Rather
    than guess a destructive kill+relaunch, this applies LEVEL 1 and reports
    that the deeper escalation awaits Dave's recovery-script wiring. See
    DEEP_REPULL_SCRIPT below -- when Dave lands the per-agent script, set it and
    the level-2 branch goes live with no other change.
"""
from __future__ import annotations

import os
from typing import Optional

from medic.types import HandlerContext, Reply

# When Dave lands a per-agent deep channel/MCP re-pull script, set this to its
# repo-relative path (e.g. "scripts/agent-mcp-reconnect.sh"). It is invoked as
# ex.run([<abs path>, "agent-<arg>"]) -- argv only, no shell. Until then it is
# None and restart-telegram stops at level 1 and says so (honest skip > guessed
# destructive command). The script MUST be session/PID-scoped, never pkill -f.
DEEP_REPULL_SCRIPT = None

# Repo root: this file is .../<root>/scripts/medic/handlers_telegram.py.
_INSTALL_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)


def _resolve_repull_script() -> Optional[str]:
    """Validate DEEP_REPULL_SCRIPT and return its absolute path, or None if unset
    or unsafe.

    DEEP_REPULL_SCRIPT is a developer-set constant rather than user input, but this
    is recovery code that drives a subprocess, so it validates anyway (defence in
    depth, Chad PR#84 low-finding, card eac0423a): the value MUST be a repo-relative
    path under scripts/ with no '..' segment, and the resolved absolute path MUST
    still live under <root>/scripts/. A misconfigured constant can therefore never
    compose a path-traversal that runs a binary outside the repo's scripts/ dir.
    """
    rel = DEEP_REPULL_SCRIPT
    if not rel:
        return None
    if os.path.isabs(rel) or not rel.startswith("scripts/"):
        return None
    if ".." in rel.split("/"):
        return None
    abs_path = os.path.normpath(os.path.join(_INSTALL_DIR, rel))
    scripts_root = os.path.join(_INSTALL_DIR, "scripts") + os.sep
    if not abs_path.startswith(scripts_root):
        return None
    return abs_path


def _session(arg: str) -> str:
    """The tmux session for a (pre-validated) agent id."""
    return f"agent-{arg}"


def _send_mcp(ctx: HandlerContext) -> bool:
    """Send "/mcp" + Enter into the agent's tmux pane. Returns True on a
    zero-exit send. argv only -- the enum-safe arg only ever lands inside the
    "-t agent-<arg>" target element."""
    session = _session(ctx.arg)
    res = ctx.ex.run(["tmux", "send-keys", "-t", session, "/mcp", "Enter"])
    return res.code == 0


def handle_mcp(ctx: HandlerContext) -> Reply:
    """`mcp <agent>` -- shallow pipe recovery via /mcp send-keys."""
    session = _session(ctx.arg)
    if _send_mcp(ctx):
        return Reply(f"mcp: /mcp elkuldve a(z) {session} pane-be.")
    return Reply(
        f"mcp: NEM sikerult /mcp-t kuldeni a(z) {session} pane-be "
        f"(nem fut a session?)."
    )


def handle_restart_telegram(ctx: HandlerContext) -> Reply:
    """`restart-telegram <agent>` -- escalating channel/MCP recovery.

    Level 1: /mcp send-keys (same as handle_mcp). Level 2: deep re-pull via the
    per-agent recovery script -- only if DEEP_REPULL_SCRIPT is configured.
    """
    session = _session(ctx.arg)
    level1_ok = _send_mcp(ctx)
    level1 = (
        f"L1 /mcp {'elkuldve' if level1_ok else 'SIKERTELEN'} ({session})"
    )

    if DEEP_REPULL_SCRIPT is None:
        # Honest skip: no per-agent deep re-pull script exists to invoke safely.
        return Reply(
            f"restart-telegram: {level1}. "
            f"L2 melyebb channel/MCP ujrahuzas meg NINCS bekotve "
            f"(Dave: per-agent recovery script). Ha L1 nem elegendo, kezi /mcp "
            f"a(z) {session} sessionben."
        )

    script_path = _resolve_repull_script()
    if script_path is None:
        # Configured but failed the path-safety check (not under scripts/, or a
        # traversal attempt). Refuse to run it; stop at level 1.
        return Reply(
            f"restart-telegram: {level1}. L2 KIHAGYVA: a DEEP_REPULL_SCRIPT "
            f"({DEEP_REPULL_SCRIPT!r}) nem biztonsagos path (csak scripts/ alatti, "
            f"'..' nelkuli relativ path engedett). Ha L1 nem elegendo, kezi /mcp "
            f"a(z) {session} sessionben."
        )

    res = ctx.ex.run([script_path, session])
    level2_ok = res.code == 0
    level2 = (
        f"L2 deep re-pull {'OK' if level2_ok else f'SIKERTELEN (rc={res.code})'}"
    )
    return Reply(f"restart-telegram: {level1}; {level2} ({session}).")
