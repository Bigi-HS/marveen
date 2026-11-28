#!/usr/bin/env python3
"""Reconcile agent_messages.completed_at for delivered+result rows (card c077ac25).

W3 audit (Scout, store/audit-automation-ceee33af-1127.md) found 1488 delivered
messages where result IS NOT NULL but completed_at IS NULL. The write-back never
ran because completed_at was not set at result-recording time (structural gap).

Fix: for every row where result IS NOT NULL AND completed_at IS NULL, backfill
completed_at = delivered_at (or created_at when delivered_at is also NULL).

Idempotent: a second run is a no-op (WHERE clause selects 0 rows).

Usage:
    python3 scripts/reconcile-agent-messages-completed-at.py           # live run
    python3 scripts/reconcile-agent-messages-completed-at.py --dry-run # report only
    python3 scripts/reconcile-agent-messages-completed-at.py --db path/to/noa.db
"""
import argparse
import os
import sqlite3
import sys
from pathlib import Path

HERE = Path(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = HERE.parent / "store" / "noa.db"


def _candidate_count(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT COUNT(*) FROM agent_messages WHERE result IS NOT NULL AND completed_at IS NULL"
    ).fetchone()
    return row[0]


def reconcile(db_path: Path, dry_run: bool = False) -> int:
    """Backfill completed_at for rows with a result but no completion timestamp.

    Returns the number of rows updated (or that would be updated in dry_run mode).
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        count = _candidate_count(conn)
        if dry_run:
            print(f"[dry-run] {count} rows would be updated")
            return count

        if count == 0:
            print("No rows to reconcile -- already clean")
            return 0

        # Use COALESCE(delivered_at, created_at) as the best available proxy for
        # the actual completion time. delivered_at is the moment the target agent
        # received the message; created_at is the outer bound.
        conn.execute(
            """UPDATE agent_messages
               SET completed_at = COALESCE(delivered_at, created_at)
               WHERE result IS NOT NULL AND completed_at IS NULL"""
        )
        conn.commit()
        print(f"Updated {count} rows: completed_at <- COALESCE(delivered_at, created_at)")
        return count
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Path to noa.db (default: store/noa.db)")
    parser.add_argument("--dry-run", action="store_true", help="Report count without updating")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.is_file():
        print(f"ERROR: DB not found: {db_path}", file=sys.stderr)
        return 1

    reconcile(db_path, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
