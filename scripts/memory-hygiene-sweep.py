#!/usr/bin/env python3
"""
memory-hygiene-sweep.py -- fleet memory-hygiene detector (read-only, token-free).

Motivated by the 2026-10-05 Hibiki incident: a PROPOSED weekly training
structure ("megerősítés várva: 1 hyrox") was stored in warm memory and later
read back as CONFIRMED fact, re-seeding months of plans + referencing a
calendar event that never existed.

Defect class this flags (NOT a general linter -- precision over recall):
  1. STALE_PENDING: warm/hot memory with proposed/awaiting/pending language
     that is older than STALE_DAYS and has never been resolved. These are the
     landmines -- an agent reads the proposal as current truth.
  2. CONFLICT_CLUSTER: >=THRESHOLD warm/hot memories for one agent that all
     describe the same volatile topic (weekly structure / plan / roster).
     Coexisting conflicting versions = the agent can't tell which is current.

Deliberately EXCLUDED to keep false-alarm rate low:
  - shared/cold tiers: those are lessons/archive, not "current truth" reads.
    (The first audit pass drowned in shared-tier lessons that merely CONTAIN
     the word "pending"/"proposed" while describing a past incident.)
  - fresh pending (age <= STALE_DAYS): legitimately live awaiting items.

Read-only: opens noa.db in ro mode, never writes. Emits JSON to stdout and a
human summary to stderr. Exit 0 always (a detector, not a gate).

Usage:
    python3 scripts/memory-hygiene-sweep.py            # all agents
    python3 scripts/memory-hygiene-sweep.py --agent hibiki
    python3 scripts/memory-hygiene-sweep.py --stale-days 21 --json-only
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from db_resolve import resolve_default_db  # noqa: E402

DB = resolve_default_db()
STALE_DAYS_DEFAULT = 14
CLUSTER_THRESHOLD = 3

# Proposed/awaiting-as-fact markers (HU + EN). Anchored to operational pending
# language, not incidental occurrences inside a narrative lesson.
PENDING_RX = re.compile(
    r"(javasolva\b|javasolt struktúr|megerősítés(re)? vár|döntés vár|boss-?döntés vár"
    r"|boss-?input-?vár|válaszra vár|awaiting[-\s]?(dominik|boss|confirm)"
    r"|pending kalibrác|pending pairing|proposed\b|még nincs (dönt|megerősít)"
    r"|nem (dönt|erősít)ett|megerősítésre vár|generálandó\b|nem kézbesítve"
    r"|nem kezbesitve"
    # 2026-10-05 refinement (Hibiki #1542 slip): "future / not-yet-active /
    # wait-until-activation" is the SAME pending class -- if it never
    # activates for weeks it is an unresolved landmine, not a plan.
    r"|jövőbeli, nem aktív|nem aktív még|aktiválásig|aktiválásig várni"
    r"|aktiválás: boss|jovobeli.{0,6}nem aktiv)",
    re.I,
)

# Managed-queue acknowledgement marker (card 16bbd5b5). A warm/hot memory that is
# a DELIBERATELY long-lived, actively-managed surface (e.g. a Boss-facing revisit
# queue with documented weekly cadence + awaiting-dominik language) otherwise trips
# STALE_PENDING on every sweep -- a recurring false positive. An operator/agent can
# mark such a memory as acknowledged:
#   [HYGIENE-ACK]                -> permanent ack (intentionally long-lived)
#   [HYGIENE-ACK: 2026-11-10]    -> fresh-stamp ack; expires after --ack-ttl-days,
#                                   so it must be re-stamped on each revisit, which
#                                   keeps a TRULY forgotten item flagging again.
# A memory WITHOUT the marker is unchanged -- a genuine forgotten-pending still flags.
ACK_TTL_DAYS_DEFAULT = 30
MANAGED_ACK_RX = re.compile(r"\[HYGIENE-ACK(?::\s*(\d{4}-\d{2}-\d{2}))?\]", re.I)


def managed_ack_active(content, now, ack_ttl_days):
    """True if content carries an active managed-queue ack marker.

    Undated marker -> always active. Dated marker -> active only while its stamp is
    within ack_ttl_days of now (a stale stamp expires, so the item re-surfaces). A
    malformed date is treated as an undated (permanent) ack -- the marker's presence
    is an explicit management signal and should not resurrect the nag on a typo.
    """
    m = MANAGED_ACK_RX.search(content or "")
    if not m:
        return False
    date_str = m.group(1)
    if not date_str:
        return True
    try:
        stamp = time.mktime(time.strptime(date_str, "%Y-%m-%d"))
    except (ValueError, OverflowError):
        return True
    return (now - stamp) / 86400.0 <= ack_ttl_days


# Volatile-topic signal for conflict clustering.
TOPIC_RX = re.compile(
    r"(heti struktúr|cél-?struktúr|edzés.?terv|weekly plan|heti terv|roster"
    r"|W3\d\b|W4\d\b|struktúra JAVASOL)",
    re.I,
)


def age_days(ts, now):
    try:
        t = float(ts)
        if t > 1e11:  # stored as ms
            t /= 1000.0
        return (now - t) / 86400.0
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", default=None, help="limit to one agent_id")
    ap.add_argument("--stale-days", type=int, default=STALE_DAYS_DEFAULT)
    ap.add_argument("--ack-ttl-days", type=int, default=ACK_TTL_DAYS_DEFAULT,
                    help="a dated [HYGIENE-ACK: YYYY-MM-DD] marker expires after this many days")
    ap.add_argument("--db", default=DB)
    ap.add_argument("--json-only", action="store_true")
    args = ap.parse_args()

    now = time.time()
    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    c = db.cursor()

    q = "SELECT id, agent_id, category, content, created_at FROM memories WHERE category IN ('warm','hot')"
    params = ()
    if args.agent:
        q += " AND agent_id = ?"
        params = (args.agent,)
    rows = list(c.execute(q, params))

    stale_pending = []
    managed_acked = 0
    topic_by_agent = defaultdict(list)

    for mid, agent, cat, content, ts in rows:
        content = content or ""
        ad = age_days(ts, now)
        is_pending = bool(PENDING_RX.search(content))
        if is_pending and ad is not None and ad > args.stale_days:
            # Intentionally-managed, acknowledged queue -> not a forgotten-pending
            # FP (card 16bbd5b5). A genuine forgotten-pending carries no marker.
            if managed_ack_active(content, now, args.ack_ttl_days):
                managed_acked += 1
                continue
            stale_pending.append({
                "id": mid, "agent": agent, "category": cat,
                "age_days": round(ad, 1),
                "snippet": content[:120].replace("\n", " "),
            })
        # Cluster only tracks volatile-topic memories that are THEMSELVES
        # pending -- coexisting UNRESOLVED proposals are the hazard. Legit
        # research/active-fact memories on the same topic are not a conflict.
        if TOPIC_RX.search(content) and is_pending:
            topic_by_agent[agent].append({"id": mid, "category": cat,
                                          "age_days": round(ad, 1) if ad else None})

    conflict_clusters = [
        {"agent": a, "count": len(items), "ids": items}
        for a, items in topic_by_agent.items()
        if len(items) >= CLUSTER_THRESHOLD
    ]

    findings = {
        "sweep": "memory-hygiene-sweep",
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "stale_days_threshold": args.stale_days,
        "scanned_warm_hot": len(rows),
        "managed_acked_excluded": managed_acked,
        "stale_pending": sorted(stale_pending, key=lambda x: -x["age_days"]),
        "conflict_clusters": sorted(conflict_clusters, key=lambda x: -x["count"]),
        "ok": not stale_pending and not conflict_clusters,
    }
    print(json.dumps(findings, ensure_ascii=False, indent=2))

    if not args.json_only:
        sp, cc = findings["stale_pending"], findings["conflict_clusters"]
        print(f"\n[memory-hygiene] scanned {len(rows)} warm/hot | "
              f"stale-pending: {len(sp)} | conflict-clusters: {len(cc)}",
              file=sys.stderr)
        for f in sp:
            print(f"  STALE {f['age_days']:>5}d {f['agent']:12} "
                  f"[{f['category']}#{f['id']}] {f['snippet']}", file=sys.stderr)
        for f in cc:
            print(f"  CLUSTER {f['agent']:12} x{f['count']} "
                  f"(volatile topic -- consolidate to one current fact)",
                  file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
