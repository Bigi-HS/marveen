#!/usr/bin/env python3
"""Hermetic tests for scripts/todo-freshness-check.py (spec FS-AC4).

Run: python3 scripts/__tests__/todo-freshness-check.test.py

Builds a synthetic todo_items db in a temp dir; no live db is touched and no
network call is made (only --dry-run / evaluate() paths are exercised).
"""
import importlib.util
import io
import json
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
        db = _make_db([("hibiki", NOW - 37 * 3600)])  # 37h old > 36h threshold
        conn = sqlite3.connect(db)
        try:
            verdicts = {v["owner"]: v for v in mod.evaluate(conn, NOW, mod.THRESHOLD_SECONDS)}
        finally:
            conn.close()
        self.assertEqual(verdicts["hibiki"]["state"], "stale")
        self.assertEqual(verdicts["hibiki"]["ago"], 37 * 3600)

    def test_uses_max_updated_at(self):
        # An old row plus a recent row -> owner is fresh (MAX wins).
        db = _make_db([("claudia", NOW - 30 * 3600), ("claudia", NOW - 600)])
        conn = sqlite3.connect(db)
        try:
            verdicts = {v["owner"]: v for v in mod.evaluate(conn, NOW, mod.THRESHOLD_SECONDS)}
        finally:
            conn.close()
        self.assertEqual(verdicts["claudia"]["state"], "ok")


class AdversarialThresholdTests(unittest.TestCase):
    """Thor adversarial fixture (card 9ad7334e): now that the check runs from the
    always-on supervisor tick instead of an agent-injected task, a "busy" agent can
    no longer manufacture a spurious FAIL -- the invocation is a plain, session-free
    python run. What must still hold is the semantic guarantee the Boss-visible
    FAIL surface depended on: a benign tick NEVER alerts, and only a genuine
    >36h staleness does. These pin that boundary end-to-end through main()."""

    def test_threshold_constant_is_36h(self):
        # Literal pin: if THRESHOLD_SECONDS changes, this test goes red (audible signal).
        # The symbolic boundary tests above are green at any threshold value -- this one is not.
        self.assertEqual(mod.THRESHOLD_SECONDS, 129600)  # 36h

    def test_exactly_at_threshold_is_not_stale(self):
        # Strict > threshold: an owner exactly at 36h is still ok (no FAIL).
        db = _make_db([("hibiki", NOW - mod.THRESHOLD_SECONDS)])
        conn = sqlite3.connect(db)
        try:
            verdicts = {v["owner"]: v for v in mod.evaluate(conn, NOW, mod.THRESHOLD_SECONDS)}
        finally:
            conn.close()
        self.assertEqual(verdicts["hibiki"]["state"], "ok")

    def test_one_second_over_threshold_is_stale(self):
        db = _make_db([("hibiki", NOW - mod.THRESHOLD_SECONDS - 1)])
        conn = sqlite3.connect(db)
        try:
            verdicts = {v["owner"]: v for v in mod.evaluate(conn, NOW, mod.THRESHOLD_SECONDS)}
        finally:
            conn.close()
        self.assertEqual(verdicts["hibiki"]["state"], "stale")

    def test_benign_tick_never_alerts(self):
        # Mixed benign board: one fresh owner + one with no rows at all. No FAIL.
        db = _make_db([("claudia", NOW - 600)])  # hibiki has no rows
        state = str(Path(tempfile.mkdtemp()) / "state.json")
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = mod.main(["--db", db, "--state", state, "--dry-run", "--now", str(NOW)])
        self.assertEqual(rc, 0)
        self.assertNotIn("WOULD ALERT", buf.getvalue())

    def test_genuine_staleness_still_alerts_amid_a_fresh_owner(self):
        # One fresh + one genuinely >26h stale -> exactly the stale owner alerts.
        db = _make_db([("claudia", NOW - 600), ("hibiki", NOW - 40 * 3600)])
        state = str(Path(tempfile.mkdtemp()) / "state.json")
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = mod.main(["--db", db, "--state", state, "--dry-run", "--now", str(NOW)])
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("WOULD ALERT", out)
        self.assertIn("hibiki has not written", out)
        self.assertNotIn("claudia has not written", out)


class DryRunTests(unittest.TestCase):
    def test_dry_run_reports_would_alert_for_stale(self):
        db = _make_db([("hibiki", NOW - 37 * 3600)])
        state = str(Path(tempfile.mkdtemp()) / "state.json")
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = mod.main(["--db", db, "--state", state, "--dry-run", "--now", str(NOW)])
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("WOULD ALERT", out)
        self.assertIn("hibiki has not written to todo_items in 37h", out)
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
        # 27h < 72h -> "delayed/missed" detail branch.
        self.assertEqual(
            mod._alert_content("claudia", 27 * 3600),
            "FRESHNESS ALERT: claudia has not written to todo_items in 27h."
            " Daily write task appears delayed or missed."
            " Verify the task ran and the agent is healthy.",
        )

    def test_alert_content_format_extended_outage(self):
        # 73h >= 72h -> "may be down" detail branch.
        self.assertEqual(
            mod._alert_content("hibiki", 73 * 3600),
            "FRESHNESS ALERT: hibiki has not written to todo_items in 73h."
            " No write in an extended period -- agent may be down or task permanently broken.",
        )


class SenderTests(unittest.TestCase):
    def test_default_sender_is_not_dave_the_engineer(self):
        # The alert is an automated ops heartbeat; it must not be attributed to
        # Dave the engineer (Thor PR #129 INFO finding).
        self.assertEqual(mod.DEFAULT_FROM, "forge")

    def test_send_alert_uses_sender_in_payload(self):
        captured = {}

        class _FakeResp:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def _fake_urlopen(req):
            captured["from"] = json.loads(req.data.decode())["from"]
            return _FakeResp()

        orig = mod.urllib.request.urlopen
        mod.urllib.request.urlopen = _fake_urlopen
        try:
            status = mod._send_alert("x", "tok", "forge")
        finally:
            mod.urllib.request.urlopen = orig
        self.assertEqual(status, 200)
        self.assertEqual(captured["from"], "forge")


if __name__ == "__main__":
    unittest.main(verbosity=2)
