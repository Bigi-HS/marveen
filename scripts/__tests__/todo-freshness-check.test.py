#!/usr/bin/env python3
"""Hermetic tests for scripts/todo-freshness-check.py (spec FS-AC4).

Run: python3 scripts/__tests__/todo-freshness-check.test.py

Builds a synthetic todo_items db in a temp dir; no live db is touched and no
network call is made (only --dry-run / evaluate() paths are exercised).
"""
import importlib.util
import io
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SCRIPT = _HERE.parent / "todo-freshness-check.py"
_spec = importlib.util.spec_from_file_location("todo_freshness_check", _SCRIPT)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

NOW = 1_800_000_000


def _make_db(rows):
    """rows: list of (owner, updated_at). Returns a temp db path."""
    d = tempfile.mkdtemp()
    path = Path(d) / "todo.db"
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE todo_items (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )"""
    )
    for i, (owner, updated) in enumerate(rows):
        conn.execute(
            "INSERT INTO todo_items (id, owner, title, created_at, updated_at) VALUES (?,?,?,?,?)",
            (f"r{i}", owner, "t", updated, updated),
        )
    conn.commit()
    conn.close()
    return str(path)


class EvaluateTests(unittest.TestCase):
    def test_no_rows_is_skipped_not_stale(self):
        db = _make_db([])
        conn = sqlite3.connect(db)
        try:
            verdicts = {v["owner"]: v for v in mod.evaluate(conn, NOW, mod.THRESHOLD_SECONDS)}
        finally:
            conn.close()
        self.assertEqual(verdicts["claudia"]["state"], "no-rows")
        self.assertEqual(verdicts["hibiki"]["state"], "no-rows")

    def test_fresh_write_is_ok(self):
        db = _make_db([("claudia", NOW - 3600)])  # 1h old
        conn = sqlite3.connect(db)
        try:
            verdicts = {v["owner"]: v for v in mod.evaluate(conn, NOW, mod.THRESHOLD_SECONDS)}
        finally:
            conn.close()
        self.assertEqual(verdicts["claudia"]["state"], "ok")
        self.assertEqual(verdicts["claudia"]["ago"], 3600)

    def test_stale_write_over_threshold(self):
        db = _make_db([("hibiki", NOW - 27 * 3600)])  # 27h old > 26h threshold
        conn = sqlite3.connect(db)
        try:
            verdicts = {v["owner"]: v for v in mod.evaluate(conn, NOW, mod.THRESHOLD_SECONDS)}
        finally:
            conn.close()
        self.assertEqual(verdicts["hibiki"]["state"], "stale")
        self.assertEqual(verdicts["hibiki"]["ago"], 27 * 3600)

    def test_uses_max_updated_at(self):
        # An old row plus a recent row -> owner is fresh (MAX wins).
        db = _make_db([("claudia", NOW - 30 * 3600), ("claudia", NOW - 600)])
        conn = sqlite3.connect(db)
        try:
            verdicts = {v["owner"]: v for v in mod.evaluate(conn, NOW, mod.THRESHOLD_SECONDS)}
        finally:
            conn.close()
        self.assertEqual(verdicts["claudia"]["state"], "ok")


class DryRunTests(unittest.TestCase):
    def test_dry_run_reports_would_alert_for_stale(self):
        db = _make_db([("hibiki", NOW - 27 * 3600)])
        state = str(Path(tempfile.mkdtemp()) / "state.json")
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = mod.main(["--db", db, "--state", state, "--dry-run", "--now", str(NOW)])
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("WOULD ALERT", out)
        self.assertIn("hibiki has not written to todo_items in 27h", out)
        # dry-run must not persist a state file
        self.assertFalse(Path(state).exists())

    def test_dry_run_no_alert_when_fresh(self):
        db = _make_db([("claudia", NOW - 600), ("hibiki", NOW - 600)])
        state = str(Path(tempfile.mkdtemp()) / "state.json")
        buf = io.StringIO()
        with redirect_stdout(buf):
            mod.main(["--db", db, "--state", state, "--dry-run", "--now", str(NOW)])
        self.assertNotIn("WOULD ALERT", buf.getvalue())

    def test_alert_content_format(self):
        self.assertEqual(
            mod._alert_content("claudia", 27 * 3600),
            "FRESHNESS ALERT: claudia has not written to todo_items in 27h. Check agent health.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
