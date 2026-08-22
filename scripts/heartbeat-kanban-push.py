#!/usr/bin/env python3
"""Heartbeat KANBAN-PUSH stale-sweep with FULL-description parked-marker guard.

Why this exists: at every heartbeat I kept hand-rolling an ad-hoc query that
either truncated the description (`desc[:N]`) or read title-only, then nudged
cards that carried a legitimate `do-not-nudge / awaiting-dominik / parked`
marker at the END of their description. This recurred 4x (07-19 x2, 07-28,
07-29). See memory heartbeat-stale-nudge-reads-desc-not-just-updatedat.

This helper classifies every open card as PARKED (has a marker anywhere in the
FULL description -> never nudge, only stale-clock reset) or NUDGEABLE. It does
NOT auto-send anything -- it prints the classification so the decision to nudge
a specific agent stays with the operator. Never truncate desc; grep the whole.

Usage: python3 scripts/heartbeat-kanban-push.py [stale_days=3]
"""
import sys, json, time, re, urllib.request

STALE_DAYS = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
OPEN = {"planned", "in_progress", "waiting"}
# Grep the WHOLE description for any parked/awaiting/blocked marker.
PARKED_RE = re.compile(
    r"awaiting|do-?not-?nudge|parked|Boss-?oldali|Boss-?GO|vak[aá]ci|nyaral[aá]s|"
    r"visszat[eé]r|OAuth-consent|unblock|TG\d|deploy-gated|awaiting-dominik",
    re.I,
)

def load_token():
    with open("/home/domin/marveen/store/.dashboard-token") as f:
        return f.read().strip()

def fetch_cards(tok):
    req = urllib.request.Request(
        "http://localhost:3420/api/kanban",
        headers={"Authorization": f"Bearer {tok}"},
    )
    data = json.loads(urllib.request.urlopen(req, timeout=10).read().decode())
    return data if isinstance(data, list) else data.get("cards", data.get("data", []))

def main():
    tok = load_token()
    cards = fetch_cards(tok)
    now = time.time()
    parked, nudgeable = [], []
    for c in cards:
        if c.get("status") not in OPEN:
            continue
        ua = c.get("updated_at") or c.get("created_at") or 0
        try:
            age = (now - float(ua)) / 86400.0
        except (TypeError, ValueError):
            age = 0.0
        if age < STALE_DAYS:
            continue
        # Grep title+description together: markers land in either field.
        desc = (c.get("title") or "") + "\n" + (c.get("description") or "")
        who = c.get("assignee") or c.get("owner") or ""
        row = {
            "age": round(age, 1), "status": c.get("status"),
            "priority": c.get("priority"), "id": (c.get("id") or "")[:8],
            "assignee": who, "title": (c.get("title") or "")[:55],
            "marker": bool(PARKED_RE.search(desc)),  # FULL desc, never truncated
        }
        (parked if row["marker"] else nudgeable).append(row)
    parked.sort(key=lambda r: -r["age"])
    nudgeable.sort(key=lambda r: -r["age"])
    print(f"== STALE >= {STALE_DAYS}d ==  parked(skip)={len(parked)}  nudgeable={len(nudgeable)}\n")
    print("-- NUDGEABLE (no parked-marker in full desc; delegated+stale -> consider poke) --")
    for r in nudgeable:
        print(f'  {r["age"]:5.1f}d {r["status"]:11} {str(r["priority"]):7} {r["id"]} {r["assignee"]:9} {r["title"]}')
    print("\n-- PARKED (marker found in full desc; NEVER nudge, clock-reset only) --")
    for r in parked:
        print(f'  {r["age"]:5.1f}d {r["status"]:11} {str(r["priority"]):7} {r["id"]} {r["assignee"]:9} {r["title"]}')

if __name__ == "__main__":
    main()
