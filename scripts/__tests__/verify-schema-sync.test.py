#!/usr/bin/env python3
"""Acceptance tests for scripts/verify-schema-sync.py (spec A1 v5, AC-5).

The script takes two DB paths and asserts structural equality:
  - same table names (ignoring sqlite_sequence)
  - same column names + types per table (order-insensitive)
  - same index names + SQL (ignoring auto sqlite_autoindex_*)
  - same trigger names
Exit 0 when identical, non-zero + a human-readable diff otherwise.

A path of ":memory:" is built from scripts/schema-noa.sql (overridable via
SCHEMA_PATH so the test is hermetic).

Run: python3 scripts/__tests__/verify-schema-sync.test.py
"""
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "verify-schema-sync.py"
)

BASE_SCHEMA = """
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX idx_mem_agent ON memories(agent_id, category);
CREATE INDEX idx_token_ts ON token_usage(timestamp);
CREATE TRIGGER mem_touch AFTER UPDATE ON memories BEGIN
  UPDATE memories SET created_at = created_at WHERE id = NEW.id;
END;
"""


def _build(path: str, schema: str):
    db = sqlite3.connect(path)
    db.executescript(schema)
    db.commit()
    db.close()


def _run(a: str, b: str, schema_path=None):
    env = dict(os.environ)
    if schema_path is not None:
        env["SCHEMA_PATH"] = schema_path
    return subprocess.run(
        [sys.executable, SCRIPT, a, b], capture_output=True, text=True, env=env
    )


class VerifySchemaSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="noa-verify-")
        self.a = os.path.join(self.tmp, "a.db")
        self.b = os.path.join(self.tmp, "b.db")

    def test_identical_schemas_exit_zero(self):
        _build(self.a, BASE_SCHEMA)
        _build(self.b, BASE_SCHEMA)
        r = _run(self.a, self.b)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_missing_table_fails(self):
        _build(self.a, BASE_SCHEMA)
        _build(self.b, BASE_SCHEMA + "\nCREATE TABLE extra (id INTEGER PRIMARY KEY);")
        r = _run(self.a, self.b)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("extra", r.stdout + r.stderr)

    def test_column_type_difference_fails(self):
        _build(self.a, BASE_SCHEMA)
        altered = BASE_SCHEMA.replace("timestamp INTEGER NOT NULL", "timestamp TEXT NOT NULL")
        _build(self.b, altered)
        r = _run(self.a, self.b)
        self.assertNotEqual(r.returncode, 0)

    def test_extra_index_fails(self):
        _build(self.a, BASE_SCHEMA)
        _build(self.b, BASE_SCHEMA + "\nCREATE INDEX idx_extra ON token_usage(agent);")
        r = _run(self.a, self.b)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("idx_extra", r.stdout + r.stderr)

    def test_missing_trigger_fails(self):
        _build(self.a, BASE_SCHEMA)
        no_trigger = BASE_SCHEMA.split("CREATE TRIGGER")[0]
        _build(self.b, no_trigger)
        r = _run(self.a, self.b)
        self.assertNotEqual(r.returncode, 0)

    def test_column_order_is_insensitive(self):
        _build(self.a, BASE_SCHEMA)
        reordered = """
        CREATE TABLE memories (
          agent_id TEXT NOT NULL,
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX idx_mem_agent ON memories(agent_id, category);
        CREATE INDEX idx_token_ts ON token_usage(timestamp);
        CREATE TRIGGER mem_touch AFTER UPDATE ON memories BEGIN
          UPDATE memories SET created_at = created_at WHERE id = NEW.id;
        END;
        """
        _build(self.b, reordered)
        r = _run(self.a, self.b)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_ignores_sqlite_sequence(self):
        _build(self.a, BASE_SCHEMA)
        _build(self.b, BASE_SCHEMA)
        # touch AUTOINCREMENT so sqlite_sequence materializes in a only
        db = sqlite3.connect(self.a)
        db.execute("INSERT INTO memories(agent_id,category,content,created_at) VALUES('x','hot','y',1)")
        db.commit()
        db.close()
        self.assertTrue(
            sqlite3.connect(self.a).execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='sqlite_sequence'"
            ).fetchone()[0] >= 1
        )
        r = _run(self.a, self.b)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_table_name_with_quote_does_not_crash(self):
        """Chad hardening: a crafted table name containing a single quote must not
        crash the PRAGMA table_info lookup (f-string interpolation would break)."""
        weird = 'CREATE TABLE "o\'brien" (id INTEGER PRIMARY KEY, name TEXT);\n'
        _build(self.a, BASE_SCHEMA + weird)
        _build(self.b, BASE_SCHEMA + weird)
        r = _run(self.a, self.b)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_memory_path_builds_from_schema_file(self):
        schema_file = os.path.join(self.tmp, "schema.sql")
        with open(schema_file, "w", encoding="utf-8") as f:
            f.write(BASE_SCHEMA)
        _build(self.a, BASE_SCHEMA)
        r = _run(self.a, ":memory:", schema_path=schema_file)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
