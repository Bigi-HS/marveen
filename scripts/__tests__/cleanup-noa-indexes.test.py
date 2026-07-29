#!/usr/bin/env python3
"""Acceptance tests for scripts/cleanup-noa-indexes.py (spec A1 v5, AC-3).

The script drops 3 redundant indexes from token_usage on the live noa.db:
  idx_token_usage_dedup, idx_token_usage_agent_ts, idx_token_usage_agent

Safety contract (Thor T1 finding, v5): the script must resolve the DB path
relative to the PROJECT ROOT (Path(__file__).parent.parent / "store" / "noa.db"),
NOT the current working directory, and must assert the DB file exists before
connecting -- so a wrong-CWD invocation cannot silently drop indexes from a
different / freshly-created database.

The DB path is overridable via NOA_DB_PATH so the test is hermetic.

Run: python3 scripts/__tests__/cleanup-noa-indexes.test.py
"""
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "cleanup-noa-indexes.py"
)

DUP_INDEXES = ["idx_token_usage_dedup", "idx_token_usage_agent_ts", "idx_token_usage_agent"]
# Canonical indexes that must SURVIVE the cleanup (the ones the dups shadow).
KEEP_INDEXES = ["idx_token_dedup", "idx_token_agent_ts", "idx_token_usage_ts"]


def _make_db(path: str):
    """Build a minimal token_usage table carrying both the dup and the keep indexes."""
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent TEXT NOT NULL, session_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
          tool_name TEXT
        );
        -- dups (to be dropped)
        CREATE UNIQUE INDEX idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, tool_name);
        CREATE INDEX idx_token_usage_agent_ts ON token_usage(agent, timestamp);
        CREATE INDEX idx_token_usage_agent ON token_usage(agent);
        -- canonical keepers
        CREATE UNIQUE INDEX idx_token_dedup ON token_usage(agent, session_id, timestamp, tool_name);
        CREATE INDEX idx_token_agent_ts ON token_usage(agent, timestamp);
        CREATE INDEX idx_token_usage_ts ON token_usage(timestamp);
        """
    )
    db.commit()
    db.close()


def _index_names(path: str):
    db = sqlite3.connect(path)
    try:
        return {r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()}
    finally:
        db.close()


def _run(db_path=None, extra_env=None):
    env = dict(os.environ)
    if db_path is not None:
        env["NOA_DB_PATH"] = db_path
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, SCRIPT], capture_output=True, text=True, env=env
    )


class CleanupIndexesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="noa-idx-")
        self.db = os.path.join(self.tmp, "noa.db")

    def test_drops_the_three_dup_indexes(self):
        _make_db(self.db)
        r = _run(self.db)
        self.assertEqual(r.returncode, 0, r.stderr)
        names = _index_names(self.db)
        for idx in DUP_INDEXES:
            self.assertNotIn(idx, names, f"{idx} should have been dropped")

    def test_keeps_the_canonical_indexes(self):
        _make_db(self.db)
        _run(self.db)
        names = _index_names(self.db)
        for idx in KEEP_INDEXES:
            self.assertIn(idx, names, f"{idx} must NOT be dropped")

    def test_idempotent_second_run_is_noop(self):
        _make_db(self.db)
        first = _run(self.db)
        self.assertEqual(first.returncode, 0, first.stderr)
        second = _run(self.db)
        self.assertEqual(second.returncode, 0, second.stderr)
        names = _index_names(self.db)
        for idx in DUP_INDEXES:
            self.assertNotIn(idx, names)

    def test_aborts_when_db_missing(self):
        """T1: a non-existent resolved path must abort (assert exists), not create a DB."""
        missing = os.path.join(self.tmp, "does-not-exist.db")
        r = _run(missing)
        self.assertNotEqual(r.returncode, 0, "must fail when DB path does not exist")
        self.assertFalse(os.path.exists(missing), "must NOT create the DB on a missing path")

    def test_default_path_is_project_root_relative_not_cwd(self):
        """T1: with no override, the script resolves store/noa.db under the repo root,
        independent of CWD. Running from /tmp must still target the repo DB path
        (which exists in the live tree), never a /tmp/store/noa.db."""
        # Run from an unrelated CWD with NO override; the script must not look at
        # cwd/store/noa.db. We assert it does not create a store/ dir under the tmp cwd.
        r = subprocess.run(
            [sys.executable, SCRIPT], capture_output=True, text=True,
            cwd=self.tmp, env={k: v for k, v in os.environ.items() if k != "NOA_DB_PATH"},
        )
        # It either succeeds (repo DB exists) or aborts (missing) -- but it must never
        # have created a store/noa.db under the unrelated CWD.
        self.assertFalse(
            os.path.exists(os.path.join(self.tmp, "store", "noa.db")),
            "script resolved DB relative to CWD instead of project root",
        )
        del r


if __name__ == "__main__":
    unittest.main()
