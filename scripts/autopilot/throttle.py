#!/usr/bin/env python3
"""Autopilot supervisor RESTART-THROTTLE -- persistent, restart-surviving.

Spec: store/spec-autopilot-fleet-20261027.md section 2.1 (TB-01, CRIT) + INV9.

The STUCK-GATE (section 4, stuck.py) counts *ticks* -- it cannot see an agent that
dies during init (a corrupt hot-memory / bad-JSON crash produces no tick at all).
This module closes that gap with a SEPARATE counter the outer supervisor consults:

  if an agent restarts >= MAX_RESTARTS within WINDOW seconds (default 5 / 600s),
  the supervisor HALTS that agent (no further auto-restart) + Boss-ping + a
  persistent flag; recovery is manual / Boss-GO only (`reset`).

Why a sliding window, not a lifetime count: a healthy agent legitimately restarts
occasionally (context saturation, token-limit reset). Only a *tight burst* --
crash-loop -- is pathological. Timestamps older than WINDOW are pruned each event,
so a slow trickle of restarts never trips (falsification test asserts both sides).

Fail direction (lesson-gate-fail-direction-asymmetry-1027): this is a STOP gate.
Once halted it is STICKY until an explicit `reset` -- fail-CLOSED. An unreadable
state file (`check`) also fails CLOSED (block the restart), because the safe move
when we cannot verify is NOT to keep auto-restarting a possibly-crash-looping agent.

Persistent (B-3/INV6/INV9): store/autopilot-throttle-<agent>.json (NOT /tmp).
A restart NEVER clears this counter (section 2.1 last bullet).
"""
from __future__ import annotations

import argparse
import json
import os
import tempfile
import time

STORE_DIR = os.environ.get("AUTOPILOT_STORE_DIR", "/home/domin/marveen/store")
DEFAULT_MAX_RESTARTS = 5      # section 2.1 TB-01
DEFAULT_WINDOW_S = 600        # 10 minutes


def _safe(agent: str) -> str:
    return "".join(ch for ch in agent if ch.isalnum() or ch in "-_")


def _path(agent: str) -> str:
    return os.path.join(STORE_DIR, f"autopilot-throttle-{_safe(agent)}.json")


def _marker_path(agent: str) -> str:
    # Durable Boss-ping marker (spec §2.1 line 90/287: "halt -> skip + Boss-ping-marker"
    # / "halt -> STOP + Boss-ping"). Kept SEPARATE from the throttle-state file so the
    # out-of-band consumer (notify-halt.py, run from marveen's heartbeat which owns the
    # TG channel) is DECOUPLED from exit codes and watchdog boundaries: a halted agent
    # that is never relaunched again produces no further signal, so the halt must be
    # persisted here or it would be silently lost (nominal != concrete safety net,
    # lesson-auto-mode-safety-net-must-be-concrete-1026).
    return os.path.join(STORE_DIR, f"autopilot-halt-{_safe(agent)}.json")


def _load(path: str) -> dict:
    try:
        with open(path) as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return {}


