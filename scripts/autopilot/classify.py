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

from parked import parked_until_active

OPEN = {"planned", "in_progress", "waiting"}
# Card 9b7f7221 (option A): only these statuses are autonomously DRIVABLE in an
# owner's MINE lane. `waiting` is deliberately EXCLUDED: the autonomous status
# ladder is planned->in_progress->waiting (tick.py SAFE list), so once a card
# reaches `waiting` its only next move is kanban->done, which is ask-first and
# FORBIDDEN for the autopilot. An owner-owned `waiting` card that never got
# boss_waiting=1 therefore has NO autonomous next step -- surfacing it as
# MINE-drivable churns it forever in the lane (tick-count rises, the card never
# closes). Such cards are PARKED ("waiting-unclosable") instead so they stop
# forcing a false TICK_DRIVE; the Boss/owner closes them out-of-band.
DRIVABLE = {"planned", "in_progress"}
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
# Card f8a97803: a nudge is an inter-agent MESSAGE -- it does NOT move the card, so
# `last_moved` is unchanged and a freshly-nudged delegated/unassigned-stale card
# re-enters NUDGEABLE on the very next 15-min tick -> idle_ok stays False forever ->
# TICK_DRIVE every heartbeat with zero productive action (we already nudged). The
# nudge-cooldown ledger (store/autopilot-nudge-ledger.json: {card_id: last_nudge_epoch})
# keyed on the LAST NUDGE (not card age) parks such a card for this window after the
# last nudge, then re-surfaces it so a genuinely-ignored card cannot hide forever.
WINDOW_NUDGE_COOLDOWN_H = 24.0

# Durable nudge ledger path. The ORCHESTRATOR records a nudge here (record_nudge)
# right after poking a card; classify() reads it to suppress re-nudging within the
# cooldown. FAIL-SAFE DIRECTION: a missing/corrupt/unreadable ledger -> empty dict
# -> every card reads as never-nudged -> it stays NUDGEABLE (the BUSY/dangerous-safe
# side). We never cool a card we have no proof we nudged.
NUDGE_LEDGER_PATH = os.path.join(_STORE, "autopilot-nudge-ledger.json")
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


def load_nudge_ledger(path: str = NUDGE_LEDGER_PATH) -> dict:
    """Load {card_id: last_nudge_epoch}. FAIL-SAFE: any problem -> {} (never-nudged
    = BUSY side). A card we cannot prove we nudged must stay nudgeable."""
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for k, v in data.items():
        try:
            out[str(k)] = float(v)
        except (TypeError, ValueError):
            continue  # skip a corrupt entry; a bad row must not cool a card
    return out


def record_nudge(card_id: str, now: float, path: str = NUDGE_LEDGER_PATH) -> None:
    """Append-only write: stamp `card_id` with `now` (epoch). The orchestrator calls
    this right after sending a nudge. A corrupt existing ledger is replaced (we would
    rather lose stale cooldown stamps -> re-nudge -> BUSY side -- than block a nudge)."""
    ledger = load_nudge_ledger(path)
    ledger[str(card_id)] = float(now)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(ledger, fh)
    os.replace(tmp, path)


