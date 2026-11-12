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
import os
import re
import sys
import time

OPEN = {"planned", "in_progress", "waiting"}
ORCHESTRATOR = "marveen"  # only the orchestrator tracks delegated/unassigned cards as nudgeable

# --- Planning-freeze awareness (card f4921a38, NoA option A) -----------------
# During a planning freeze the fleet is deliberately dormant except infra, the
# channel session, and keep-list agents. A non-keep agent must then go idle_ok
# EVEN with open MINE cards -- otherwise the autopilot tick keeps driving it,
# fighting the freeze. This is ORTHOGONAL to the PARKED staleness-kapu: the TG\d
# drop (Thor PR#882 FLAG-2) and sec3 marker-expiry are untouched.
#
# This mirrors the SAME contract as scripts/fleet-supervisor.sh (freeze_* gate)
# and src/web/planning-freeze.ts: flag = existence of store/planning-freeze.enabled,
# keep-list = store/planning-freeze-keep.txt (one id/line, '#'-comments + blanks
# dropped, first token taken, empty-after-filter -> DEFAULT_KEEP).
_STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "store")
FREEZE_FLAG_PATH = os.path.join(_STORE, "planning-freeze.enabled")
FREEZE_KEEP_PATH = os.path.join(_STORE, "planning-freeze-keep.txt")
DEFAULT_KEEP = ("claudia", "hibiki")


def parse_keep_list(contents):
    """Agent ids allowed to run during a freeze. Mirrors freeze_keep_ids()/parseKeepList():
    None/empty-after-filter -> DEFAULT_KEEP."""
    if contents is None:
        return set(DEFAULT_KEEP)
    ids = [
        line.strip().split()[0]
        for line in contents.split("\n")
        if line.strip() and not line.strip().startswith("#")
    ]
    return set(ids) if ids else set(DEFAULT_KEEP)


def is_frozen(enabled, keep_ids, agent):
    """Pure freeze predicate. Mirrors freezeBlocksWith(): frozen iff the flag is
    set AND the agent is not in the keep-list. disabled -> never frozen."""
    return bool(enabled) and agent not in keep_ids


def _read_freeze_state(agent, flag_path=FREEZE_FLAG_PATH, keep_path=FREEZE_KEEP_PATH):
    """Live freeze read for one agent. FAIL-SAFE DIRECTION: when uncertain, return
    False (NOT frozen) -- the dangerous direction for this classifier is a FALSE
    idle, so an unreadable flag/keep-file must leave the agent driving."""
    try:
        enabled = os.path.exists(flag_path)
    except OSError:
        return False
    if not enabled:
        return False
    try:
        contents = open(keep_path).read() if os.path.exists(keep_path) else None
    except OSError:
        # A genuinely UNREADABLE keep-file (permission/IO error) is distinct from
        # an ABSENT one. Absent -> contents=None -> DEFAULT_KEEP (deliberate: a
        # freeze with no keep-file runs only the default keep-list). But on a real
        # read error we cannot determine keep-membership, and resolving that
        # uncertainty toward DEFAULT_KEEP would FREEZE (idle) a non-keep agent on a
        # transient IO fault. FALSE idle is this classifier's dangerous direction,
        # so fail toward NOT frozen -- keep driving (Chad #964 fail-safe flag).
        return False
    return is_frozen(True, parse_keep_list(contents), agent)

# Staleness windows in HOURS -- a marker only parks a card while fresh (section 3).
WINDOW_AWAITING_H = 48.0  # FI-01
WINDOW_DELEGATED_H = 24.0  # FI-02
WINDOW_BLOCKED_H = 72.0  # BP-02
# Card 9fb626a2: the structured boss_waiting=1 DB flag parks a card (Boss owes the
# next move) regardless of age; the ORCHESTRATOR re-surfaces it only after this
# window so a forgotten Boss-decision cannot rot silently (NoA threshold, 7 days).
# Distinct from the text-marker expiry above: this flag is explicit and non-rotting.
WINDOW_BOSS_WAITING_H = 7 * 24.0


def _truthy(v) -> bool:
    """Interpret the boss_waiting column across the int/bool/str forms the API emits."""
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    return str(v).strip().lower() in ("1", "true", "yes")

