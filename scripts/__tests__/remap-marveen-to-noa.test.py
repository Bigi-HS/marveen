#!/usr/bin/env python3
"""Tests for scripts/migration/remap-marveen-to-noa.py (stage-1 identity remap).

Builds a tiny noa.db-shaped temp DB with the agents dim table (FK target) + a
representative set of identity columns (FK children + non-FK id columns + a
scope value + a free-text-ish column), seeds 'marveen', 'marveen-local', and
other ids, then exercises register-noa / full-remap counts / idempotency /
FK-clean / marveen-local-preservation.

Run directly:  python3 scripts/__tests__/remap-marveen-to-noa.test.py
"""
import importlib.util
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
_SCRIPT = os.path.join(_REPO, "scripts", "migration", "remap-marveen-to-noa.py")

# import the module under test (filename has dashes -> load by path)
_spec = importlib.util.spec_from_file_location("remap_marveen_to_noa", _SCRIPT)
remap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(remap)


def _make_db(path):
    """A minimal schema mirroring the live shape: agents dim + FK children +
    non-FK id columns + a scope col + marveen-local rows."""
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys=ON")
    now = int(time.time())
    conn.executescript(
        """
        CREATE TABLE agents (
          agent_id   TEXT PRIMARY KEY,
          display    TEXT NOT NULL,
          team       TEXT, leader TEXT, model TEXT,
          domain_db  INTEGER NOT NULL DEFAULT 0,
          status     TEXT,
          kind       TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','owner','service')),
          created_at INTEGER NOT NULL,
          retired_at INTEGER
        );
        -- FK children of agents.agent_id
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY,
          agent_id TEXT REFERENCES agents(agent_id),
          access_scope TEXT,
          content TEXT
        );
        CREATE TABLE agent_messages (
          id INTEGER PRIMARY KEY,
          from_agent TEXT REFERENCES agents(agent_id),
          to_agent TEXT,
          body TEXT
        );
        CREATE TABLE kanban_cards (
          id INTEGER PRIMARY KEY,
          assignee TEXT REFERENCES agents(agent_id),
          title TEXT
        );
        CREATE TABLE agent_tokens (
          id INTEGER PRIMARY KEY,
          agent_id TEXT REFERENCES agents(agent_id),
          token TEXT
        );
        -- non-FK id columns
        CREATE TABLE token_usage (
          id INTEGER PRIMARY KEY, agent TEXT, spawned_by TEXT, task_title TEXT
        );
        CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, agent TEXT, type TEXT);
        """
    )
    # agents: marveen (FK parent to remap-around), marveen-local (preserve), dave
    conn.executemany(
        "INSERT INTO agents (agent_id, display, team, leader, model, domain_db, status, kind, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("marveen", "marveen", "core", "dominik", "opus", 0, None, "agent", now),
            ("marveen-local", "marveen-local", None, None, "ollama", 0, None, "agent", now),
            ("dave", "Dave", None, None, None, 0, None, "agent", now),
        ],
    )
    # FK children
    conn.executemany(
        "INSERT INTO memories (agent_id, access_scope, content) VALUES (?,?,?)",
        [("marveen", "marveen", "a note by marveen free text"),
         ("marveen", "shared", "b"),
         ("dave", "shared", "c")],
    )
    conn.executemany(
        "INSERT INTO agent_messages (from_agent, to_agent, body) VALUES (?,?,?)",
        [("marveen", "dave", "x"), ("dave", "marveen", "y")],
    )
    conn.execute("INSERT INTO kanban_cards (assignee, title) VALUES ('marveen','t')")
    # agent_tokens: ONLY marveen-local -> must be preserved, 0 marveen
    conn.executemany(
        "INSERT INTO agent_tokens (agent_id, token) VALUES (?,?)",
        [("marveen-local", "tok1"), ("marveen-local", "tok2")],
    )
    # non-FK id columns
    conn.executemany(
        "INSERT INTO token_usage (agent, spawned_by, task_title) VALUES (?,?,?)",
        [("marveen", "marveen", "marveen ran a task"),  # task_title is free text, must stay
         ("dave", "marveen", "z")],
    )
    conn.execute("INSERT INTO scheduled_tasks (id, agent, type) VALUES ('t1','marveen','task')")
    conn.commit()
    conn.close()


def _count(path, table, col, val):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return c.execute(
            f"SELECT COUNT(*) FROM '{table}' WHERE \"{col}\"=?", (val,)
        ).fetchone()[0]
    finally:
        c.close()


def _run_cli(db, *flags):
    return subprocess.run(
        [sys.executable, _SCRIPT, "--db", db, *flags],
        capture_output=True, text=True,
    )


class RemapTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.db = os.path.join(self.d, "noa.db")
        _make_db(self.db)

    def test_dry_run_default_mutates_nothing(self):
        before_marveen = _count(self.db, "memories", "agent_id", "marveen")
        r = _run_cli(self.db)  # no flag -> dry-run default
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("DRY-RUN", r.stdout)
        self.assertEqual(_count(self.db, "memories", "agent_id", "marveen"), before_marveen)
        # noa NOT registered in dry-run
        self.assertEqual(_count(self.db, "agents", "agent_id", "noa"), 0)

    def test_register_noa_row_cloned_from_marveen(self):
        r = _run_cli(self.db, "--apply")
        self.assertEqual(r.returncode, 0, r.stderr)
        c = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        row = c.execute(
            "SELECT agent_id, display, team, leader, model, kind, retired_at FROM agents WHERE agent_id='noa'"
        ).fetchone()
        c.close()
        self.assertIsNotNone(row, "noa row must be registered")
        self.assertEqual(row[0], "noa")
        self.assertEqual(row[1], "NoA")           # display flipped to NoA
        self.assertEqual(row[2], "core")           # team cloned from marveen
        self.assertEqual(row[3], "dominik")        # leader cloned
        self.assertEqual(row[4], "opus")           # model cloned
        self.assertEqual(row[5], "agent")          # kind cloned
        self.assertIsNone(row[6])                  # not retired

    def test_full_remap_counts_fk_and_nonfk(self):
        r = _run_cli(self.db, "--apply")
        self.assertEqual(r.returncode, 0, r.stderr)
        # FK children -> noa
        self.assertEqual(_count(self.db, "memories", "agent_id", "noa"), 2)
        self.assertEqual(_count(self.db, "agent_messages", "from_agent", "noa"), 1)
        self.assertEqual(_count(self.db, "kanban_cards", "assignee", "noa"), 1)
        # non-FK id columns -> noa
        self.assertEqual(_count(self.db, "token_usage", "agent", "noa"), 1)
        self.assertEqual(_count(self.db, "token_usage", "spawned_by", "noa"), 2)
        self.assertEqual(_count(self.db, "agent_messages", "to_agent", "noa"), 1)
        self.assertEqual(_count(self.db, "scheduled_tasks", "agent", "noa"), 1)
        # scope value remapped
        self.assertEqual(_count(self.db, "memories", "access_scope", "noa"), 1)
        # ZERO marveen identity cells remain (dim row excluded -> still 1)
        self.assertEqual(_count(self.db, "memories", "agent_id", "marveen"), 0)
        self.assertEqual(_count(self.db, "token_usage", "agent", "marveen"), 0)

    def test_free_text_columns_untouched(self):
        # the scan matches EXACT 'marveen' only; free-text containing 'marveen'
        # as a substring must NOT be remapped.
        _run_cli(self.db, "--apply")
        c = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        self.assertEqual(
            c.execute("SELECT COUNT(*) FROM memories WHERE content LIKE '%marveen%'").fetchone()[0],
            1, "free-text 'marveen' substring preserved",
        )
        self.assertEqual(
            c.execute("SELECT COUNT(*) FROM token_usage WHERE task_title LIKE '%marveen%'").fetchone()[0],
            1,
        )
        c.close()

    def test_marveen_local_preserved(self):
        _run_cli(self.db, "--apply")
        # dim row + both agent_tokens rows survive unchanged
        self.assertEqual(_count(self.db, "agents", "agent_id", "marveen-local"), 1)
        self.assertEqual(_count(self.db, "agent_tokens", "agent_id", "marveen-local"), 2)
        # and NONE of them became noa
        self.assertEqual(_count(self.db, "agent_tokens", "agent_id", "noa"), 0)

    def test_old_marveen_dim_row_preserved(self):
        # Stage-1 must NOT retire/delete the marveen agents row (later step).
        _run_cli(self.db, "--apply")
        self.assertEqual(_count(self.db, "agents", "agent_id", "marveen"), 1)

    def test_other_ids_untouched(self):
        _run_cli(self.db, "--apply")
        self.assertEqual(_count(self.db, "agents", "agent_id", "dave"), 1)
        self.assertEqual(_count(self.db, "memories", "agent_id", "dave"), 1)

    def test_fk_clean_after_apply(self):
        _run_cli(self.db, "--apply")
        c = sqlite3.connect(self.db)
        c.execute("PRAGMA foreign_keys=ON")
        viol = c.execute("PRAGMA foreign_key_check").fetchall()
        c.close()
        self.assertEqual(viol, [], f"FK violations after remap: {viol}")

    def test_idempotent_second_apply_zero_changes(self):
        r1 = _run_cli(self.db, "--apply")
        self.assertEqual(r1.returncode, 0, r1.stderr)
        r2 = _run_cli(self.db, "--apply")
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertIn("identity cells remapped: 0", r2.stdout)
        self.assertIn("noa agents row inserted: False", r2.stdout)
        # counts stable after 2nd run
        self.assertEqual(_count(self.db, "memories", "agent_id", "marveen"), 0)
        self.assertEqual(_count(self.db, "memories", "agent_id", "noa"), 2)

    def test_missing_db_errors(self):
        r = _run_cli(os.path.join(self.d, "nope.db"), "--apply")
        self.assertEqual(r.returncode, 2)

    def test_refuses_live_store_noa_db_path(self):
        # defense in depth: a path ending in store/noa.db is rejected.
        live_like = os.path.join(self.d, "store", "noa.db")
        os.makedirs(os.path.dirname(live_like), exist_ok=True)
        _make_db(live_like)
        r = _run_cli(live_like, "--apply")
        self.assertEqual(r.returncode, 2)
        self.assertIn("store/noa.db", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
