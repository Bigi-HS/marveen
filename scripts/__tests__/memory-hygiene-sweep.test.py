#!/usr/bin/env python3
"""Tests for scripts/memory-hygiene-sweep.py managed-queue ack exception (card 16bbd5b5).

Contract:
  - a genuine forgotten-pending (pending language, stale, NO marker) still flags;
  - a [HYGIENE-ACK] marker (undated) excludes the memory from stale_pending;
  - a dated [HYGIENE-ACK: <recent>] marker (within --ack-ttl-days) excludes it;
  - a dated marker older than --ack-ttl-days EXPIRES and the memory flags again.

Hermetic: builds a temp memories DB and runs the script with --db/--json-only.
Run: python3 scripts/__tests__/memory-hygiene-sweep.test.py
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "memory-hygiene-sweep.py"
)

DAY = 86400
PENDING = "Boss-döntés vár: heti revisit queue, awaiting-dominik."


def _make_db(path, rows):
    db = sqlite3.connect(path)
    db.execute(
        "CREATE TABLE memories (id INTEGER PRIMARY KEY, agent_id TEXT, "
        "category TEXT, content TEXT, created_at INTEGER)"
    )
    db.executemany(
        "INSERT INTO memories (id, agent_id, category, content, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        rows,
    )
    db.commit()
    db.close()


def _run(db_path, extra=None):
    cmd = [sys.executable, SCRIPT, "--db", db_path, "--json-only"]
    if extra:
        cmd += extra
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    assert out.returncode in (0, 1), f"unexpected exit {out.returncode}: {out.stderr}"
    return json.loads(out.stdout)


class ManagedAckExceptionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "mem.db")
        self.now = int(time.time())
        self.old = self.now - 30 * DAY            # stale (> 14d default)
        self.very_old = self.now - 60 * DAY       # beyond 30d ack-ttl

    def _ids(self, findings):
        return {r["id"] for r in findings["stale_pending"]}

    def test_forgotten_pending_without_marker_still_flags(self):
        _make_db(self.db, [(1, "marveen", "warm", PENDING, self.old)])
        f = _run(self.db)
        self.assertIn(1, self._ids(f), "genuine forgotten-pending must still flag")
        self.assertEqual(f["managed_acked_excluded"], 0)

    def test_undated_ack_marker_excludes(self):
        content = PENDING + "  [HYGIENE-ACK] intentionally long-lived Boss queue"
        _make_db(self.db, [(2, "marveen", "warm", content, self.old)])
        f = _run(self.db)
        self.assertNotIn(2, self._ids(f), "undated [HYGIENE-ACK] must exclude")
        self.assertEqual(f["managed_acked_excluded"], 1)

    def test_recent_dated_ack_marker_excludes(self):
        stamp = time.strftime("%Y-%m-%d", time.localtime(self.now - 3 * DAY))
        content = PENDING + f"  [HYGIENE-ACK: {stamp}]"
        _make_db(self.db, [(3, "marveen", "warm", content, self.old)])
        f = _run(self.db)
        self.assertNotIn(3, self._ids(f), "recent dated ack must exclude")

    def test_stale_dated_ack_marker_expires_and_flags(self):
        stamp = time.strftime("%Y-%m-%d", time.localtime(self.very_old))
        content = PENDING + f"  [HYGIENE-ACK: {stamp}]"
        _make_db(self.db, [(4, "marveen", "warm", content, self.old)])
        f = _run(self.db, extra=["--ack-ttl-days", "30"])
        self.assertIn(4, self._ids(f), "ack older than ttl must expire and flag")

    def test_marker_on_non_pending_is_noop(self):
        # A non-pending memory is never in stale_pending regardless of the marker.
        _make_db(self.db, [(5, "marveen", "warm", "just a normal fact [HYGIENE-ACK]", self.old)])
        f = _run(self.db)
        self.assertNotIn(5, self._ids(f))
        self.assertEqual(f["managed_acked_excluded"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
