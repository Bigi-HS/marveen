#!/usr/bin/env python3
"""Medic alert-routing classifier (card 79b206b1).

Boss decision (07-29): the medic is the fleet's alert-dispatcher, so the Boss
NEVER receives a raw busy-FAIL. This module ingests a monitor/scheduler Alert,
CLASSIFIES it into one of three classes, and ROUTES it to a pure action
descriptor. A thin dispatch() edge performs the single send for non-SILENT
actions via the injected Executor's run(argv) -- argv lists only, never a shell.

Three classes (card 79b206b1):
  BENIGN_COLLISION -> SILENT        : benign/transient (busy-but-ALIVE target,
                                      a token alert far from expiry). Boss gets
                                      nothing; the monitor silently retries/defers.
  REAL_LAG         -> NOTIFY_OWNER  : a genuine freshness/lag miss by a
                                      responsible agent. Notify THAT agent on its
                                      own channel (inter-agent), NOT Boss.
  REAL_PROBLEM     -> ESCALATE_BOSS : a true fault -- a DEAD/missing session, a
                                      token actually expired/near-expiry, a truly
                                      stale pipe. Escalate to Boss.

LOAD-BEARING DISTINCTION (prior Dave lesson): busy-but-alive != dead-session.
The scheduler's attemptFireTask returns 'busy' when the tmux session EXISTS but
the agent is hung, vs 'missing' when the session is GONE/dead. A busy collision
on a LIVE session (snapshot.sessions[target] is True) is BENIGN_COLLISION
(silent retry); a DEAD or MISSING session (False or absent) is REAL_PROBLEM
(escalate). classify() carries this explicitly via snapshot.sessions.

Design: classify() and route() are PURE (no IO). dispatch() is the only function
that touches the world, and only through ex.run(argv). The route messages are
built from the alert kind/target only -- never echo an alert's raw detail into a
Boss/owner message, so a detail that accidentally carried a secret can't leak.

NEW routing types (Alert, AlertClass, RouteAction) live HERE, not in types.py
(the stable coupling point, which this module must NOT edit).

Live-wiring into the alert emitters (fleet-supervisor.sh, noa-scheduler.ts) is a
deliberate FOLLOW-UP, out of this card's scope -- this delivers the pure module +
its dispatcher + tests only.
"""
from __future__ import annotations

import enum
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from medic.types import Executor, HealthSnapshot

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Named thresholds / constants (no magic numbers in the rules).                 #
# --------------------------------------------------------------------------- #
# A token_expiry alert is REAL_PROBLEM when the token is already expired OR will
# expire within this near-expiry warning window; beyond it the alert is benign.
TOKEN_EXPIRY_WARN_SEC = 1800.0  # 30 min

# Inter-agent relay for Boss escalation: the medic has no Boss Telegram channel
# of its own in the inter-agent bus, so REAL_PROBLEM escalations are posted to
# Genesis (agent_id 'marveen'), the owner of the Boss-facing relay. Genesis
# surfaces it to the Boss. This keeps the medic's only egress on the one audited
# inter-agent message API (argv curl), not a second secret-bearing channel.
BOSS_RELAY_AGENT = "marveen"

# The medic's own agent_id (the 'from' on inter-agent messages it emits).
MEDIC_AGENT = "medic"

# Inter-agent message endpoint on the local dashboard server.
MESSAGES_URL = "http://localhost:3420/api/messages"

# Dashboard token path (guard-safe read-from-file; card 7bd08585 security fix).
# GENESIS_AGENT_TOKEN env var overrides for test/CI injection.
_REPO_ROOT = Path(os.environ.get("MARVEEN_ROOT", Path(__file__).parent.parent.parent))
DASHBOARD_TOKEN_PATH = _REPO_ROOT / "store" / ".dashboard-token"


def _read_dashboard_token() -> str:
    """Read the dashboard Bearer token from the token file or env override."""
    env_token = os.environ.get("GENESIS_AGENT_TOKEN") or os.environ.get("BUSTER_CI_TOKEN")
    if env_token:
        return env_token.strip()
    try:
        return DASHBOARD_TOKEN_PATH.read_text(encoding="utf-8").splitlines()[0].strip()
    except OSError:
        logger.warning("medic routing: could not read dashboard token from %s", DASHBOARD_TOKEN_PATH)
        return ""