# repro-blocked is an explicit LLM-judged blocker marker (BP-02).
BLOCKED_RE = re.compile(r"repro-?blocked|blocker:|blocked:", re.I)
# awaiting/parked: Boss owes the next move, or the card is deliberately held.
# Thor PR#882 FLAG-2: a bare TG-reference (e.g. "TG9452 alapjan kesz") must NOT
# park a card -- a historical TG mention in a done-note was false-matching -> false
# PARKED -> false idle (the dangerous direction). Only explicit awaiting phrasing parks.
# NOTE: TG\d is intentionally ABSENT here (see heartbeat-kanban-push.py PARKED_RE comment).
# Card 41e31d7e: synced with heartbeat-kanban-push.py expansion (card 7125b579) --
# added boss.?block, boss.?lepes, boss.?decision, vakacio.?utan, external.trigger,
# repro.?block, credential, boss_waiting to prevent driving Boss-blocked/external-trigger
# cards that kanban-push correctly skips.
AWAITING_RE = re.compile(
    r"awaiting-?dominik|awaiting|do-?not-?nudge|parked|boss-?oldali|boss-?go|"
    r"boss.?block|boss.?lepes|boss.?decision|boss_waiting|"
    r"vak[aa]ci|vakacio.?utan|nyaral|visszat[ee]r|oauth-consent|deploy-gated|"
    r"external.trigger|repro.?block|credential",
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


def classify(cards, agent: str, now: float, orchestrator: str = ORCHESTRATOR,
             frozen: bool = False) -> dict:
    """Pure classification. Returns buckets + idle_ok for `agent`.

    MINE       = open cards this agent owns and must drive now (not fresh-parked).
    NUDGEABLE  = stale cards this agent is responsible for poking (orchestrator only).
    PARKED     = legitimately held RIGHT NOW (fresh marker / fresh delegation).
    idle_ok    = MINE empty AND NUDGEABLE empty.
    frozen     = planning-freeze active for this agent -> idle_ok True, no driving
                 (card f4921a38). Short-circuits ahead of the card buckets.
    """
    if frozen:
        # Freeze dominates the card buckets: a non-keep agent must not be driven
        # while the fleet is frozen. Buckets stay empty so the tick injects no work.
        return {
            "agent": agent,
            "idle_ok": True,
            "error": None,
            "frozen": True,
            "counts": {"mine": 0, "nudgeable": 0, "parked": 0},
            "mine": [],
            "nudgeable": [],
            "parked": [],
        }
    mine, nudgeable, parked = [], [], []
    for c in cards:
        if c.get("status") not in OPEN:
            continue
        owner = c.get("assignee") or c.get("owner") or ""
        age_h = _age_hours(c, now)

        if _truthy(c.get("boss_waiting")):
            # Structured override (card 9fb626a2): the Boss owes the next move, so the
            # OWNER never drives it (never MINE) -- unlike the text awaiting-marker, this
            # flag does not expire into actionable. Only the orchestrator re-surfaces it,
            # and only once it has waited past WINDOW_BOSS_WAITING_H, as an aging-flag for
            # the morning brief. A non-orchestrator still ignores cards it does not own.
            if owner != agent and agent != orchestrator:
                continue
            if agent == orchestrator and age_h >= WINDOW_BOSS_WAITING_H:
                nudgeable.append(_row(c, age_h, "boss-waiting-stale"))
            else:
                parked.append(_row(c, age_h, "boss-waiting"))
            continue

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
        "frozen": False,
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
        "frozen": False,
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
    ap.add_argument("--frozen", action="store_true",
                    help="force planning-freeze idle (offline/testing override)")
    ap.add_argument("--json", action="store_true", help="emit JSON (default human)")
    args = ap.parse_args()

    now = args.now if args.now is not None else time.time()
    # Freeze read is live-only: offline fixture runs (--cards-file) stay deterministic
    # and opt into freeze solely via --frozen.
    if args.frozen:
        frozen = True
    elif args.cards_file:
        frozen = False
    else:
        frozen = _read_freeze_state(args.agent)
    try:
        if frozen:
            # No card fetch needed -- a frozen agent is idle regardless of the board.
            result = classify([], args.agent, now, frozen=True)
        elif args.cards_file:
            with open(args.cards_file) as fh:
                cards = json.load(fh)
            result = classify(cards, args.agent, now)
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
    frz = "  (planning-freeze -> frozen idle)" if result.get("frozen") else ""
    print(f"[{result['agent']}] {verdict}{err}{frz}")
    print(f"  mine={c['mine']} nudgeable={c['nudgeable']} parked={c['parked']}")
    for label, rows in (("MINE", result["mine"]), ("NUDGEABLE", result["nudgeable"])):
        for r in rows:
            print(f'  {label:9} {r["age_d"]:5.1f}d {str(r["priority"]):7} {r["id"]} '
                  f'{r["assignee"]:10} {r["title"]}  [{r["bucket"]}]')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
