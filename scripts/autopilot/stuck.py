#!/usr/bin/env python3
"""Autopilot STUCK-GATE + rotation state -- persistent, restart-surviving.

Spec: store/spec-autopilot-fleet-20261027.md sections 4 & 5 (gate-PASS r4).
Enforces INV5 (stuck -> EXIT, token-burn never), INV6 (counter survives restart),
INV10 (one card never starves the others).

Two independent stuck signals:
  (a) 3x-identical normalized action  (F-3, F-7)  -- fast loop.
  (b) N consecutive ticks with ZERO kanban card status movement (F-4, TB-02,
      default N=10)                               -- slow divergence / token-burn.

FP-exclusion (FI-03): legitimate idle (idle_ok=true, kanban-query only) must NOT
record actions, so a quiet agent never trips the loop detector. The wrapper calls
`record-action` ONLY on actionable ticks; idle ticks call nothing here.

Boss-ping threshold (F-6): first stuck is silent (EXIT + persistent flag). A Boss
ping is warranted only when the SAME stuck recurs across 2 DIFFERENT sessions.

Persistent (B-3/INV6): store/autopilot-stuck-<agent>.json  (NOT /tmp).
                       store/autopilot-rotation-<agent>.json (SL-01, FLAG-5).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import time

STORE_DIR = os.environ.get("AUTOPILOT_STORE_DIR", "/home/domin/marveen/store")
DEFAULT_N_TICKS = 10  # section 4, Thor R2 FLAG-4
MAX_SAME_CARD_TICKS = 5  # section 5 SL-01


def _path(kind: str, agent: str) -> str:
    safe = "".join(ch for ch in agent if ch.isalnum() or ch in "-_")
    return os.path.join(STORE_DIR, f"autopilot-{kind}-{safe}.json")


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


# --- pure core (unit-tested offline) ---------------------------------------

def normalize_hash(tool: str, arg_struct) -> str:
    """Normalized action fingerprint: tool-name + arg STRUCTURE, not raw values (F-7).

    arg_struct may be a dict (keys->values) or a list of keys. We hash the sorted
    (key, type-name) pairs so "same call shape, different content" collapses to one
    fingerprint -- a DREAM WebSearch with a new query each tick is still one shape.
    """
    if isinstance(arg_struct, dict):
        shape = sorted((str(k), type(v).__name__) for k, v in arg_struct.items())
    elif isinstance(arg_struct, (list, tuple)):
        shape = sorted((str(k), "key") for k in arg_struct)
    else:
        shape = [("_", type(arg_struct).__name__)]
    raw = (tool or "?") + "|" + json.dumps(shape, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def eval_action(state: dict, h: str, session: str) -> dict:
    """Append a normalized action; flag stuck on 3x-identical in a row."""
    recent = list(state.get("recent_hashes", []))
    recent.append(h)
    recent = recent[-3:]
    stuck = len(recent) == 3 and len(set(recent)) == 1
    state = dict(state)
    state["recent_hashes"] = recent
    return _apply_stuck(state, stuck, session, reason="3x-identical-action")


def eval_tick(state: dict, card_moved: bool, session: str, n: int = DEFAULT_N_TICKS) -> dict:
    """Account one actionable tick; flag stuck on N ticks with no card movement."""
    state = dict(state)
    if card_moved:
        state["ticks_since_card_move"] = 0
        # A real move also clears a slow-divergence stuck; the fast-loop flag stands.
    else:
        state["ticks_since_card_move"] = int(state.get("ticks_since_card_move", 0)) + 1
    stuck = state["ticks_since_card_move"] >= n
    return _apply_stuck(state, stuck, session, reason=f"{n}-ticks-no-card-move")


def _apply_stuck(state: dict, now_stuck: bool, session: str, reason: str) -> dict:
    sessions = list(state.get("stuck_sessions", []))
    if now_stuck:
        state["stuck"] = True
        state["stuck_reason"] = reason
        if session and session not in sessions:
            sessions.append(session)
        state["stuck_sessions"] = sessions
    # Boss-ping only once the same stuck spans 2 distinct sessions (F-6).
    state["ping_boss"] = len(sessions) >= 2
    state["stuck_now"] = bool(now_stuck)
    return state


def check_rotation(state: dict, card_id: str, maxn: int = MAX_SAME_CARD_TICKS) -> dict:
    """Return rotation state: must_rotate=True after `maxn` ticks on one card (SL-01)."""
    state = dict(state)
    cur = state.get("current_card")
    if cur == card_id:
        state["same_card_ticks"] = int(state.get("same_card_ticks", 0)) + 1
    else:
        state["current_card"] = card_id
        state["same_card_ticks"] = 1
    state["must_rotate"] = state["same_card_ticks"] > maxn
    return state


# --- CLI --------------------------------------------------------------------

def _finish(path: str, state: dict, session: str) -> int:
    state["session_id"] = session
    state["last_update"] = int(time.time())
    _atomic_save(path, state)
    print(json.dumps({
        "stuck": bool(state.get("stuck")),
        "stuck_now": bool(state.get("stuck_now")),
        "ping_boss": bool(state.get("ping_boss")),
        "reason": state.get("stuck_reason"),
        "ticks_since_card_move": state.get("ticks_since_card_move", 0),
        "must_rotate": bool(state.get("must_rotate")),
        "same_card_ticks": state.get("same_card_ticks", 0),
    }))
    # EXIT 1 means the wrapper must abort the tick (INV5). stuck_now drives the gate.
    return 1 if state.get("stuck_now") else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    pa = sub.add_parser("record-action")
    pa.add_argument("--agent", required=True)
    pa.add_argument("--session", required=True)
    pa.add_argument("--tool", required=True)
    pa.add_argument("--argstruct", default="{}", help="JSON of args (keys+values)")

    pt = sub.add_parser("record-tick")
    pt.add_argument("--agent", required=True)
    pt.add_argument("--session", required=True)
    pt.add_argument("--card-moved", type=int, choices=[0, 1], required=True)
    pt.add_argument("--n", type=int, default=DEFAULT_N_TICKS)

    pr = sub.add_parser("rotation")
    pr.add_argument("--agent", required=True)
    pr.add_argument("--session", required=True)
    pr.add_argument("--card", required=True)
    pr.add_argument("--maxn", type=int, default=MAX_SAME_CARD_TICKS)

    ps = sub.add_parser("status")
    ps.add_argument("--agent", required=True)

    prs = sub.add_parser("reset")
    prs.add_argument("--agent", required=True)
    prs.add_argument("--session", default="manual")

    args = ap.parse_args()

    if args.cmd == "record-action":
        path = _path("stuck", args.agent)
        try:
            arg_struct = json.loads(args.argstruct)
        except ValueError:
            arg_struct = {"_raw": args.argstruct}
        h = normalize_hash(args.tool, arg_struct)
        state = eval_action(_load(path), h, args.session)
        return _finish(path, state, args.session)

    if args.cmd == "record-tick":
        path = _path("stuck", args.agent)
        state = eval_tick(_load(path), bool(args.card_moved), args.session, args.n)
        return _finish(path, state, args.session)

    if args.cmd == "rotation":
        path = _path("rotation", args.agent)
        state = check_rotation(_load(path), args.card, args.maxn)
        state["session_id"] = args.session
        state["last_update"] = int(time.time())
        _atomic_save(path, state)
        print(json.dumps({"must_rotate": state["must_rotate"],
                          "same_card_ticks": state["same_card_ticks"],
                          "current_card": state["current_card"]}))
        return 0

    if args.cmd == "status":
        print(json.dumps(_load(_path("stuck", args.agent))))
        return 0

    if args.cmd == "reset":
        # Clearing stuck is a recovery action -- allowed; rotation also cleared.
        _atomic_save(_path("stuck", args.agent),
                     {"session_id": args.session, "last_update": int(time.time())})
        _atomic_save(_path("rotation", args.agent),
                     {"session_id": args.session, "last_update": int(time.time())})
        print(json.dumps({"reset": True, "agent": args.agent}))
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
