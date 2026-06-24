#!/usr/bin/env python3
"""Parity check between claudeclaw.db (old) and noa.db (new) -- AC-10.

Read-only on BOTH databases. Prints PASS/FAIL per check and exits non-zero if
any check fails, so cutover can be gated on a green parity run.

Checks:
  * Row-count match for each migrated table (AC-3b).
  * 50 random `memories`: content identical after column mapping.
  * 50 random `kanban_cards`: title, status, priority identical.
  * 50 random `agent_messages`: from_agent, to_agent, content identical;
    priority TEXT->INT mapping correct.
  * 20 random `scheduled_tasks`: prompt, schedule identical.

Usage: python3 scripts/parity-check.py [--old store/claudeclaw.db] [--new store/noa.db]
"""
import argparse
import os
import random
import sqlite3
import sys

PRIORITY_MAP = {"urgent": 100, "high": 75, "normal": 50, "low": 25}
DEFAULT_PRIORITY = 50

results = []


def record(name, ok, detail=""):
    results.append(ok)
    status = "PASS" if ok else "FAIL"
    print(f"  {status}  {name}" + (f" -- {detail}" if detail else ""))


def ro(path):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = ON")
    return conn


def migrated_tables(old, new):
    def base(conn):
        return {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            if not r[0].startswith("memories_fts") and r[0] != "sqlite_sequence"
        }

    return sorted(base(old) & base(new))


def sample_ids(conn, table, key, n):
    ids = [r[0] for r in conn.execute(f"SELECT {key} FROM {table}")]
    random.shuffle(ids)
    return ids[:n]


def map_priority(value):
    if value is None:
        return DEFAULT_PRIORITY
    if isinstance(value, int):
        return value
    return PRIORITY_MAP.get(str(value).strip().lower(), DEFAULT_PRIORITY)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", default="store/claudeclaw.db")
    ap.add_argument("--new", default="store/noa.db")
    args = ap.parse_args()

    for p in (args.old, args.new):
        if not os.path.exists(p):
            print(f"ERROR: DB not found: {p}", file=sys.stderr)
            sys.exit(2)

    old = ro(args.old)
    new = ro(args.new)

    print("Row-count parity:")
    for t in migrated_tables(old, new):
        oc = old.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        nc = new.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        record(f"rowcount {t}", oc == nc, f"{oc} vs {nc}")

    # memories content spot-check
    print("Spot-check memories.content:")
    ocols = [r[1] for r in old.execute("PRAGMA table_info('memories')")]
    ok_all = True
    for mid in sample_ids(old, "memories", "id", 50):
        orow = dict(zip(ocols, old.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()))
        nrow = new.execute("SELECT content FROM memories WHERE id=?", (mid,)).fetchone()
        if nrow is None or (orow.get("content") if orow.get("content") is not None else "") != nrow[0]:
            ok_all = False
            break
    record("memories content identical (<=50 sampled)", ok_all)

    # kanban_cards spot-check
    print("Spot-check kanban_cards:")
    ok_all = True
    for cid in sample_ids(old, "kanban_cards", "id", 50):
        o = old.execute("SELECT title, status, priority FROM kanban_cards WHERE id=?", (cid,)).fetchone()
        n = new.execute("SELECT title, status, priority FROM kanban_cards WHERE id=?", (cid,)).fetchone()
        if o != n:
            ok_all = False
            break
    record("kanban_cards title/status/priority identical (<=50 sampled)", ok_all)

    # agent_messages spot-check incl priority mapping
    print("Spot-check agent_messages:")
    ok_all = True
    for mid in sample_ids(old, "agent_messages", "id", 50):
        o = old.execute("SELECT from_agent, to_agent, content, priority FROM agent_messages WHERE id=?", (mid,)).fetchone()
        n = new.execute("SELECT from_agent, to_agent, content, priority FROM agent_messages WHERE id=?", (mid,)).fetchone()
        if n is None or o[0] != n[0] or o[1] != n[1] or o[2] != n[2] or map_priority(o[3]) != n[3]:
            ok_all = False
            break
    record("agent_messages fields + priority mapping correct (<=50 sampled)", ok_all)

    # scheduled_tasks spot-check
    print("Spot-check scheduled_tasks:")
    ok_all = True
    for tid in sample_ids(old, "scheduled_tasks", "id", 20):
        o = old.execute("SELECT prompt, schedule FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()
        n = new.execute("SELECT prompt, schedule FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()
        if o != n:
            ok_all = False
            break
    record("scheduled_tasks prompt/schedule identical (<=20 sampled)", ok_all)

    old.close()
    new.close()

    failed = results.count(False)
    total = len(results)
    print(f"\n{total - failed}/{total} checks PASS")
    if failed:
        print(f"{failed} FAIL -- cutover blocked")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