# --------------------------------------------------------------------------- #
# Ingested alert + classification + routing descriptors (NEW types, local).     #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Alert:
    """A monitor/scheduler alert handed to the medic for routing.

    kind   : the alert signal -- busy_collision | lag | token_expiry |
             pipe_stale | ... (unmodelled kinds fail closed to REAL_PROBLEM).
    target : the session/agent/subsystem the alert is about (for busy_collision
             this is the tmux session name keyed in HealthSnapshot.sessions).
    owner  : the responsible agent_id for REAL_LAG routing (optional). A lag with
             no owner cannot be routed to an agent, so it escalates to Boss.
    age_sec: how long the condition has persisted (optional, for lag framing).
    detail : a short human description from the emitter. NEVER echoed verbatim
             into a Boss/owner message (it could carry a secret); route messages
             are built from kind/target/age only.
    """
    kind: str
    target: str
    owner: Optional[str] = None
    age_sec: Optional[float] = None
    detail: str = ""


class AlertClass(enum.Enum):
    BENIGN_COLLISION = "benign_collision"
    REAL_LAG = "real_lag"
    REAL_PROBLEM = "real_problem"


@dataclass(frozen=True)
class RouteAction:
    """A pure descriptor of what the dispatcher should do. No IO.

    kind     : SILENT | NOTIFY_OWNER | ESCALATE_BOSS.
    recipient: the agent_id to notify (NOTIFY_OWNER); None for SILENT and (by
               construction, resolved at the edge) for ESCALATE_BOSS.
    message  : human-readable text for the recipient. Empty for SILENT (nothing
               goes to anyone). Never contains the alert's raw detail.
    """
    kind: str
    recipient: Optional[str] = None
    message: str = ""


# --------------------------------------------------------------------------- #
# classify(): PURE 3-class rules.                                               #
# --------------------------------------------------------------------------- #
def _session_alive(snapshot: HealthSnapshot, target: str) -> bool:
    """True only if the target session is present in the snapshot AND alive.
    Absent (missing) or False (dead) both read as not-alive -- the load-bearing
    busy-but-alive vs dead/missing distinction."""
    return bool(snapshot.sessions.get(target, False))


def classify(alert: Alert, snapshot: HealthSnapshot) -> AlertClass:
    """Classify an alert into one of the three classes. PURE -- reads only the
    alert and the snapshot, performs no IO.

    Rules:
      busy_collision: LIVE target -> BENIGN_COLLISION (silent retry);
                      DEAD/MISSING target -> REAL_PROBLEM (escalate).
      lag           : has an owner -> REAL_LAG (notify owner);
                      no owner      -> REAL_PROBLEM (can't route, escalate).
      token_expiry  : expired or within TOKEN_EXPIRY_WARN_SEC -> REAL_PROBLEM;
                      far from expiry -> BENIGN_COLLISION;
                      unknown expiry  -> REAL_PROBLEM (fail closed).
      pipe_stale    : REAL_PROBLEM (a truly stale pipe is a real fault).
      <unknown>     : REAL_PROBLEM (fail closed -- never silently drop).
    """
    kind = alert.kind

    if kind == "busy_collision":
        # busy-but-ALIVE = benign collision; dead/missing session = real problem.
        if _session_alive(snapshot, alert.target):
            return AlertClass.BENIGN_COLLISION
        return AlertClass.REAL_PROBLEM

    if kind == "lag":
        if alert.owner:
            return AlertClass.REAL_LAG
        return AlertClass.REAL_PROBLEM  # no owner to route to -> escalate

    if kind == "token_expiry":
        remaining = snapshot.token_expires_in()
        if remaining is None:
            return AlertClass.REAL_PROBLEM  # unknown -> fail closed
        if remaining <= TOKEN_EXPIRY_WARN_SEC:
            return AlertClass.REAL_PROBLEM  # expired or near-expiry
        return AlertClass.BENIGN_COLLISION  # plenty of time -> stale/benign alert

    if kind == "pipe_stale":
        return AlertClass.REAL_PROBLEM

    # Unmodelled kind: never silently drop -- escalate so it is seen.
    return AlertClass.REAL_PROBLEM


# --------------------------------------------------------------------------- #
# route(): PURE class -> action descriptor.                                     #
# --------------------------------------------------------------------------- #
def _benign_message(alert: Alert) -> str:
    # SILENT carries no message to anyone.
    return ""


