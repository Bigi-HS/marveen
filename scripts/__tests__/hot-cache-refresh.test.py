#!/usr/bin/env python3
"""Tests for scripts/hot-cache-refresh.py -- topic_status block (card eaa623a9).

Covers:
  - build_hot_cache renders Téma-státusz block above Utolsó beszélgetés
  - LEZÁRT rows include source_ref
  - NYITOTT rows include blocker
  - Max 5+5, FIFO (most recent last, so last 5 survive)
  - Empty topic_status -> no Téma-státusz section
  - _load_topic_status returns (closed, open) from an in-memory SQLite
  - topic-status-write.py CLI: close, open, list, done subcommands
"""
import importlib.util
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).parent
SCRIPTS = HERE.parent
REFRESH_MOD = SCRIPTS / "hot-cache-refresh.py"
WRITER = SCRIPTS / "topic-status-write.py"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _load_refresh():
    spec = importlib.util.spec_from_file_location("hot_cache_refresh", str(REFRESH_MOD))
    mod = importlib.util.module_from_spec(spec)
    # ledger_lib is imported at module level; patch sys.path so it resolves.
    sys.path.insert(0, str(SCRIPTS / "hooks"))
    spec.loader.exec_module(mod)
    return mod


def _make_db() -> tuple[sqlite3.Connection, str]:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    con = sqlite3.connect(path)
    return con, path


def _apply_schema(con: sqlite3.Connection) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS topic_status (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id   TEXT NOT NULL,
            status     TEXT NOT NULL CHECK(status IN ('closed','open')),
            topic      TEXT NOT NULL,
            source_ref TEXT,
            blocker    TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_ts_agent ON topic_status(agent_id, status, updated_at)"
    )
    con.commit()


def _insert(con, agent_id, status, topic, source_ref=None, blocker=None, ts=None):
    t = ts or int(time.time())
    con.execute(
        "INSERT INTO topic_status(agent_id,status,topic,source_ref,blocker,created_at,updated_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (agent_id, status, topic, source_ref, blocker, t, t),
    )
    con.commit()


mod = _load_refresh()


# ---------------------------------------------------------------------------
# build_hot_cache with topic_status
# ---------------------------------------------------------------------------

class TestBuildHotCacheTopicBlock(unittest.TestCase):
    """build_hot_cache renders the Téma-státusz block correctly."""

    def _build(self, closed=None, open_=None, last_inbound=None):
        cards = []
        topics = (closed or [], open_ or [])
        return mod.build_hot_cache(
            "marveen", cards, last_inbound, time.time(), topic_status=topics
        )

    def test_no_topic_status_no_block(self):
        out = self._build()
        self.assertNotIn("Téma-státusz", out)

    def test_closed_item_renders_lezart(self):
        out = self._build(closed=[("TG9830: milestone reported", "TG9830")])
        self.assertIn("LEZÁRT", out)
        self.assertIn("TG9830: milestone reported", out)
        self.assertIn("TG9830", out)

    def test_open_item_renders_nyitott(self):
        out = self._build(open_=[("APK size decision", "Boss")])
        self.assertIn("NYITOTT", out)
        self.assertIn("APK size decision", out)
        self.assertIn("Boss", out)

    def test_block_above_utolso_beszelgetes(self):
        out = self._build(
            closed=[("some decision", "TG9999")],
            last_inbound=("hello world", "2026-11-10"),
        )
        tema_pos = out.index("Téma-státusz")
        utolso_pos = out.index("Utolsó")
        self.assertLess(tema_pos, utolso_pos, "Téma-státusz block must appear before Utolsó")

    def test_max_5_closed_fifo(self):
        # 7 closed items -> only last 5 survive
        closed = [(f"decision {i}", f"TG{9800+i}") for i in range(7)]
        out = self._build(closed=closed)
        # Items 0-1 (oldest) should be dropped; items 2-6 survive
        self.assertNotIn("decision 0", out)
        self.assertNotIn("decision 1", out)
        for i in range(2, 7):
            self.assertIn(f"decision {i}", out)

    def test_max_5_open_fifo(self):
        open_ = [(f"question {i}", f"Boss{i}") for i in range(7)]
        out = self._build(open_=open_)
        self.assertNotIn("question 0", out)
        self.assertNotIn("question 1", out)
        for i in range(2, 7):
            self.assertIn(f"question {i}", out)

    def test_mixed_closed_and_open(self):
        out = self._build(
            closed=[("Build complete", "commit abc1234")],
            open_=[("Gate pending", "buster CI")],
        )
        self.assertIn("LEZÁRT", out)
        self.assertIn("NYITOTT", out)

    def test_no_source_ref_still_renders(self):
        # source_ref is None -> renders without pointer (application-layer concern)
        out = self._build(closed=[("some decision", None)])
        self.assertIn("LEZÁRT", out)
        self.assertIn("some decision", out)

    # --- eb45c3c2: ref/blocker sanitization ---

    def test_ref_newline_collapsed(self):
        # source_ref with embedded newline must be collapsed to a single space
        out = self._build(closed=[("Build merged", "commit\nabc1234")])
        self.assertNotIn("commit\nabc1234", out)
        self.assertIn("commit abc1234", out)

    def test_blocker_newline_collapsed(self):
        out = self._build(open_=[("Gate pending", "buster\nCI")])
        self.assertNotIn("buster\nCI", out)
        self.assertIn("buster CI", out)

    def test_ref_length_capped(self):
        long_ref = "x" * (mod.REF_CHARS + 50)
        out = self._build(closed=[("some decision", long_ref)])
        # The ref in the output must not exceed REF_CHARS + ellipsis
        self.assertIn("…", out)
        # The raw oversized string must not appear verbatim
        self.assertNotIn(long_ref, out)

    def test_blocker_length_capped(self):
        long_blocker = "y" * (mod.REF_CHARS + 50)
        out = self._build(open_=[("some question", long_blocker)])
        self.assertIn("…", out)
        self.assertNotIn(long_blocker, out)

    def test_respects_content_char_limit(self):
        # Even with many topic items the total content stays under CONTENT_CHAR_LIMIT
        closed = [(f"{'x' * 80} decision {i}", f"TG{9800+i}") for i in range(5)]
        open_ = [(f"{'y' * 80} question {i}", f"Boss{i}") for i in range(5)]
        out = self._build(closed=closed, open_=open_)
        self.assertLessEqual(len(out), mod.CONTENT_CHAR_LIMIT + len("\n[truncated]\n"))


