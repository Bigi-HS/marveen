#!/usr/bin/env python3
"""Autopilot IDLE-GATE classifier -- deterministic, agent-scoped, fail-safe busy.

Spec: store/spec-autopilot-fleet-20261027.md (gate-PASS r4). This is the single
source of the idle predicate (INV1/INV2/INV3) and the PARKED staleness-kapu (section 3).

It answers ONE boolean for a given agent: may this agent legitimately go idle?
  idle_ok == (MINE empty) AND (NUDGEABLE empty)      # PARKED does NOT block idle
plus the actionable lists the tick-wrapper injects into the preamble.

Hard rules baked in (NOT left to the LLM):
  INV2  any fetch/parse error -> idle_ok := false (fail-safe busy; error != empty).
  sec3  PARKED is never permanent: a stale marker auto-expires into NUDGEABLE.
        awaiting/boss-go marker  -> parked only while age < 48h   (FI-01, CRIT)
        delegated (owned by peer)-> parked only while age < 24h   (FI-02)
        repro-blocked marker     -> parked only while age < 72h   (BP-02)

The classification core `classify(cards, agent, now, orchestrator)` is PURE
(no I/O) so it is unit-tested offline against card fixtures. The CLI wraps it
with the guard-safe API fetch and the fail-safe envelope.

Usage:
  python3 scripts/autopilot/classify.py --agent marveen [--json]
  python3 scripts/autopilot/classify.py --agent dave --cards-file fixture.json --now 1700000000
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time

OPEN = {"planned", "in_progress", "waiting"}
ORCHESTRATOR = "marveen"  # only the orchestrator tracks delegated/unassigned cards as nudgeable

# Staleness windows in HOURS -- a marker only parks a card while fresh (section 3).
WINDOW_AWAITING_H = 48.0  # FI-01
WINDOW_DELEGATED_H = 24.0  # FI-02
WINDOW_BLOCKED_H = 72.0  # BP-02

# repro-blocked is an explicit LLM-judged blocker marker (BP-02).
BLOCKED_RE = re.compile(r"repro-?blocked|blocker:|blocked:", re.I)
# awaiting/parked: Boss owes the next move, or the card is deliberately held.
AWAITING_RE = re.compile(
    r"awaiting-?dominik|awaiting|do-?not-?nudge|parked|boss-?oldali|boss-?go|"
    r"vak[aa]ci|nyaral|visszat[ee]r|oauth-consent|deploy-gated|\bTG\d",
    re.I,
)


def _age_hours(card: dict, now: float) -> float:
    ua = card.get("last_moved") or card.get("updated_at") or card.get("created_at") or 0
    try:
        return max(0.0, (now - float(ua)) / 3600.0)
    except (TypeError, ValueError):
        # Unparseable timestamp -> treat as ancient so a stale marker cannot hide it.
        return 1e9


def _marker(text: str):
    """Return ('blocked'|'awaiting', window_hours) or (None, 0)."""
    if BLOCKED_RE.search(text):
        return "blocked", WINDOW_BLOCKED_H
    if AWAITING_RE.search(text):
        return "awaiting", WINDOW_AWAITING_H
    return None, 0.0


def _row(card: dict, age_h: float, bucket: str) -> dict:
    return {
        "id": (card.get("id") or "")[:8],
        "status": card.get("status"),
        "priority": card.get("priority"),
        "assignee": card.get("assignee") or card.get("owner") or "",
        "title": (card.get("title") or "")[:60],
        "age_d": round(age_h / 24.0, 1),
        "bucket": bucket,
    }


def classify(cards, agent: str, now: float, orchestrator: str = ORCHESTRATOR) -> dict:
    """Pure classification. Returns buckets + idle_ok for `agent`.

    MINE       = open cards this agent owns and must drive now (not fresh-parked).
    NUDGEABLE  = stale cards this agent is responsible for poking (orchestrator only).
    PARKED     = legitimately held RIGHT NOW (fresh marker / fresh delegation).
    idle_ok    = MINE empty AND NUDGEABLE empty.
    """
    mine, nudgeable, parked = [], [], []
    for c in cards:
        if c.get("status") not in OPEN:
            continue
        owner = c.get("assignee") or c.get("owner") or ""
        age_h = _age_hours(c, now)
        text = (c.get("title") or "") + "\n" + (c.get("description") or "")
        marker, window = _marker(text)
        fresh_marker = marker is not None and age_h < window

        if owner == agent:
            if fresh_marker:
                parked.append(_row(c, age_h, "marker:" + marker))
            else:
                mine.append(_row(c, age_h, "mine"))
        elif owner and owner != agent:
            # Owned by a peer. Only the orchestrator tracks these.
            if agent != orchestrator:
                continue
            if fresh_marker:
                parked.append(_row(c, age_h, "marker:" + marker))
            elif age_h < WINDOW_DELEGATED_H:
                parked.append(_row(c, age_h, "delegated-fresh"))
            else:
                nudgeable.append(_row(c, age_h, "delegated-stale"))
        else:
            # Unassigned. Only the orchestrator adopts/nudges these.
            if agent != orchestrator:
                continue
            if fresh_marker:
                parked.append(_row(c, age_h, "marker:" + marker))
            elif age_h >= WINDOW_DELEGATED_H:
                nudgeable.append(_row(c, age_h, "unassigned-stale"))
            else:
                parked.append(_row(c, age_h, "unassigned-fresh"))

    mine.sort(key=lambda r: -r["age_d"])
    nudgeable.sort(key=lambda r: -r["age_d"])
    idle_ok = not mine and not nudgeable
    return {
        "agent": agent,
        "idle_ok": idle_ok,
        "error": None,
        "counts": {"mine": len(mine), "nudgeable": len(nudgeable), "parked": len(parked)},
        "mine": mine,
        "nudgeable": nudgeable,
        "parked": parked,
    }


def _fail_safe(agent: str, reason: str) -> dict:
    """INV2: any error -> busy, never idle. Error != empty."""
    return {
        "agent": agent,
        "idle_ok": False,
        "error": reason,
        "counts": {"mine": 0, "nudgeable": 0, "parked": 0},
        "mine": [],
        "nudgeable": [],
        "parked": [],
    }


def _fetch_live_cards() -> list:
    import os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from lib.fleet_api import FleetApiClient  # noqa: E402

    client = FleetApiClient(token_file="/home/domin/marveen/store/.dashboard-token")
    cards = client.kanban_list()
    if not isinstance(cards, list):
        raise ValueError("kanban_list did not return a list")
    return cards


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True)
    ap.add_argument("--cards-file", help="JSON list of cards (offline/testing)")
    ap.add_argument("--now", type=float, default=None, help="epoch override (testing)")
    ap.add_argument("--json", action="store_true", help="emit JSON (default human)")
    args = ap.parse_args()

    now = args.now if args.now is not None else time.time()
    try:
        if args.cards_file:
            with open(args.cards_file) as fh:
                cards = json.load(fh)
        else:
            cards = _fetch_live_cards()
        result = classify(cards, args.agent, now)
    except Exception as exc:  # noqa: BLE001 -- fail-safe busy on ANY failure
        result = _fail_safe(args.agent, f"{type(exc).__name__}: {exc}")

    if args.json:
        print(json.dumps(result))
        return 0

    c = result["counts"]
    verdict = "IDLE-OK" if result["idle_ok"] else "BUSY"
    err = f"  (error -> fail-safe busy: {result['error']})" if result["error"] else ""
    print(f"[{result['agent']}] {verdict}{err}")
    print(f"  mine={c['mine']} nudgeable={c['nudgeable']} parked={c['parked']}")
    for label, rows in (("MINE", result["mine"]), ("NUDGEABLE", result["nudgeable"])):
        for r in rows:
            print(f'  {label:9} {r["age_d"]:5.1f}d {str(r["priority"]):7} {r["id"]} '
                  f'{r["assignee"]:10} {r["title"]}  [{r["bucket"]}]')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