def _nudge_cooled(card_id: str, now: float, ledger: dict) -> bool:
    """True iff `card_id` was nudged < WINDOW_NUDGE_COOLDOWN_H ago. Keyed on the LAST
    NUDGE, not card age, so a genuinely-ignored card re-surfaces after the window.
    Missing entry -> never-nudged -> False (not cooled -> stays nudgeable, BUSY side)."""
    last = ledger.get(str(card_id))
    if last is None:
        return False
    try:
        return (now - float(last)) < WINDOW_NUDGE_COOLDOWN_H * 3600.0
    except (TypeError, ValueError):
        return False


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
             frozen: bool = False, nudge_ledger: dict | None = None) -> dict:
    """Pure classification. Returns buckets + idle_ok for `agent`.

    MINE       = open cards this agent owns and must drive now (not fresh-parked).
    NUDGEABLE  = stale cards this agent is responsible for poking (orchestrator only),
                 EXCLUDING any nudged within the 24h cooldown (card f8a97803).
    SURFACE    = boss-waiting-stale cards -> morning-brief surface-to-Boss, NOT an
                 owner-poke; does NOT force idle_ok False (card f8a97803, part 3).
    PARKED     = legitimately held RIGHT NOW (fresh marker / fresh delegation / cooled).
    idle_ok    = MINE empty AND NUDGEABLE empty. (SURFACE does not block idle.)
    frozen     = planning-freeze active for this agent -> idle_ok True, no driving
                 (card f4921a38). Short-circuits ahead of the card buckets.
    nudge_ledger = {card_id: last_nudge_epoch}; None -> {} (fail-safe: never-nudged).
    """
    if nudge_ledger is None:
        nudge_ledger = {}
    if frozen:
        # Freeze dominates the card buckets: a non-keep agent must not be driven
        # while the fleet is frozen. Buckets stay empty so the tick injects no work.
        return {
            "agent": agent,
            "idle_ok": True,
            "error": None,
            "frozen": True,
            "counts": {"mine": 0, "nudgeable": 0, "parked": 0, "surface": 0},
            "mine": [],
            "nudgeable": [],
            "parked": [],
            "surface": [],
        }
    mine, nudgeable, parked, surface = [], [], [], []
    for c in cards:
        if c.get("status") not in OPEN:
            continue
        owner = c.get("assignee") or c.get("owner") or ""
        age_h = _age_hours(c, now)

        if parked_until_active(c, now):
            # Structured park (card da838ff2): an explicit parked_until in the
            # future suppresses driving on EVERY surface (MINE, NUDGEABLE,
            # stale-count), regardless of status / age / free-text marker. Unlike
            # the text marker it does not expire by an age-window, and unlike
            # boss_waiting it never re-surfaces to the orchestrator -- it is a hard
            # time-commitment until `now` passes parked_until, at which point the
            # card falls through to normal classification for re-triage. Scoped to
            # owner/orchestrator like the other buckets so a non-owner ignores it.
            if owner != agent and agent != orchestrator:
                continue
            parked.append(_row(c, age_h, "parked-until"))
            continue

        if _truthy(c.get("boss_waiting")):
            # Structured override (card 9fb626a2): the Boss owes the next move, so the
            # OWNER never drives it (never MINE) -- unlike the text awaiting-marker, this
            # flag does not expire into actionable. Only the orchestrator re-surfaces it,
            # and only once it has waited past WINDOW_BOSS_WAITING_H, as an aging-flag for
            # the morning brief. A non-orchestrator still ignores cards it does not own.
            if owner != agent and agent != orchestrator:
                continue
            if agent == orchestrator and age_h >= WINDOW_BOSS_WAITING_H:
                # Card f8a97803 (part 3): a stale boss_waiting card waits on the BOSS,
                # not on an owner-nudge. It belongs on the morning-brief surface-to-Boss
                # channel, NOT the 15-min owner-poke list -- so it goes to `surface`,
                # which does NOT force idle_ok False. (Pre-fix it sat in NUDGEABLE and
                # drove a TICK_DRIVE every heartbeat with no legitimate owner action.)
                surface.append(_row(c, age_h, "boss-waiting-stale"))
            else:
                parked.append(_row(c, age_h, "boss-waiting"))
            continue

        text = (c.get("title") or "") + "\n" + (c.get("description") or "")
        marker, window = _marker(text)
        fresh_marker = marker is not None and age_h < window

        if owner == agent:
            if fresh_marker:
                parked.append(_row(c, age_h, "marker:" + marker))
            elif c.get("status") not in DRIVABLE:
                # Card 9b7f7221 (option A): a `waiting` owner-card has no autonomous
                # next step (the ladder tops out at `waiting`; done is ask-first). It
                # reached here only because it is NOT parked_until / boss_waiting /
                # fresh-marker -- i.e. work is complete-or-Boss-GO-pending but the
                # close flag was never set. Park it so it stops churning the lane as
                # false MINE-drivable, rather than re-surfacing every tick.
                parked.append(_row(c, age_h, "waiting-unclosable"))
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
            elif _nudge_cooled(c.get("id") or "", now, nudge_ledger):
                # Card f8a97803: nudged < 24h ago -> park (don't re-nudge). Keyed on
                # the last nudge, not card age, so it re-surfaces after the cooldown.
                parked.append(_row(c, age_h, "nudge-cooldown"))
            else:
                nudgeable.append(_row(c, age_h, "delegated-stale"))
        else:
            # Unassigned. Only the orchestrator adopts/nudges these.
            if agent != orchestrator:
                continue
            if fresh_marker:
                parked.append(_row(c, age_h, "marker:" + marker))
            elif age_h < WINDOW_DELEGATED_H:
                parked.append(_row(c, age_h, "unassigned-fresh"))
            elif _nudge_cooled(c.get("id") or "", now, nudge_ledger):
                # Card f8a97803: freshly-nudged unassigned-stale card -> park (cooldown).
                parked.append(_row(c, age_h, "nudge-cooldown"))
            else:
                nudgeable.append(_row(c, age_h, "unassigned-stale"))

    mine.sort(key=lambda r: -r["age_d"])
    nudgeable.sort(key=lambda r: -r["age_d"])
    surface.sort(key=lambda r: -r["age_d"])
    # idle_ok ignores SURFACE (boss-waiting-stale = surface-to-Boss, not an owner
    # action) -> a board whose only non-idle items are boss-waiting-stale or cooled
    # nudges rests QUIET instead of emitting a no-op TICK_DRIVE (card f8a97803).
    idle_ok = not mine and not nudgeable
    return {
        "agent": agent,
        "idle_ok": idle_ok,
        "error": None,
        "frozen": False,
        "counts": {"mine": len(mine), "nudgeable": len(nudgeable),
                   "parked": len(parked), "surface": len(surface)},
        "mine": mine,
        "nudgeable": nudgeable,
        "parked": parked,
        "surface": surface,
    }


