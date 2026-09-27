#!/usr/bin/env python3
"""Tests for scripts/vault-lint-apply-safe-tm.py (card bc638bd2, MEM-011).

3 fixtures per spec:
  1. TM-1: hot memory 8 days stale -> migrated to warm
  2. TM-3: warm memory 35 days stale -> migrated to cold
  3. Safety: hot memory 5 days stale -> NOT migrated (below TM-1 threshold)
  4. TM-2 skip: hot memory with done-marker, 8 days stale -> migrated by TM-1
               (TM-2 is deliberately excluded; hot+stale hits TM-1 regardless)
  5. Audit: migration_log row created for each applied migration (live curator schema)
  6. Dry-run: dry_run=True -> no category change AND no log row (only real applies audited)

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

# EXACT live curator-owned schema (dumped from store/noa.db). The table is owned
# by the curator applier (vault-curator-apply-verdicts.py / src/curator-verdicts.ts);
# all writers (curator, #713 tm1-executor, this script) share it and are distinguished
# by the `applier` column. The test builds the fixture from THIS schema, not the
# script's own DDL -- a test that creates the table from the script's CREATE would go
# green while the script is DOA on the real DB (the #713 round-2 false-green lesson).
MIGRATION_LOG_DDL = """
CREATE TABLE migration_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule       TEXT    NOT NULL,
    entry_id   INTEGER NOT NULL,
    from_cat   TEXT    NOT NULL,
    to_cat     TEXT    NOT NULL,
    reason     TEXT    NOT NULL,
    applier    TEXT    NOT NULL DEFAULT 'curator-applyer',
    applied_at INTEGER NOT NULL
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

    # Fixture 5: audit -- migration_log row written on apply, in the live curator
    # schema, tagged with this script's applier so writers stay distinguishable.
    def test_audit_log_row_written_on_apply(self):
        rows = [{"agent_id": "a", "category": "hot", "created_at": days_ago(8), "accessed_at": None}]
        path = make_db(rows)
        memories = mod.load_memories(path)
        migrations = mod.compute_safe_migrations(memories, NOW, tm1_days=7, tm3_days=30)
        applied = mod.apply_migrations(path, migrations, NOW, dry_run=False)
        self.assertEqual(applied, 1)

        con = sqlite3.connect(path)
        con.row_factory = sqlite3.Row
        logs = con.execute("SELECT * FROM migration_log").fetchall()
        # memory row id (entry_id) for cross-check
        mem_id = con.execute("SELECT id FROM memories").fetchone()[0]
        con.close()
        self.assertEqual(len(logs), 1)
        row = logs[0]
        self.assertEqual(row["rule"], "TM-1")
        self.assertEqual(row["entry_id"], mem_id)
        self.assertEqual(row["from_cat"], "hot")
        self.assertEqual(row["to_cat"], "warm")
        self.assertEqual(row["applier"], mod.APPLIER_NAME)
        self.assertEqual(row["applied_at"], NOW)
        self.assertTrue(row["reason"])  # non-empty audit reason

    # Fixture 6: dry-run -- no category change AND no log row. Only real applies are
    # audited (matches curator + #713 executor: the log records applied migrations,
    # not previews). The live curator schema has no dry_run column.
    def test_dry_run_mutates_nothing(self):
        rows = [{"agent_id": "a", "category": "hot", "created_at": days_ago(8), "accessed_at": None}]
        path = make_db(rows)
        memories = mod.load_memories(path)
        migrations = mod.compute_safe_migrations(memories, NOW, tm1_days=7, tm3_days=30)
        applied = mod.apply_migrations(path, migrations, NOW, dry_run=True)
        self.assertEqual(applied, 1)  # reports would-migrate count

        con = sqlite3.connect(path)
        cat = con.execute("SELECT category FROM memories").fetchone()[0]
        log_count = con.execute("SELECT COUNT(*) FROM migration_log").fetchone()[0]
        con.close()
        self.assertEqual(cat, "hot")     # category unchanged
        self.assertEqual(log_count, 0)   # dry-run writes no audit row


if __name__ == "__main__":
    import unittest
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
