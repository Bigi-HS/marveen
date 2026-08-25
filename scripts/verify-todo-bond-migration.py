#!/usr/bin/env python3
"""Read-only pre-flight verifier for the todo_items owner-CHECK 'bond' widening
(card 2f7cd951).

The actual migration runs automatically in ensureSchema() at server startup
(migrateTodoOwnerBond in src/db.ts): a table rebuild that widens
CHECK(owner IN ('claudia','hibiki')) to include 'bond'. This script touches
NOTHING -- it opens the live DB read-only and reports what the migration WOULD
do, so its output can be attached to the gate and eyeballed before the
migration-triggering restart.

It reports:
  * whether todo_items exists,
  * whether the owner CHECK already admits 'bond' (-> migration is a no-op),
  * how many rows would be copied by the rebuild,
  * the current per-owner row distribution.

Exit code is always 0 on a successful read; it is a report, not a gate.
"""
import os
import re
import sqlite3
import sys

DEFAULT_DB = os.environ.get("VERIFY_TODO_DB", "store/noa.db")


def main() -> int:
    db_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB
    if not os.path.exists(db_path):
        print(f"[verify] DB not found: {db_path}", file=sys.stderr)
        return 2

    # Open strictly read-only via the URI mode so we cannot mutate the live DB.
    uri = f"file:{os.path.abspath(db_path)}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='todo_items'"
        ).fetchone()
        if row is None or not row[0]:
            print(f"[verify] todo_items does not exist in {db_path}")
            print("[verify] fresh install -> CREATE already carries 'bond', no migration needed")
            return 0

        create_sql = row[0]
        has_bond = bool(
            re.search(r"CHECK\s*\(\s*owner\s+IN\s*\([^)]*'bond'[^)]*\)\s*\)", create_sql, re.I)
        )
        total = conn.execute("SELECT COUNT(*) FROM todo_items").fetchone()[0]
        dist = conn.execute(
            "SELECT owner, COUNT(*) FROM todo_items GROUP BY owner ORDER BY owner"
        ).fetchall()

        print(f"[verify] DB: {db_path}")
        print(f"[verify] owner CHECK already admits 'bond': {'YES' if has_bond else 'NO'}")
        if has_bond:
            print("[verify] -> migration is a NO-OP (already widened)")
        else:
            print(f"[verify] -> rebuild WOULD copy {total} row(s) into the widened table")
        print(f"[verify] total todo_items rows: {total}")
        print("[verify] per-owner distribution:")
        for owner, count in dist:
            print(f"           {owner}: {count}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