def _fail_safe(agent: str, reason: str) -> dict:
    """INV2: any error -> busy, never idle. Error != empty."""
    return {
        "agent": agent,
        "idle_ok": False,
        "error": reason,
        "frozen": False,
        "counts": {"mine": 0, "nudgeable": 0, "parked": 0, "surface": 0},
        "mine": [],
        "nudgeable": [],
        "parked": [],
        "surface": [],
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
    ap.add_argument("--nudge-ledger", default=None,
                    help="path to the nudge-cooldown ledger JSON (testing override)")
    ap.add_argument("--record-nudge", metavar="CARD_ID", default=None,
                    help="stamp CARD_ID as nudged NOW in the ledger and exit "
                         "(call right after sending a nudge; card f8a97803)")
    ap.add_argument("--json", action="store_true", help="emit JSON (default human)")
    args = ap.parse_args()

    now = args.now if args.now is not None else time.time()
    ledger_path = args.nudge_ledger or NUDGE_LEDGER_PATH

    # Orchestrator hook: record a nudge and exit (no classification). Keeps the
    # cooldown ledger as a single-source helper rather than a second script.
    if args.record_nudge:
        record_nudge(args.record_nudge, now, ledger_path)
        if args.json:
            print(json.dumps({"recorded": args.record_nudge, "at": now}))
        else:
            print(f"recorded nudge {args.record_nudge} @ {int(now)} -> {ledger_path}")
        return 0
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
            # Fixture runs opt into a ledger only via explicit --nudge-ledger; absent
            # -> {} (never-nudged) so fixtures stay deterministic.
            ledger = load_nudge_ledger(args.nudge_ledger) if args.nudge_ledger else {}
            result = classify(cards, args.agent, now, nudge_ledger=ledger)
        else:
            cards = _fetch_live_cards()
            result = classify(cards, args.agent, now,
                              nudge_ledger=load_nudge_ledger(ledger_path))
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
    print(f"  mine={c['mine']} nudgeable={c['nudgeable']} "
          f"surface={c.get('surface', 0)} parked={c['parked']}")
    for label, rows in (("MINE", result["mine"]), ("NUDGEABLE", result["nudgeable"]),
                        ("SURFACE", result.get("surface", []))):
        for r in rows:
            print(f'  {label:9} {r["age_d"]:5.1f}d {str(r["priority"]):7} {r["id"]} '
                  f'{r["assignee"]:10} {r["title"]}  [{r["bucket"]}]')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
