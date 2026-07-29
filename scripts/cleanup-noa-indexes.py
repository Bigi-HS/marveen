#!/usr/bin/env python3
"""Drop 3 redundant indexes from token_usage on the live noa.db (spec A1 v5, AC-3).

The live DB accumulated duplicate/redundant indexes that add write overhead
without query benefit:
  - idx_token_usage_dedup     : exact duplicate of idx_token_dedup
  - idx_token_usage_agent_ts  : exact duplicate of idx_token_agent_ts
  - idx_token_usage_agent     : prefix subset of idx_token_agent_ts

DROP INDEX is safe in WAL mode (concurrent readers are not blocked) and is
reversible (the canonical indexes remain). The operation is idempotent:
DROP INDEX IF EXISTS makes a re-run a no-op.

SAFETY (Thor T1 finding, v5): the DB path is resolved relative to the PROJECT
ROOT, never the current working directory, and the file's existence is asserted
before connecting -- a wrong-CWD invocation cannot silently create and mutate a
different database. The path may be overridden with NOA_DB_PATH (used by tests).

Usage: python3 scripts/cleanup-noa-indexes.py
"""
import os
import sqlite3
import sys
from pathlib import Path

REDUNDANT_INDEXES = [
    "idx_token_usage_dedup",
    "idx_token_usage_agent_ts",
    "idx_token_usage_agent",
]


def resolve_db_path() -> Path:
    """store/noa.db under the project root, or NOA_DB_PATH if set. CWD-independent."""
    override = os.environ.get("NOA_DB_PATH")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "store" / "noa.db"


def main() -> int:
    db_path = resolve_db_path()
    if not db_path.exists():
        print(f"ERROR: noa.db not found at {db_path} -- aborting (no DB created)", file=sys.stderr)
        return 1

    db = sqlite3.connect(str(db_path))
    try:
        present = {
            r[0]
            for r in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND name IN (%s)"
                % ",".join("?" * len(REDUNDANT_INDEXES)),
                REDUNDANT_INDEXES,
            ).fetchall()
        }
        for idx in REDUNDANT_INDEXES:
            db.execute(f"DROP INDEX IF EXISTS {idx}")
        db.commit()
    finally:
        db.close()

    dropped = sorted(present)
    if dropped:
        print(f"Dropped {len(dropped)} redundant index(es): {', '.join(dropped)}")
    else:
        print("No redundant indexes present -- nothing to drop (idempotent no-op).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
