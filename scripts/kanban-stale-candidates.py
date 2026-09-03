#!/usr/bin/env python3
"""Heartbeat kanban-push helper: list genuinely nudgeable STALE cards.

Root-cause fix for a recurring failure (fell into it 4x): hand-writing the
kanban SELECT without `description` and then nudging cards that carry an
explicit do-not-nudge / parked / Boss-blocked marker. This script does the
description-aware, marker-filtered query ONCE so no heartbeat has to re-derive
it. Call this instead of ad-hoc `node -e "SELECT ..."`.

Usage:
    python3 scripts/kanban-stale-candidates.py [--self marveen] [--stale-days 3]

Output sections:
    NUDGE   -> genuinely stale, delegated to another agent, no parked marker.
    PARKED  -> open but carries a do-not-nudge/Boss-blocked marker (SKIP).
    MINE    -> assigned to --self (advance yourself, do not nudge).
    FRESH   -> below the stale threshold (informational, hidden unless --all).

Read-only. Writes go through the API, never here.
"""
import argparse
import os
import sqlite3
import sys
import time

DB = os.path.join(os.path.dirname(__file__), "..", "store", "noa.db")

# Markers in a card body/title that mean "this long stall is EXPECTED, do not
# nudge". Kept in sync with kanban-push-subtract-downtime-window memory.
MARKERS = [
    "do-not-nudge", "do not nudge", "awaiting-dominik", "awaiting dominik",
    "parkolva", "parked", "icebox", "blocked", "blocker", "blocked-until",
    "boss-go", "boss go", "bond-build", "consent", "external-trigger",
    "external trigger", "repro-blocked", "repro blocked",
    # deferred-until-return: vacation / training-camp windows park a card just
    # as hard as an explicit marker (Buccaneers, on-return training tracks).
    "vakacio utan", "vakáció után", "nyaralas utan", "nyaralás után",
    "visszateres", "visszatérés", "after vacation", "on return", "credential",
    "boss-lepes", "boss-lépés", "boss-step", "boss lepes",
    "defer until", "defer to after", "physical archive", "until the archive",
    "until archive", "not stale",
    # design-first meeting cards: build only after Boss priority-confirm at the
    # camp-end review (de418a10). "Boss priority-confirm ... build" gates them
    # just as hard as boss-go; without this they false-nudge the delegate to
    # build UI before the design pattern is approved.
    "priority-confirm", "priority confirm",
]
# Only the three ACTIVE lanes are triaged. 'icebox' (the parked lane, noa-kanban
# card 65afc67e -- ex 'someday') and 'done' are intentionally excluded: an icebox
# card is a deliberate park, so it must never surface as a nudge candidate. The
# clean way to silence a consciously-parked card is to MOVE it to icebox
# (POST /api/kanban/{id}/move {status:icebox}); the MARKERS filter below is the
# fallback for cards that must stay in an active lane but are blocked-until-X.
OPEN = ("planned", "in_progress", "waiting")


def marker_hit(text):
    t = (text or "").lower()
    for m in MARKERS:
        if m in t:
            return m
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self", dest="self_id", default="marveen")
    ap.add_argument("--stale-days", type=float, default=3.0)
    ap.add_argument("--all", action="store_true", help="also print FRESH cards")
    args = ap.parse_args()

    now = int(time.time())
    con = sqlite3.connect(f"file:{os.path.abspath(DB)}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    # archived_at IS NULL: an archived card whose status was never flipped off an
    # OPEN lane (e.g. archived dup left at 'planned') would otherwise false-nudge
    # its assignee forever (OPS-160/8e580def, 2026-09-03). Archived == closed.
    rows = con.execute(
        "SELECT id,title,status,priority,assignee,updated_at,description "
        "FROM kanban_cards WHERE status IN (?,?,?) AND archived_at IS NULL "
        "ORDER BY updated_at ASC",
        OPEN,
    ).fetchall()

    nudge, parked, mine, fresh = [], [], [], []
    for r in rows:
        age = (now - (r["updated_at"] or now)) / 86400.0
        line = f"{age:5.1f}d [{r['status']}/{r['priority']}] {r['assignee'] or '?'} {r['id'][:8]} {(r['title'] or '')[:58]}"
        # Waiting on Boss is itself a hard exclude regardless of marker text.
        boss_waiting = r["status"] == "waiting" and (r["assignee"] or "").lower() in ("genesis", "dominik", "boss")
        hit = marker_hit((r["title"] or "") + " " + (r["description"] or ""))
        if (r["assignee"] or "") == args.self_id:
            mine.append(line)
        elif age < args.stale_days:
            fresh.append(line)
        elif hit or boss_waiting:
            parked.append(f"{line}   <-- {'boss-waiting' if boss_waiting else hit}")
        else:
            nudge.append(line)

    def dump(name, items):
        print(f"\n== {name} ({len(items)}) ==")
        for i in items:
            print(i)

    dump("NUDGE (stale, delegated, no parked marker)", nudge)
    dump("PARKED (skip -- marker/boss-waiting)", parked)
    dump("MINE (advance self)", mine)
    if args.all:
        dump("FRESH", fresh)
    print(f"\nnudge={len(nudge)} parked={len(parked)} mine={len(mine)} fresh={len(fresh)}", file=sys.stderr)


if __name__ == "__main__":
    main()
