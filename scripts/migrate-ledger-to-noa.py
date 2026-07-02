#!/usr/bin/env python3
"""Backfill conversation_log rows from the legacy DB into the live noa.db.

Context (card 40002ca4): the noa.db cutover (NOA_DB_PATH) moved the server tables
but the ledger writer (ledger_lib) kept hard-coding store/claudeclaw.db, so the
conversation_log ledger stayed live on the legacy DB while noa.db's copy froze at
cutover time. Before flipping the hooks to noa.db (ledger_lib now resolves
NOA_DB_PATH) the post-cutover ledger rows must be copied over, or respawn
continuity would regress to a frozen transcript.

Idempotent: rows are deduplicated by a CONTENT tuple, not by the
UNIQUE(agent_id, chat_id, direction, message_id) index -- outbound rows have a
NULL message_id, so INSERT OR IGNORE would duplicate every reply on a re-run.

Usage:
  python3 scripts/migrate-ledger-to-noa.py                 # default src/tgt
  python3 scripts/migrate-ledger-to-noa.py --source A.db --target B.db
  python3 scripts/migrate-ledger-to-noa.py --dry-run       # report, no write
"""
import argparse
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks"))
import ledger_lib  # noqa: E402

# Rows present in source but not in target, matched on the content tuple.
_SELECT_MISSING = """
SELECT s.agent_id, s.chat_id, s.direction, s.message_id, s.text, s.ts, s.created_at
FROM main.conversation_log s
WHERE NOT EXISTS (
    SELECT 1 FROM tgt.conversation_log t
    WHERE t.agent_id = s.agent_id
      AND t.chat_id = s.chat_id
      AND t.direction = s.direction
      AND t.created_at = s.created_at
      AND IFNULL(t.text, '') = IFNULL(s.text, '')
      AND IFNULL(t.message_id, '') = IFNULL(s.message_id, '')
)
"""


def _ensure_schema(target_db):
    con = sqlite3.connect(target_db, timeout=10)
    try:
        con.execute(ledger_lib.SCHEMA)
        con.execute(ledger_lib.INDEX)
        con.commit()
    finally:
        con.close()


def count_missing(source_db, target_db):
    """How many source rows are absent from target (no write)."""
    _ensure_schema(target_db)
    con = sqlite3.connect(source_db, timeout=10)
    try:
        con.execute("PRAGMA busy_timeout=10000")
        con.execute("ATTACH DATABASE ? AS tgt", (target_db,))
        return con.execute(f"SELECT COUNT(*) FROM ({_SELECT_MISSING})").fetchone()[0]
    finally:
        con.close()


def migrate(source_db, target_db):
    """Copy missing conversation_log rows source -> target. Returns the number of
    rows inserted. Idempotent (re-run inserts 0)."""
    _ensure_schema(target_db)
    con = sqlite3.connect(source_db, timeout=10)
    try:
        con.execute("PRAGMA busy_timeout=10000")
        con.execute("ATTACH DATABASE ? AS tgt", (target_db,))
        cur = con.execute(
            "INSERT INTO tgt.conversation_log"
            " (agent_id, chat_id, direction, message_id, text, ts, created_at) "
            + _SELECT_MISSING
        )
        inserted = cur.rowcount
        con.commit()
        return inserted
    finally:
        con.close()


def _default_paths():
    install = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    source = os.path.join(install, "store", "claudeclaw.db")
    # Resolve the live target the same way the hooks/server do.
    target = ledger_lib._resolve_live_db(None, ledger_lib._noa_db_setting(install), install)
    if os.path.abspath(target) == os.path.abspath(source):
        # NOA_DB_PATH unset -> both resolve to the legacy default; force noa.db so
        # the migration still has a sensible target when run before the cutover.
        target = os.path.join(install, "store", "noa.db")
    return source, target


def main(argv=None):
    src_default, tgt_default = _default_paths()
    ap = argparse.ArgumentParser(description="Backfill conversation_log into noa.db")
    ap.add_argument("--source", default=src_default)
    ap.add_argument("--target", default=tgt_default)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if not os.path.exists(args.source):
        print(f"source not found: {args.source}", file=sys.stderr)
        return 1

    if args.dry_run:
        n = count_missing(args.source, args.target)
        print(f"[dry-run] {n} rows would be copied {args.source} -> {args.target}")
        return 0

    n = migrate(args.source, args.target)
    print(f"copied {n} rows {args.source} -> {args.target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