# ---------------------------------------------------------------------------
# _load_topic_status
# ---------------------------------------------------------------------------

class TestLoadTopicStatus(unittest.TestCase):
    def setUp(self):
        self.con, self.db_path = _make_db()
        _apply_schema(self.con)

    def tearDown(self):
        self.con.close()
        os.unlink(self.db_path)

    def test_empty_db_returns_empty_lists(self):
        closed, open_ = mod._load_topic_status("marveen", self.db_path)
        self.assertEqual(closed, [])
        self.assertEqual(open_, [])

    def test_loads_closed_with_source_ref(self):
        _insert(self.con, "marveen", "closed", "Build MERGED", source_ref="commit abc1234")
        closed, open_ = mod._load_topic_status("marveen", self.db_path)
        self.assertEqual(len(closed), 1)
        self.assertEqual(closed[0][0], "Build MERGED")
        self.assertEqual(closed[0][1], "commit abc1234")

    def test_loads_open_with_blocker(self):
        _insert(self.con, "marveen", "open", "Gate pending", blocker="buster CI")
        closed, open_ = mod._load_topic_status("marveen", self.db_path)
        self.assertEqual(len(open_), 1)
        self.assertEqual(open_[0][0], "Gate pending")
        self.assertEqual(open_[0][1], "buster CI")

    def test_scoped_to_agent(self):
        _insert(self.con, "dave", "closed", "Dave-only decision", source_ref="TG9000")
        _insert(self.con, "marveen", "closed", "Marveen decision", source_ref="TG9001")
        closed, _ = mod._load_topic_status("marveen", self.db_path)
        topics = [row[0] for row in closed]
        self.assertIn("Marveen decision", topics)
        self.assertNotIn("Dave-only decision", topics)

    def test_returns_last_5_closed_ordered(self):
        # Insert 7 closed; _load_topic_status returns last 5 by updated_at
        base_ts = int(time.time())
        for i in range(7):
            _insert(self.con, "marveen", "closed", f"decision {i}",
                    source_ref=f"TG{9800+i}", ts=base_ts + i)
        closed, _ = mod._load_topic_status("marveen", self.db_path)
        self.assertEqual(len(closed), 5)
        topics = [row[0] for row in closed]
        self.assertNotIn("decision 0", topics)
        self.assertNotIn("decision 1", topics)
        for i in range(2, 7):
            self.assertIn(f"decision {i}", topics)

    def test_missing_db_returns_empty(self):
        closed, open_ = mod._load_topic_status("marveen", "/nonexistent/path.db")
        self.assertEqual(closed, [])
        self.assertEqual(open_, [])


