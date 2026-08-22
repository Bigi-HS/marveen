#!/usr/bin/env python3
"""Diagnose: known-failure-signature table + matcher.

Contract:
  diagnose(snap: HealthSnapshot) -> Diagnosis
Pure function over the merged HealthSnapshot. Walk an ORDERED table of known
failure signatures (most specific / most severe first) and return the FIRST
match as a Diagnosis(cause, detail, fix_command).

Ordering rationale (most severe / most actionable first):
  1. token_expired  -- a dead OAuth token freezes the WHOLE fleet, so it wins
                       over any single-agent symptom (which is often just a
                       downstream effect of the token outage).
  2. session_crash  -- a tmux session that should be up is down: the agent is
                       not running at all, so restart it before chasing softer
                       signals.
  3. pipe_dead      -- the agent runs but its Telegram MCP pipe is wedged; a
                       lighter-weight /mcp reconnect, not a full restart.
  4. wedged         -- sessions look alive yet inter-agent messages pile up
                       undelivered (ingested-but-not-processed): the consumer is
                       silently stuck and needs a restart.
  5. healthy        -- core signals present and all nominal.
  6. unknown        -- signals too sparse to decide.

`fix_command` is always a LITERAL Medic command from the dispatch allowlist
(status / diagnose / restart <target> / restart-telegram <agent> / mcp <agent> /
token-refresh / login-link) so Boss can run it verbatim. `detail` is a short,
secret-free human sentence -- never raw log text. Causes/codes are STABLE: the
test-suite asserts on them.
"""
from __future__ import annotations

from typing import Optional

from medic.types import Diagnosis, HealthSnapshot

# Stable log-error signature codes emitted by probe_logscan.collect.
SIG_OAUTH_EXPIRED = "oauth_expired"
SIG_PIPE_CLOSED = "pipe_closed"
SIG_SESSION_CRASH = "session_crash"


def _first_dead(mapping: dict) -> Optional[str]:
    """First key whose value is falsey, scanned in a stable (sorted) order so the
    chosen fix target is deterministic regardless of dict insertion order."""
    for key in sorted(mapping):
        if not mapping[key]:
            return key
    return None


def _has_core_signal(snap: HealthSnapshot) -> bool:
    """True iff the snapshot carries enough to claim 'healthy' rather than fall
    through to 'unknown'. We require at least a known token expiry AND some
    session visibility -- the two load-bearing fleet signals."""
    return snap.token_expires_at is not None and bool(snap.sessions)


def diagnose(snap: HealthSnapshot) -> Diagnosis:
    log_errors = set(snap.log_errors or [])

    # 1) token_expired -- whole-fleet outage; checked first.
    expires_in = snap.token_expires_in()
    if (expires_in is not None and expires_in <= 0) or SIG_OAUTH_EXPIRED in log_errors:
        return Diagnosis(
            "token_expired",
            "A fo OAuth token lejart vagy nemsokara lejar; az egesz flotta erintett.",
            "token-refresh",
        )

    # 2) session_crash -- an expected tmux session is down (agent not running).
    dead_session = _first_dead(snap.sessions)
    if dead_session is not None or SIG_SESSION_CRASH in log_errors:
        if dead_session is not None:
            return Diagnosis(
                "session_crash",
                f"A(z) '{dead_session}' session nem el; ujrainditas szukseges.",
                f"restart {dead_session}",
            )
        # Crash signature in the logs but no specific dead session resolved:
        # surface the verdict, let Boss pick the restart target via status.
        return Diagnosis(
            "session_crash",
            "Crash-szignatura a logokban, de a konkret session nem azonosithato.",
            "status",
        )

    # 3) pipe_dead -- agent runs but its Telegram MCP pipe is wedged.
    dead_pipe = _first_dead(snap.pipe_alive)
    if dead_pipe is not None:
        return Diagnosis(
            "pipe_dead",
            f"A(z) '{dead_pipe}' Telegram-pipe halott (getUpdates nem 409); /mcp ujrahuzas.",
            f"mcp {dead_pipe}",
        )
    if SIG_PIPE_CLOSED in log_errors:
        # Pipe-closed signature with no per-agent pipe map: recommend the
        # generic reconnect path; Boss picks the agent from status.
        return Diagnosis(
            "pipe_dead",
            "MCP-transport zarasi szignatura a logokban; pipe-helyreallitas javasolt.",
            "status",
        )

    # 4) wedged -- sessions look alive yet inter-agent messages pile up
    #    undelivered. The orchestrator ('genesis') is the message deliverer, so
    #    a restart there clears the ingested-but-not-processed backlog.
    if snap.stuck_messages > 0 and snap.sessions and all(snap.sessions.values()):
        return Diagnosis(
            "wedged",
            f"{snap.stuck_messages} agent-uzenet beragadt (kezbesitve=NULL) "
            "miközben a session-ok elnek; csendes wedge.",
            "restart genesis",
        )

    # 5) healthy -- core signals present and nothing matched above.
    if _has_core_signal(snap):
        return Diagnosis(
            "healthy",
            "Minden alapjel rendben: token el, session-ok elnek, nincs beragadt uzenet.",
            "status",
        )

    # 6) unknown -- not enough signal to decide.
    return Diagnosis(
        "unknown",
        "Tul keves health-jel a dontes meghozatalahoz.",
        "status",
    )
