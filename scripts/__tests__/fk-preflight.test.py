#!/usr/bin/env python3
"""Hermetic tests for scripts/migration/fk-preflight.py (card 26ba217a, M0).

Every test builds a synthetic SQLite DB in a temp dir and a synthetic roster
dir; the live store/noa.db and the live agents/ tree are NEVER touched.

Assertion-direction discipline (spec section 7, Thor): we assert the DANGEROUS
direction -- that orphans ARE detected and that a mutation WOULD be refused
(DB mtime does NOT change) -- not only the happy path.

Run:
    python3 scripts/__tests__/fk-preflight.test.py
    pytest scripts/__tests__/fk-preflight.test.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SCRIPT = _HERE.parent / "migration" / "fk-preflight.py"

_spec = importlib.util.spec_from_file_location("fk_preflight", _SCRIPT)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


# --- fixture builders ------------------------------------------------------
def _make_db(
    tmp: Path,
    *,
    kanban_assignees=("dave", "fake-admin"),
    memory_agents=("marveen", "scout"),
    message_from=("dave", "dave-expired"),
    token_agents=("thor",),
) -> Path:
    """Build a fixture DB whose 4 core tables mirror the live column names."""
    db = tmp / "fixture.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE kanban_cards (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, assignee TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
          category TEXT NOT NULL, content TEXT NOT NULL,
          created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL
        );
        CREATE TABLE agent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE agent_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
          token_sha256 TEXT NOT NULL UNIQUE, scopes_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        """
    )
    now = 1700000000
    for i, a in enumerate(kanban_assignees):
        con.execute(
            "INSERT INTO kanban_cards VALUES (?,?,?,?,?)",
            (f"c{i}", f"card {i}", a, now, now),
        )
    # a NULL assignee must NOT be treated as an orphan
    con.execute(
        "INSERT INTO kanban_cards VALUES (?,?,?,?,?)", ("cnull", "unassigned", None, now, now)
    )
    for a in memory_agents:
        con.execute(
            "INSERT INTO memories (agent_id,category,content,created_at,accessed_at) VALUES (?,?,?,?,?)",
            (a, "hot", "x", now, now),
        )
    for a in message_from:
        con.execute(
            "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) VALUES (?,?,?,?,?)",
            (a, "marveen", "x", "pending", now),
        )
    for i, a in enumerate(token_agents):
        con.execute(
            "INSERT INTO agent_tokens (agent_id,token_sha256,scopes_json,created_at) VALUES (?,?,?,?)",
            (a, f"sha{i}", "[]", now),
        )
    con.commit()
    con.close()
    return db


def _make_roster(tmp: Path, names=("dave", "marveen", "scout", "thor")) -> Path:
    """Build an agents/ dir where each name has an agent-config.json.

    Note: 'marveen' is NOT written as a config dir -- it is the root-only
    orchestrator the script injects. We include it here only if asked, to prove
    the root-only path works even when the dir is absent.
    """
    agents = tmp / "agents"
    agents.mkdir()
    for name in names:
        if name == "marveen":
            continue  # intentionally omit: script must add it via ROOT_ONLY_AGENTS
        d = agents / name
        d.mkdir()
        (d / "agent-config.json").write_text(json.dumps({"displayName": name}))
    return agents


