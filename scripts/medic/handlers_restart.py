#!/usr/bin/env python3
"""Handler: `restart <target>`.

Contract:
  handle(ctx: HandlerContext) -> Reply
ctx.arg is a PRE-VALIDATED member of dispatch.RESTART_TARGETS (an agent id, or
"genesis", or "all"); it is never re-parsed or trusted as free text. We map the
target to the supervisor's EXISTING relaunch path -- PID/session-scoped only,
NEVER `pkill -f`.

How "restart" works here (and why it is safe):
  The fleet has no one-shot "relaunch agent X" script. Each sub-agent is kept
  alive by an always-on watchdog loop (scripts/<name>-watchdog.sh /
  scripts/agent-watchdog.sh / scripts/dave-watchdog.sh) and the orchestrator by
  scripts/fleet-supervisor.sh. Those loops are detect-and-START only: when an
  agent's tmux session DIES, the watchdog revives it within ~30-60s with the
  configured model and `--continue` (task continuity preserved). So the existing,
  battle-tested relaunch path is triggered by tearing down the session -- nothing
  else -- and letting the supervisor bring it back.

  We tear down a session with `tmux kill-session -t <session>`, which is strictly
  SESSION-scoped (it kills exactly the named tmux session, no broad process
  matching). This is the deliberate opposite of `pkill -f`, which could match and
  kill unrelated processes. We never spawn an agent ourselves either, so a Medic
  bug can never launch with the wrong model/creds -- the supervisor owns launch.

Session resolution (dispatch.py is the source of truth for the enums):
  agent id  -> "agent-<id>"
  "genesis" -> the orchestrator sessions ("marveen", "marveen-channels")
  "all"     -> every "agent-<id>" (ALL_INCLUDES_ORCHESTRATOR=False by default --
               "all" must NOT bounce the orchestrator unless Dave flips the flag)

TODO(dave): if a dedicated idempotent one-shot relaunch helper is ever added
(e.g. `scripts/relaunch-agent.sh <session>` that kills+respawns deterministically
without waiting on the watchdog tick), prefer invoking THAT here via
`ex.run([...])` instead of the kill-session-and-wait-for-watchdog approach. The
kill-session path below is the conservative, non-destructive option that uses
only mechanisms already in production today.
"""
from __future__ import annotations

from typing import List, Tuple

from medic.dispatch import AGENTS
from medic.types import HandlerContext, Reply

# Whether "restart all" also bounces the orchestrator (marveen/marveen-channels).
# Default False: a single "all" must not risk the brain of the fleet. Mirrors the
# open question flagged in dispatch.py; only flip this with Boss sign-off.
ALL_INCLUDES_ORCHESTRATOR = False

# The orchestrator (Genesis) tmux sessions. Kept here next to the resolver so the
# session naming lives with the handler that acts on it.
ORCHESTRATOR_SESSIONS: Tuple[str, ...] = ("marveen", "marveen-channels")

# Agents fleet-supervisor.sh ensures a reviving watchdog for -- the ONLY targets
# for which "kill the session and let the supervisor bring it back" actually
# holds. Source of truth: scripts/fleet-supervisor.sh ensure_dave_watchdog +
# ensure_agent_watchdogs (gauge/quill/scout/applegate/radar) +
# ensure_channel_watchdogs (forge/chad/thor/claudia/bigben/hibiki).
# Deliberately EXCLUDED (verified 2026-06-08, no supervisor revival path):
#   buster    -- the chameleon sandbox, managed by the c12 harness, not supervised
#   heartbeat -- the memoria-heartbeat, not a tmux "agent-*" session at all
# Killing an excluded target would be a permanent silent stop, so `restart`
# refuses it instead of falsely promising a ~30-60s revival.
SUPERVISED_AGENTS = frozenset({
    "dave",
    "gauge", "quill", "scout", "applegate", "radar",
    "forge", "chad", "thor", "claudia", "bigben", "hibiki",
})


def _sessions_for(target: str) -> List[str]:
    """Map a pre-validated restart target to the tmux session names to bounce.

    `target` is trusted to be a member of dispatch.RESTART_TARGETS (dispatch.py
    has already enum-validated it); we do not re-validate loosely.
    """
    if target == "all":
        # Only supervised agents -- "all" must not silently permanent-kill an
        # un-revivable session (buster/heartbeat).
        sessions = [f"agent-{a}" for a in AGENTS if a in SUPERVISED_AGENTS]
        if ALL_INCLUDES_ORCHESTRATOR:
            sessions += list(ORCHESTRATOR_SESSIONS)
        return sessions
    if target == "genesis":
        return list(ORCHESTRATOR_SESSIONS)
    if target in SUPERVISED_AGENTS:
        return [f"agent-{target}"]
    # Unsupervised single agent: no reviving watchdog -> nothing to bounce.
    return []


def _session_alive(ctx: HandlerContext, session: str) -> bool:
    """True iff the tmux session exists. Read-only; tolerates a missing tmux
    (then nothing is reported alive and nothing is killed)."""
    res = ctx.ex.run(["tmux", "has-session", "-t", session])
    return res.code == 0


def _kill_session(ctx: HandlerContext, session: str) -> bool:
    """Tear down exactly one tmux session so the supervisor's existing relaunch
    path revives it. SESSION-scoped only -- never `pkill -f`. True on success."""
    res = ctx.ex.run(["tmux", "kill-session", "-t", session])
    return res.code == 0


def handle(ctx: HandlerContext) -> Reply:
    target = ctx.arg
    if target is None:  # unreachable: dispatch guarantees an arg for `restart`
        return Reply("restart: hianyzo cel (belso hiba).")

    # Refuse a single unsupervised target: no watchdog would revive it, so a kill
    # is a permanent silent stop. Never kill what nothing brings back.
    if target not in ("all", "genesis") and target not in SUPERVISED_AGENTS:
        return Reply(
            f"restart {target}: nincs felugyelo watchdog, nem eled ujra auto -- "
            "kihagyva (buster=chameleon-sandbox, heartbeat=nem agent-session). "
            "Ezt kezi inditas / a c12-harness kezeli, nem a Medic."
        )

    sessions = _sessions_for(target)

    bounced: List[str] = []   # killed -> watchdog will relaunch
    absent: List[str] = []    # not running (nothing to restart)
    failed: List[str] = []    # tmux refused / errored on a live session

    for session in sessions:
        if not _session_alive(ctx, session):
            absent.append(session)
            continue
        if _kill_session(ctx, session):
            bounced.append(session)
        else:
            failed.append(session)

    return Reply(_format_report(target, bounced, absent, failed))


def _format_report(
    target: str,
    bounced: List[str],
    absent: List[str],
    failed: List[str],
) -> str:
    """Build the short plain-text Boss report summarising what was bounced."""
    parts: List[str] = [f"restart {target}:"]
    if bounced:
        parts.append(
            f"ujrainditva ({len(bounced)}): " + ", ".join(bounced)
            + " -- a supervisor ~30-60s-en belul visszahozza."
        )
    if absent:
        parts.append(f"nem futott ({len(absent)}): " + ", ".join(absent))
    if failed:
        parts.append(f"HIBA leallitaskor ({len(failed)}): " + ", ".join(failed))
    if not bounced and not absent and not failed:
        parts.append("nincs ervintett session.")
    return " ".join(parts)
