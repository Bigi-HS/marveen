#!/usr/bin/env python3
"""vault-lint-apply-safe-tm: auto-apply TM-1 and TM-3 tier migrations (card bc638bd2, MEM-011).

Safe-only: only TM-1 (hot->warm, 7+ days stale) and TM-3 (warm->cold, 30+ days stale).
TM-2 (done-marker hot->cold) is SKIPPED -- 30% FP rate, manual-only.

Each applied migration is recorded in a `migration_log` SQLite table for auditability.

Usage:
    python3 scripts/vault-lint-apply-safe-tm.py           # dry-run (reports, no writes)
    python3 scripts/vault-lint-apply-safe-tm.py --apply   # apply migrations + audit log

Env overrides:
    TM1_HOT_STALE_DAYS   (default 7)  -- hot->warm threshold in days
    TM3_WARM_STALE_DAYS  (default 30) -- warm->cold threshold in days
"""

import os
import sqlite3
import sys
import time

# ---------------------------------------------------------------------------
# Config (env-overridable)
# ---------------------------------------------------------------------------
TM1_HOT_STALE_DAYS  = int(os.environ.get("TM1_HOT_STALE_DAYS", "7"))
TM3_WARM_STALE_DAYS = int(os.environ.get("TM3_WARM_STALE_DAYS", "30"))

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(HERE, ".."))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from db_resolve import resolve_default_db  # noqa: E402

DB_PATH = resolve_default_db(project_root=PROJECT_ROOT)

MIGRATION_LOG_DDL = """
CREATE TABLE IF NOT EXISTS migration_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at       INTEGER NOT NULL,
    memory_id    INTEGER NOT NULL,
    agent_id     TEXT    NOT NULL,
    from_tier    TEXT    NOT NULL,
    to_tier      TEXT    NOT NULL,
    rule         TEXT    NOT NULL,
    dry_run      INTEGER NOT NULL DEFAULT 0
)
"""


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

def effective_ts(row: dict) -> int | None:
    """Return accessed_at if set, else created_at. None if both are missing."""
    ts = row.get("accessed_at") or row.get("created_at")
    return int(ts) if ts is not None else None


def is_stale(row: dict, now: int, stale_days: int) -> bool:
    ts = effective_ts(row)
    if ts is None:
        return False
    return (now - ts) > stale_days * 86400


def compute_safe_migrations(memories: list, now: int,
                             tm1_days: int = TM1_HOT_STALE_DAYS,
                             tm3_days: int = TM3_WARM_STALE_DAYS) -> list:
    """Return list of (memory_id, agent_id, from_tier, to_tier, rule) tuples.

    TM-1: hot -> warm  when stale >= tm1_days
    TM-3: warm -> cold when stale >= tm3_days
    TM-2: SKIPPED (done-marker, 30% FP)
    """
    result = []
    for m in memories:
        cat = m.get("category", "")
        if cat == "hot" and is_stale(m, now, tm1_days):
            result.append((m["id"], m["agent_id"], "hot", "warm", "TM-1"))
        elif cat == "warm" and is_stale(m, now, tm3_days):
            result.append((m["id"], m["agent_id"], "warm", "cold", "TM-3"))
    return result


# ---------------------------------------------------------------------------
# DB operations
# ---------------------------------------------------------------------------

def load_memories(db_path: str) -> list:
    uri = f"file:{db_path}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, agent_id, category, created_at, accessed_at FROM memories"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


def apply_migrations(db_path: str, migrations: list, now: int, dry_run: bool) -> int:
    """Apply tier migrations and record each in migration_log. Returns applied count."""
    if not migrations:
        return 0
    con = sqlite3.connect(db_path)
    try:
        con.execute(MIGRATION_LOG_DDL)
        count = 0
        for (mem_id, agent_id, from_t, to_t, rule) in migrations:
            if not dry_run:
                con.execute(
                    "UPDATE memories SET category = ? WHERE id = ?",
                    (to_t, mem_id),
                )
            con.execute(
                "INSERT INTO migration_log (run_at, memory_id, agent_id, from_tier, to_tier, rule, dry_run) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (now, mem_id, agent_id, from_t, to_t, rule, 1 if dry_run else 0),
            )
            count += 1
        con.commit()
        return count
    finally:
        con.close()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> int:
    dry_run = "--apply" not in sys.argv
    now = int(time.time())
    memories = load_memories(DB_PATH)
    migrations = compute_safe_migrations(memories, now, TM1_HOT_STALE_DAYS, TM3_WARM_STALE_DAYS)

    mode = "DRY-RUN" if dry_run else "APPLY"
    print(f"vault-lint-apply-safe-tm [{mode}] db={DB_PATH}")
    print(f"  TM1 threshold: {TM1_HOT_STALE_DAYS}d (hot->warm)  "
          f"TM3 threshold: {TM3_WARM_STALE_DAYS}d (warm->cold)  TM2: SKIPPED")
    print(f"  memories scanned: {len(memories)}  migrations found: {len(migrations)}")

    if not migrations:
        print("  No migrations to apply.")
        return 0

    applied = apply_migrations(DB_PATH, migrations, now, dry_run)
    for (mem_id, agent_id, from_t, to_t, rule) in migrations:
        action = "would migrate" if dry_run else "migrated"
        print(f"  [{rule}] id={mem_id} agent={agent_id} {from_t} -> {to_t} ({action})")
    print(f"  Total {'would apply' if dry_run else 'applied'}: {applied}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