class OrphanDetection(unittest.TestCase):
    def test_orphans_are_detected_positive(self):
        """DANGEROUS-direction: fake-admin + dave-expired MUST be reported as orphans."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(tmp)
            agents = _make_roster(tmp)
            report, roster = mod.run_census(db, agents)
            orphans = mod.all_orphans(report)
            self.assertIn("fake-admin", orphans)
            self.assertIn("dave-expired", orphans)
            # legit roster members must NOT be flagged
            self.assertNotIn("dave", orphans)
            self.assertNotIn("scout", orphans)
            self.assertNotIn("thor", orphans)
            # marveen (root-only, no config dir) is in the roster -> not orphan
            self.assertIn("marveen", roster)
            self.assertNotIn("marveen", orphans)

    def test_null_agent_id_is_not_an_orphan(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(tmp)
            agents = _make_roster(tmp)
            report, _ = mod.run_census(db, agents)
            kanban = next(e for e in report if e["table"] == "kanban_cards")
            self.assertNotIn(None, kanban["distinct"])
            self.assertNotIn("None", kanban["orphans"])

    def test_clean_db_has_no_orphans(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(
                tmp,
                kanban_assignees=("dave",),
                memory_agents=("marveen",),
                message_from=("scout",),
                token_agents=("thor",),
            )
            agents = _make_roster(tmp)
            report, _ = mod.run_census(db, agents)
            self.assertEqual(mod.all_orphans(report), set())


class CoverageT3(unittest.TestCase):
    def test_report_covers_all_four_core_tables_not_a_sample(self):
        """T3: the report enumerates ALL four named core tables, every run."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(tmp)
            agents = _make_roster(tmp)
            report, _ = mod.run_census(db, agents)
            covered = {(e["table"], e["column"]) for e in report}
            expected = {
                ("kanban_cards", "assignee"),
                ("memories", "agent_id"),
                ("agent_messages", "from_agent"),
                ("agent_tokens", "agent_id"),
            }
            self.assertEqual(covered, expected)
            self.assertEqual(len(report), 4)

    def test_missing_core_table_still_appears_in_report(self):
        """Even if a core table is absent, the report must still list it (coverage,
        not a silent skip)."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = tmp / "partial.db"
            con = sqlite3.connect(db)
            con.executescript(
                """
                CREATE TABLE memories (
                  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT,
                  content TEXT, created_at INTEGER, accessed_at INTEGER
                );
                INSERT INTO memories (id,agent_id,category,content,created_at,accessed_at)
                VALUES (1,'ghost-agent','hot','x',1,1);
                """
            )
            con.commit()
            con.close()
            agents = _make_roster(tmp)
            report, _ = mod.run_census(db, agents)
            tables = {e["table"]: e for e in report}
            self.assertEqual(set(tables), {t for t, _ in mod.CORE_TABLES})
            self.assertFalse(tables["kanban_cards"]["present"])
            self.assertTrue(tables["memories"]["present"])
            self.assertIn("ghost-agent", tables["memories"]["orphans"])


class DryRunT6(unittest.TestCase):
    def _mtime(self, p: Path) -> float:
        return p.stat().st_mtime_ns

    def test_run_census_does_not_change_db_mtime(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(tmp)
            agents = _make_roster(tmp)
            before = self._mtime(db)
            time.sleep(0.01)
            mod.run_census(db, agents)
            mod.run_census(db, agents)
            self.assertEqual(before, self._mtime(db), "run_census must not write the DB")

    def test_cli_without_apply_leaves_db_mtime_unchanged(self):
        """T6: running the script (no --apply) must NOT change the DB mtime."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(tmp)
            agents = _make_roster(tmp)
            before = self._mtime(db)
            time.sleep(0.01)
            r = subprocess.run(
                [sys.executable, str(_SCRIPT), "--db", str(db), "--agents-dir", str(agents)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(before, self._mtime(db))
            self.assertIn("fake-admin", r.stdout)

    def test_cli_with_apply_also_leaves_db_mtime_unchanged(self):
        """DANGEROUS-direction: even passing --apply (a would-be mutate flag) must
        NOT write in M0 -- M0 has no mutating code path."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(tmp)
            agents = _make_roster(tmp)
            before = self._mtime(db)
            time.sleep(0.01)
            r = subprocess.run(
                [
                    sys.executable,
                    str(_SCRIPT),
                    "--db",
                    str(db),
                    "--agents-dir",
                    str(agents),
                    "--apply",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(before, self._mtime(db), "--apply must be a no-op in M0")

    def test_db_opened_read_only_rejects_writes(self):
        """Second line of defence: the connection the script uses is mode=ro, so a
        write WOULD raise. Prove the RO-open refuses a mutation."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(tmp)
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    con.execute("DELETE FROM memories")
            finally:
                con.close()


class JsonAndExit(unittest.TestCase):
    def test_json_output_lists_orphans(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(tmp)
            agents = _make_roster(tmp)
            r = subprocess.run(
                [
                    sys.executable,
                    str(_SCRIPT),
                    "--db",
                    str(db),
                    "--agents-dir",
                    str(agents),
                    "--json",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            payload = json.loads(r.stdout)
            self.assertEqual(len(payload["tables"]), 4)
            self.assertIn("fake-admin", payload["all_orphans"])
            self.assertIn("dave-expired", payload["all_orphans"])

    def test_missing_db_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            r = subprocess.run(
                [
                    sys.executable,
                    str(_SCRIPT),
                    "--db",
                    str(tmp / "nope.db"),
                    "--agents-dir",
                    str(agents),
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