# ---------------------------------------------------------------------------
# topic-status-write.py CLI
# ---------------------------------------------------------------------------

class TestTopicStatusWriteCLI(unittest.TestCase):
    def setUp(self):
        self.con, self.db_path = _make_db()
        _apply_schema(self.con)

    def tearDown(self):
        self.con.close()
        os.unlink(self.db_path)

    def _run(self, *args):
        env = {**os.environ, "TOPIC_STATUS_DB": self.db_path}
        result = subprocess.run(
            [sys.executable, str(WRITER), *args],
            capture_output=True, text=True, env=env,
        )
        return result

    def test_close_command_inserts_closed_row(self):
        r = self._run("marveen", "close", "Build MERGED", "commit abc1234")
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = self.con.execute(
            "SELECT status, topic, source_ref FROM topic_status WHERE agent_id='marveen'"
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], "closed")
        self.assertEqual(rows[0][1], "Build MERGED")
        self.assertEqual(rows[0][2], "commit abc1234")

    def test_open_command_inserts_open_row(self):
        r = self._run("marveen", "open", "Gate pending", "buster CI")
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = self.con.execute(
            "SELECT status, topic, blocker FROM topic_status WHERE agent_id='marveen'"
        ).fetchall()
        self.assertEqual(rows[0][0], "open")
        self.assertEqual(rows[0][2], "buster CI")

    def test_list_command_prints_rows(self):
        _insert(self.con, "marveen", "closed", "Done thing", source_ref="TG9900")
        _insert(self.con, "marveen", "open", "Pending thing", blocker="Boss")
        r = self._run("marveen", "list")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Done thing", r.stdout)
        self.assertIn("Pending thing", r.stdout)

    def test_done_command_removes_row(self):
        _insert(self.con, "marveen", "open", "Pending thing", blocker="Boss")
        row_id = self.con.execute(
            "SELECT id FROM topic_status WHERE topic='Pending thing'"
        ).fetchone()[0]
        r = self._run("marveen", "done", str(row_id))
        self.assertEqual(r.returncode, 0, r.stderr)
        remaining = self.con.execute(
            "SELECT id FROM topic_status WHERE id=?", (row_id,)
        ).fetchone()
        self.assertIsNone(remaining)

    def test_close_requires_source_ref(self):
        # Omitting source_ref should fail (exit non-zero)
        r = self._run("marveen", "close", "Build MERGED")
        self.assertNotEqual(r.returncode, 0)

    def test_open_requires_blocker(self):
        r = self._run("marveen", "open", "Gate pending")
        self.assertNotEqual(r.returncode, 0)

    def test_unknown_subcommand_exits_nonzero(self):
        r = self._run("marveen", "bogus")
        self.assertNotEqual(r.returncode, 0)

    # --- eb45c3c2: write-side sanitization ---

    def test_close_sanitizes_source_ref_newline(self):
        # Newlines in source_ref must be collapsed to space on write
        r = self._run("marveen", "close", "Build merged", "commit\nabc1234")
        self.assertEqual(r.returncode, 0, r.stderr)
        row = self.con.execute(
            "SELECT source_ref FROM topic_status WHERE agent_id='marveen'"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertNotIn("\n", row[0])
        self.assertIn("commit abc1234", row[0])

    def test_open_sanitizes_blocker_newline(self):
        r = self._run("marveen", "open", "Gate pending", "buster\nCI")
        self.assertEqual(r.returncode, 0, r.stderr)
        row = self.con.execute(
            "SELECT blocker FROM topic_status WHERE agent_id='marveen'"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertNotIn("\n", row[0])
        self.assertIn("buster CI", row[0])

    def test_close_caps_long_source_ref(self):
        long_ref = "x" * 200
        r = self._run("marveen", "close", "some topic", long_ref)
        self.assertEqual(r.returncode, 0, r.stderr)
        row = self.con.execute(
            "SELECT source_ref FROM topic_status WHERE agent_id='marveen'"
        ).fetchone()
        self.assertLessEqual(len(row[0]), 83)  # REF_CHARS=80 + "…" (3-byte UTF-8)

    def test_open_caps_long_blocker(self):
        long_blocker = "y" * 200
        r = self._run("marveen", "open", "some question", long_blocker)
        self.assertEqual(r.returncode, 0, r.stderr)
        row = self.con.execute(
            "SELECT blocker FROM topic_status WHERE agent_id='marveen'"
        ).fetchone()
        self.assertLessEqual(len(row[0]), 83)


if __name__ == "__main__":
    unittest.main()
