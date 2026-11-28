#!/usr/bin/env python3
"""Tests for scripts/reconcile-agent-messages-completed-at.py (card c077ac25)."""
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent
SCRIPT = REPO_ROOT / "scripts" / "reconcile-agent-messages-completed-at.py"


def _load():
    spec = importlib.util.spec_from_file_location("reconcile", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _make_db(rows):
    """Create an in-memory DB with agent_messages rows."""
    conn = sqlite3.connect(":memory:")
    conn.execute("""
        CREATE TABLE agent_messages (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            from_agent   TEXT NOT NULL,
            to_agent     TEXT NOT NULL,
            content      TEXT NOT NULL,
            status       TEXT NOT NULL,
            priority     INTEGER NOT NULL DEFAULT 50,
            result       TEXT,
            created_at   INTEGER NOT NULL,
            delivered_at INTEGER,
            completed_at INTEGER
        )
    """)
    for r in rows:
        conn.execute(
            "INSERT INTO agent_messages (from_agent,to_agent,content,status,result,created_at,delivered_at,completed_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (r.get("from","dave"), r.get("to","thor"), r.get("content","msg"),
             r.get("status","done"), r.get("result"), r.get("created_at",1000),
             r.get("delivered_at"), r.get("completed_at")),
        )
    conn.commit()
    return conn


class TestCandidateCount(unittest.TestCase):
    def test_counts_rows_with_result_and_null_completed_at(self):
        mod = _load()
        conn = _make_db([
            {"result": "ok", "completed_at": None},   # candidate
            {"result": "ok", "completed_at": 2000},   # already set
            {"result": None, "completed_at": None},   # no result
        ])
        self.assertEqual(mod._candidate_count(conn), 1)


class TestReconcile(unittest.TestCase):
    def test_backfills_delivered_at_when_present(self):
        mod = _load()
        with tempfile.NamedTemporaryFile(suffix=".db") as f:
            conn = sqlite3.connect(f.name)
            conn.execute("""
                CREATE TABLE agent_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
                    content TEXT NOT NULL, status TEXT NOT NULL,
                    result TEXT, created_at INTEGER NOT NULL,
                    delivered_at INTEGER, completed_at INTEGER
                )
            """)
            conn.execute(
                "INSERT INTO agent_messages (from_agent,to_agent,content,status,result,created_at,delivered_at)"
                " VALUES ('dave','thor','msg','done','result-data',1000,1500)"
            )
            conn.commit()
            conn.close()

            count = mod.reconcile(Path(f.name))
            self.assertEqual(count, 1)

            conn = sqlite3.connect(f.name)
            row = conn.execute("SELECT completed_at FROM agent_messages").fetchone()
            conn.close()
            self.assertEqual(row[0], 1500)  # delivered_at

    def test_falls_back_to_created_at_when_delivered_at_null(self):
        mod = _load()
        with tempfile.NamedTemporaryFile(suffix=".db") as f:
            conn = sqlite3.connect(f.name)
            conn.execute("""
                CREATE TABLE agent_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
                    content TEXT NOT NULL, status TEXT NOT NULL,
                    result TEXT, created_at INTEGER NOT NULL,
                    delivered_at INTEGER, completed_at INTEGER
                )
            """)
            conn.execute(
                "INSERT INTO agent_messages (from_agent,to_agent,content,status,result,created_at)"
                " VALUES ('dave','thor','msg','done','result-data',1000)"
            )
            conn.commit()
            conn.close()

            mod.reconcile(Path(f.name))

            conn = sqlite3.connect(f.name)
            row = conn.execute("SELECT completed_at FROM agent_messages").fetchone()
            conn.close()
            self.assertEqual(row[0], 1000)  # created_at fallback

    def test_idempotent_second_run_is_noop(self):
        mod = _load()
        with tempfile.NamedTemporaryFile(suffix=".db") as f:
            conn = sqlite3.connect(f.name)
            conn.execute("""
                CREATE TABLE agent_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
                    content TEXT NOT NULL, status TEXT NOT NULL,
                    result TEXT, created_at INTEGER NOT NULL,
                    delivered_at INTEGER, completed_at INTEGER
                )
            """)
            conn.execute(
                "INSERT INTO agent_messages (from_agent,to_agent,content,status,result,created_at,delivered_at)"
                " VALUES ('dave','thor','msg','done','result-data',1000,1500)"
            )
            conn.commit()
            conn.close()

            mod.reconcile(Path(f.name))
            count2 = mod.reconcile(Path(f.name))
            self.assertEqual(count2, 0)  # second run: nothing to do

    def test_dry_run_reports_count_without_updating(self):
        mod = _load()
        with tempfile.NamedTemporaryFile(suffix=".db") as f:
            conn = sqlite3.connect(f.name)
            conn.execute("""
                CREATE TABLE agent_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
                    content TEXT NOT NULL, status TEXT NOT NULL,
                    result TEXT, created_at INTEGER NOT NULL,
                    delivered_at INTEGER, completed_at INTEGER
                )
            """)
            conn.execute(
                "INSERT INTO agent_messages (from_agent,to_agent,content,status,result,created_at,delivered_at)"
                " VALUES ('dave','thor','msg','done','result-data',1000,1500)"
            )
            conn.commit()
            conn.close()

            count = mod.reconcile(Path(f.name), dry_run=True)
            self.assertEqual(count, 1)

            conn = sqlite3.connect(f.name)
            row = conn.execute("SELECT completed_at FROM agent_messages").fetchone()
            conn.close()
            self.assertIsNone(row[0])  # dry_run: not updated

    def test_rows_without_result_are_untouched(self):
        mod = _load()
        with tempfile.NamedTemporaryFile(suffix=".db") as f:
            conn = sqlite3.connect(f.name)
            conn.execute("""
                CREATE TABLE agent_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
                    content TEXT NOT NULL, status TEXT NOT NULL,
                    result TEXT, created_at INTEGER NOT NULL,
                    delivered_at INTEGER, completed_at INTEGER
                )
            """)
            conn.execute(
                "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at)"
                " VALUES ('dave','thor','msg','delivered',1000)"
            )
            conn.commit()
            conn.close()

            count = mod.reconcile(Path(f.name))
            self.assertEqual(count, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
