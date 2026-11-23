#!/usr/bin/env python3
"""Scope-aware routing helper -- card 99a535d4, spec §2.3.

Routing decisions for out-of-scope requests:
  - domain in scope.owns          -> {"action": "accept"}
  - domain in scope.excludes      -> {"action": "redirect", "to": redirectTo[domain]}
                                     or {"action": "escalate", "to": "marveen"} if no entry
  - domain not in owns or excludes -> {"action": "accept"}  (pass-through, not restricted)

Redirect events are logged to the daily-log API (one line per redirect).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

_MARVEEN = "marveen"


def route(agent_id: str, domain: str, agent_cfg: dict[str, Any]) -> dict[str, str]:
    """Return a routing decision for a domain request arriving at agent_id.

    Args:
        agent_id: the receiving agent (used only for logging context)
        domain:   the domain label of the incoming request
        agent_cfg: the agent's full config dict (must have a 'scope' key)

    Returns a dict with at minimum an 'action' key:
        {"action": "accept"}
        {"action": "redirect", "to": "<agent_id>"}
        {"action": "escalate", "to": "marveen"}
    """
    scope = agent_cfg.get("scope") or {}
    owns: set[str] = set(scope.get("owns") or [])
    excludes: set[str] = set(scope.get("excludes") or [])
    redirect_to: dict[str, str] = scope.get("redirectTo") or {}

    # owns takes priority (AC-S2 should ensure disjoint, but be safe)
    if domain in owns:
        return {"action": "accept"}

    if domain in excludes:
        target = redirect_to.get(domain)
        if target:
            return {"action": "redirect", "to": target}
        return {"action": "escalate", "to": _MARVEEN}

    # domain not explicitly scoped -> pass-through
    return {"action": "accept"}


def log_redirect_event(
    agent_id: str,
    domain: str,
    decision: dict[str, str],
    api_base: str,
    token: str,
) -> bool:
    """POST one redirect event line to the daily-log API.

    Returns True on success, False on network/HTTP error.
    """
    target = decision.get("to", _MARVEEN)
    action = decision["action"]
    content = (
        f"[scope-redirect] agent={agent_id} domain={domain!r} "
        f"action={action} to={target}"
    )
    payload = json.dumps({"agent_id": agent_id, "content": content}).encode()
    req = urllib.request.Request(
        f"{api_base}/api/daily-log",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            return True
    except (urllib.error.URLError, OSError):
        return False
