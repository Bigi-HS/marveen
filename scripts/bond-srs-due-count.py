#!/usr/bin/env python3
"""Print the number of Bond SRS vocab cards whose review is due now.

Readable replacement for a previously chr()-obfuscated one-liner embedded in the
bond-daily-science-news scheduled task (card 64099c33 batch-2 / bond Bo1).
Decoded and verified benign: reads bond.db, counts rows in `vocab` where
review_due_epoch <= now. No writes, no network, no secrets.
"""
import os
import sqlite3
import time

DB_PATH = os.environ.get("BOND_DB_PATH", "/home/domin/marveen/agents/bond/bond.db")


def due_count(now_epoch: int | None = None) -> int:
    now = int(time.time()) if now_epoch is None else now_epoch
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM vocab WHERE review_due_epoch <= ?", (now,)
        ).fetchone()
        return int(row[0]) if row else 0
    finally:
        conn.close()


if __name__ == "__main__":
    print(due_count())
