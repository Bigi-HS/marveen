#!/usr/bin/env python3
"""autopilot canary registry -- the DURABLE per-agent enable source of truth.

Spec: store/spec-autopilot-fleet-20261027.md section 2.2 (freeze-carve-out, the
"Boss-gated per-agent canary" referenced by both the tick activation gate and the
WD_THROTTLE_ENABLED rollout).

WHY A FILE, NOT JUST AN ENV VAR
-------------------------------
step5 items 1 & 2 gate on process env (AUTOPILOT_TICK_ENABLED / WD_THROTTLE_ENABLED).
A process-env flip is NOT a durable canary: a watchdog respawn, a supervisor tick,
or a host reboot relaunches the process with a fresh environment and the flag is
GONE -- a silent revert (a false-green: "I enabled it" but the next respawn is back
to legacy). The ONLY way the LLM/operator can flip a canary that SURVIVES respawn is
a persisted registry both consumers read on every invocation. That is this file.

CONTRACT
--------
Registry path: $AUTOPILOT_STORE_DIR/autopilot-canary.json (default store dir).
Schema (both keys optional, each a list of agent-id strings):
    {"tick": ["buster"], "throttle": ["buster"]}
  "tick"     -> AUTOPILOT_TICK (tick.py) enabled for those agents
  "throttle" -> WD_THROTTLE (wd_relaunch) enabled for those agents
Absent file / unreadable / bad-JSON / wrong-type / missing key -> that capability is
OFF for EVERY agent (empty). Agent not in the list -> OFF.

FAIL DIRECTION (lesson-gate-fail-direction-asymmetry-1027, mirrored from both
consumers): any ambiguity resolves to OFF (NOT in canary). For the tick gate OFF =
inert (cost nothing). For the throttle STOP-gate OFF = plain legacy relaunch, i.e.
behaviour-neutral vs the pre-wiring fleet. Both are the SAFE direction: a registry we
cannot parse must never silently enable a live autopilot driver nor silently start
halting a healthy agent. There is NO way for a parse failure to turn a canary ON.

OR-SEMANTICS WITH ENV: the consumers treat env==\"1\" OR registry-membership as
enabled. The env var stays as an explicit per-process override (used by the buster
sim + unit tests); the registry is the durable, operator-facing flip. Neither can be
forged into the other -- a parse failure here just yields False and the env override
is evaluated independently by the caller.

CLI (for the bash consumer, wd_relaunch):
    python3 canary.py <capability> --agent <id>
  exit 0 -> enabled (agent is in the registry list for <capability>)
  exit 1 -> NOT enabled (OFF) -- includes every error/ambiguous case (fail-closed)
  exit 2 -> usage error (unknown capability / missing agent): also treated as OFF by
            the caller, but distinguished so a wiring bug is visible in logs.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Fixed allowlist: an unknown capability can never be "enabled" (a typo at a call
# site fails closed instead of silently reading some attacker-influenced key).
CAPABILITIES = ("tick", "throttle")


def _store_dir() -> str:
    # Read dynamically (not bound at import) so a long-lived consumer and the tests
    # both honour the current AUTOPILOT_STORE_DIR without a module reload.
    return os.environ.get("AUTOPILOT_STORE_DIR", "/home/domin/marveen/store")


def _registry_path() -> str:
    return os.path.join(_store_dir(), "autopilot-canary.json")


def _load() -> dict:
    """Return the parsed registry, or {} on ANY problem (fail-closed to empty)."""
    try:
        with open(_registry_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (FileNotFoundError, OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def is_enabled(capability: str, agent: str) -> bool:
    """True iff <agent> is listed under <capability> in the durable registry.

    Any ambiguity -> False (OFF). Unknown capability -> False. Non-list value under
    the key, or non-string entries -> that entry is ignored (never matches). The
    agent id is compared verbatim (no normalisation): the registry is operator-
    authored, so there is no attacker-controlled fuzzy match to exploit.
    """
    if capability not in CAPABILITIES:
        return False
    if not agent or not isinstance(agent, str):
        return False
    lst = _load().get(capability)
    if not isinstance(lst, list):
        return False
    return agent in [x for x in lst if isinstance(x, str)]


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="autopilot per-agent canary registry check")
    ap.add_argument("capability", help="which gate: " + "|".join(CAPABILITIES))
    ap.add_argument("--agent", required=True, help="agent id to check")
    args = ap.parse_args(argv)
    if args.capability not in CAPABILITIES:
        # Usage error -> exit 2 (visible wiring bug) but the caller treats non-zero
        # as OFF regardless, so this never enables anything.
        print(f"canary: unknown capability {args.capability!r} "
              f"(known: {','.join(CAPABILITIES)})", file=sys.stderr)
        return 2
    return 0 if is_enabled(args.capability, args.agent) else 1


if __name__ == "__main__":
    raise SystemExit(main())