def _atomic_save(path: str, state: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(state, fh, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _ensure_marker(agent: str, state: dict) -> None:
    """Write/refresh the durable Boss-ping marker when an agent is halted.

    Idempotent across a single halt episode: if a marker already exists it is NOT
    rewritten (so `notified` set by the consumer survives). Only a reset clears it.
    """
    path = _marker_path(agent)
    if os.path.exists(path):
        return  # episode already marked; do not clobber the consumer's `notified`
    _atomic_save(path, {
        "agent": agent,
        "halted_at": state.get("halted_at"),
        "halt_reason": state.get("halt_reason"),
        "restart_count_in_window": state.get("restart_count_in_window"),
        "notified": False,
    })


def _clear_marker(agent: str) -> None:
    path = _marker_path(agent)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


# --- pure core (unit-tested offline, time injected) ------------------------

def eval_restart(state: dict, now: int, window: int = DEFAULT_WINDOW_S,
                 max_restarts: int = DEFAULT_MAX_RESTARTS) -> dict:
    """Record one restart at `now`; trip `halted` on >= max_restarts within window.

    `halted` is sticky: a real crash-loop stays halted until an explicit reset
    (fail-CLOSED). Timestamps older than the sliding window are pruned so a healthy
    slow-restart trickle never accumulates to the threshold.
    """
    state = dict(state)
    state.setdefault("halted", False)  # always present so callers can read it below threshold
    times = [int(t) for t in state.get("restart_times", []) if int(t) > now - window]
    times.append(int(now))
    state["restart_times"] = times
    count = len(times)
    state["restart_count_in_window"] = count
    if count >= max_restarts:
        # Sticky: never flip halted back to False here -- only `reset` clears it.
        if not state.get("halted"):
            state["halted_at"] = int(now)
        state["halted"] = True
        state["halt_reason"] = f"{count} restarts within {window}s"
    # Boss-ping the moment we halt -- this is a severe signal (init crash-loop),
    # not the 2-session threshold the slow STUCK-GATE uses.
    state["ping_boss"] = bool(state.get("halted"))
    state["just_tripped"] = bool(count >= max_restarts and count == max_restarts)
    return state


# --- CLI --------------------------------------------------------------------

def _now() -> int:
    return int(time.time())


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("record-restart",
                        help="supervisor records a restart it just performed")
    pr.add_argument("--agent", required=True)
    pr.add_argument("--window", type=int, default=DEFAULT_WINDOW_S)
    pr.add_argument("--max", type=int, default=DEFAULT_MAX_RESTARTS)
    pr.add_argument("--now", type=int, default=None, help="override clock (testing)")

    pc = sub.add_parser("check",
                        help="supervisor asks BEFORE restarting: may I? exit 1 = HALTED, do NOT restart")
    pc.add_argument("--agent", required=True)

    ps = sub.add_parser("status")
    ps.add_argument("--agent", required=True)

    prs = sub.add_parser("reset", help="manual / Boss-GO recovery -- clears the halt + counter")
    prs.add_argument("--agent", required=True)

    args = ap.parse_args()

    if args.cmd == "record-restart":
        path = _path(args.agent)
        now = args.now if args.now is not None else _now()
        state = eval_restart(_load(path), now, args.window, args.max)
        state["last_update"] = now
        _atomic_save(path, state)
        if state.get("halted"):
            # Trip point: persist the Boss-ping marker so the halt cannot be lost
            # even though this agent will not be relaunched again (spec §2.1).
            _ensure_marker(args.agent, state)
        print(json.dumps({
            "halted": bool(state.get("halted")),
            "just_tripped": bool(state.get("just_tripped")),
            "ping_boss": bool(state.get("ping_boss")),
            "restart_count_in_window": state.get("restart_count_in_window", 0),
            "reason": state.get("halt_reason"),
        }))
        # EXIT 1 == this agent is now halted; the supervisor must STOP auto-restarting it.
        return 1 if state.get("halted") else 0

    if args.cmd == "check":
        path = _path(args.agent)
        if not os.path.exists(path):
            # No history -> never halted -> allow (legitimate first run, not a failure).
            print(json.dumps({"halted": False, "_absent": True}))
            return 0
        try:
            with open(path) as fh:
                state = json.load(fh)
        except (ValueError, OSError):
            # Unreadable state -> fail-CLOSED: block the restart (safe direction).
            print(json.dumps({"halted": True, "_unreadable": True}))
            return 1
        halted = bool(state.get("halted"))
        if halted:
            # Defensive backfill: if a halt was tripped before this marker code
            # existed (or the marker was lost), ensure it is present so the
            # consumer can still fire. Idempotent -- never clobbers `notified`.
            _ensure_marker(args.agent, state)
        print(json.dumps({"halted": halted, "reason": state.get("halt_reason"),
                          "ping_boss": bool(state.get("ping_boss"))}))
        return 1 if halted else 0

    if args.cmd == "status":
        print(json.dumps(_load(_path(args.agent))))
        return 0

    if args.cmd == "reset":
        _atomic_save(_path(args.agent), {"last_update": _now(), "reset": True})
        _clear_marker(args.agent)  # manual/Boss-GO recovery also clears the Boss-ping marker
        print(json.dumps({"reset": True, "agent": args.agent}))
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