def _owner_message(alert: Alert) -> str:
    age = ""
    if alert.age_sec is not None:
        age = f" (~{int(alert.age_sec // 60)}m)"
    return (
        f"[medic] freshness/lag miss on '{alert.target}'{age}. "
        f"You are the responsible owner -- please catch it up."
    )


def _boss_message(alert: Alert) -> str:
    return (
        f"[medic] REAL PROBLEM: {alert.kind} on '{alert.target}'. "
        f"Escalating to Boss -- needs attention."
    )


def route(alert: Alert, cls: AlertClass) -> RouteAction:
    """Map a class to a pure action descriptor. PURE -- no IO.

    BENIGN_COLLISION -> SILENT (no recipient, no message).
    REAL_LAG         -> NOTIFY_OWNER(owner).
    REAL_PROBLEM     -> ESCALATE_BOSS.

    Messages are derived from kind/target/age only (never alert.detail), so a
    detail that accidentally carried a secret cannot leak into a sent message.
    """
    if cls is AlertClass.BENIGN_COLLISION:
        return RouteAction(kind="SILENT", recipient=None, message=_benign_message(alert))

    if cls is AlertClass.REAL_LAG:
        # route() trusts classify() to only yield REAL_LAG when an owner exists.
        return RouteAction(
            kind="NOTIFY_OWNER", recipient=alert.owner, message=_owner_message(alert)
        )

    # REAL_PROBLEM
    return RouteAction(kind="ESCALATE_BOSS", recipient=None, message=_boss_message(alert))


# --------------------------------------------------------------------------- #
# dispatch(): the ONLY IO edge. classify + route, then one send for non-SILENT. #
# --------------------------------------------------------------------------- #
def _post_message(ex: Executor, to: str, content: str, token: str = "") -> bool:
    """Post a single inter-agent message via ex.run(argv) -- an argv LIST, never
    a shell string. Uses curl to the local dashboard /api/messages endpoint.
    Returns True on a zero-exit send. A non-zero exit is logged as a warning
    (card 7bd08585: failed sends must be LOUD, not silently swallowed).

    token: the dashboard Bearer token. Defaults to _read_dashboard_token().
    Injectable for tests.
    """
    bearer = token or _read_dashboard_token()
    body = json.dumps({"from": MEDIC_AGENT, "to": to, "content": content})
    argv = [
        "curl", "-s", "-X", "POST", MESSAGES_URL,
        "-H", "Content-Type: application/json",
        "-H", f"Authorization: Bearer {bearer}",
        "-d", body,
    ]
    res = ex.run(argv)
    if res.code != 0:
        logger.warning(
            "medic routing: _post_message failed (exit=%d) sending to '%s' -- "
            "an ESCALATE_BOSS/NOTIFY_OWNER escalation was silently dropped; "
            "check dashboard auth and connectivity (card 7bd08585)",
            res.code, to,
        )
    return res.code == 0


def dispatch(
    alert: Alert,
    snapshot: HealthSnapshot,
    ex: Executor,
    token: str = "",
) -> RouteAction:
    """Classify + route an alert, then PERFORM the IO at the edge for non-SILENT
    actions. Returns the RouteAction so the outcome is observable/testable.

    SILENT       -> no send at all (Boss gets nothing; monitor retries/defers).
    NOTIFY_OWNER -> exactly one inter-agent message to the owner's own channel.
    ESCALATE_BOSS-> exactly one inter-agent message to the Boss relay (Genesis).

    All IO is confined to this function; classify() and route() stay pure. A send
    failure is logged as a warning (card 7bd08585: silent failure prevention).

    token: dashboard Bearer token. Defaults to _read_dashboard_token(). Injectable
    for tests so they don't require a real token file on disk.
    """
    cls = classify(alert, snapshot)
    action = route(alert, cls)

    if action.kind == "SILENT":
        return action

    bearer = token or _read_dashboard_token()
    if action.kind == "NOTIFY_OWNER":
        _post_message(ex, action.recipient, action.message, token=bearer)
        return action

    # ESCALATE_BOSS -> route to the Boss relay agent, who surfaces it to Boss.
    _post_message(ex, BOSS_RELAY_AGENT, action.message, token=bearer)
    return action
