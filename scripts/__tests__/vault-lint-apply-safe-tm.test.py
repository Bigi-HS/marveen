#!/usr/bin/env python3
"""Tests for scripts/vault-lint-apply-safe-tm.py (card bc638bd2, MEM-011).

3 fixtures per spec:
  1. TM-1: hot memory 8 days stale -> migrated to warm
  2. TM-3: warm memory 35 days stale -> migrated to cold
  3. Safety: hot memory 5 days stale -> NOT migrated (below TM-1 threshold)
  4. TM-2 skip: hot memory with done-marker, 8 days stale -> migrated by TM-1
               (TM-2 is deliberately excluded; hot+stale hits TM-1 regardless)
  5. Audit: migration_log row created for each applied migration
  6. Dry-run: dry_run=True -> no category change, log row marked dry_run=1

Run: python3 scripts/__tests__/vault-lint-apply-safe-tm.test.py
"""

import importlib.util
import os
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.normpath(os.path.join(HERE, "..", "vault-lint-apply-safe-tm.py"))

spec_obj = importlib.util.spec_from_file_location("vault_lint_apply_safe_tm", MODULE_PATH)
mod = importlib.util.module_from_spec(spec_obj)
spec_obj.loader.exec_module(mod)

NOW = 1_800_000_000  # fixed wall-clock for deterministic tests

MEMORIES_DDL = """
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL DEFAULT 'test',
    category TEXT NOT NULL DEFAULT 'hot',
    content TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    accessed_at INTEGER
)
"""

MIGRATION_LOG_DDL = """
CREATE TABLE IF NOT EXISTS migration_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at    INTEGER NOT NULL,
    memory_id INTEGER NOT NULL,
    agent_id  TEXT    NOT NULL,
    from_tier TEXT    NOT NULL,
    to_tier   TEXT    NOT NULL,
    rule      TEXT    NOT NULL,
    dry_run   INTEGER NOT NULL DEFAULT 0
)
"""


def make_db(rows):
    """Create an in-memory SQLite with the memories table and given rows. Return path."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    path = tmp.name
    tmp.close()
    con = sqlite3.connect(path)
    con.execute(MEMORIES_DDL)
    con.execute(MIGRATION_LOG_DDL)
    for r in rows:
        con.execute(
            "INSERT INTO memories (agent_id, category, content, created_at, accessed_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (r["agent_id"], r["category"], r.get("content", ""), r["created_at"], r.get("accessed_at")),
        )
    con.commit()
    con.close()
    return path


def days_ago(n):
    return NOW - n * 86400


class TestComputeSafeMigrations(unittest.TestCase):

    # Fixture 1: TM-1 applies -- hot memory stale 8 days -> warm
    def test_tm1_hot_stale_migrates_to_warm(self):
        rows = [{"agent_id": "a", "category": "hot", "created_at": days_ago(8), "accessed_at": None}]
        path = make_db(rows)
        memories = mod.load_memories(path)
        result = mod.compute_safe_migrations(memories, NOW, tm1_days=7, tm3_days=30)
        self.assertEqual(len(result), 1)
        _id, agent, from_t, to_t, rule = result[0]
        self.assertEqual(from_t, "hot")
        self.assertEqual(to_t, "warm")
        self.assertEqual(rule, "TM-1")

    # Fixture 2: TM-3 applies -- warm memory stale 35 days -> cold
    def test_tm3_warm_stale_migrates_to_cold(self):
        rows = [{"agent_id": "b", "category": "warm", "created_at": days_ago(35), "accessed_at": None}]
        path = make_db(rows)
        memories = mod.load_memories(path)
        result = mod.compute_safe_migrations(memories, NOW, tm1_days=7, tm3_days=30)
        self.assertEqual(len(result), 1)
        _id, agent, from_t, to_t, rule = result[0]
        self.assertEqual(from_t, "warm")
        self.assertEqual(to_t, "cold")
        self.assertEqual(rule, "TM-3")

    # Fixture 3: Fresh hot memory (5 days) -- NOT migrated
    def test_fresh_hot_not_migrated(self):
        rows = [{"agent_id": "c", "category": "hot", "created_at": days_ago(5), "accessed_at": None}]
        path = make_db(rows)
        memories = mod.load_memories(path)
        result = mod.compute_safe_migrations(memories, NOW, tm1_days=7, tm3_days=30)
        self.assertEqual(result, [])

    # Fixture 4: TM-2 skip -- done-marker in content, stale 8 days hot
    # TM-1 still fires (TM-2 is skipped, not the absence of TM-1)
    def test_done_marker_hot_still_hits_tm1(self):
        rows = [{"agent_id": "d", "category": "hot", "content": "MERGED PR#123", "created_at": days_ago(8), "accessed_at": None}]
        path = make_db(rows)
        memories = mod.load_memories(path)
        result = mod.compute_safe_migrations(memories, NOW, tm1_days=7, tm3_days=30)
        # TM-1 fires; TM-2 (done-marker forced skip) is not implemented here
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0][3], "warm")  # to_tier
        self.assertEqual(result[0][4], "TM-1")  # rule


class TestApplyMigrations(unittest.TestCase):

    # Fixture 5: audit -- migration_log row created on apply
    def test_audit_log_row_written_on_apply(self):
        rows = [{"agent_id": "a", "category": "hot", "created_at": days_ago(8), "accessed_at": None}]
        path = make_db(rows)
        memories = mod.load_memories(path)
        migrations = mod.compute_safe_migrations(memories, NOW, tm1_days=7, tm3_days=30)
        mod.apply_migrations(path, migrations, NOW, dry_run=False)

        con = sqlite3.connect(path)
        logs = con.execute("SELECT * FROM migration_log").fetchall()
        con.close()
        self.assertEqual(len(logs), 1)
        # row: (id, run_at, memory_id, agent_id, from_tier, to_tier, rule, dry_run)
        self.assertEqual(logs[0][4], "hot")    # from_tier
        self.assertEqual(logs[0][5], "warm")   # to_tier
        self.assertEqual(logs[0][7], 0)        # dry_run=0

    # Fixture 6: dry-run -- no category change, log row marked dry_run=1
    def test_dry_run_does_not_mutate_category(self):
        rows = [{"agent_id": "a", "category": "hot", "created_at": days_ago(8), "accessed_at": None}]
        path = make_db(rows)
        memories = mod.load_memories(path)
        migrations = mod.compute_safe_migrations(memories, NOW, tm1_days=7, tm3_days=30)
        mod.apply_migrations(path, migrations, NOW, dry_run=True)

        con = sqlite3.connect(path)
        cat = con.execute("SELECT category FROM memories").fetchone()[0]
        log = con.execute("SELECT dry_run FROM migration_log").fetchone()
        con.close()
        self.assertEqual(cat, "hot")   # unchanged
        self.assertEqual(log[0], 1)    # dry_run=1 in log


if __name__ == "__main__":
    import unittest
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
