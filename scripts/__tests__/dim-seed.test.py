#!/usr/bin/env python3
"""Hermetic tests for scripts/migration/dim-seed.py (card 5fd6853b, M1).

M1 = the ``agents`` dim-table + idempotent seed, with the explicit three-class
normalize pass over the M0 live-census orphans (card 26ba217a §4.1 / §5 "M1").

Every test builds a synthetic SQLite DB + a synthetic roster dir in a temp dir;
the live store/noa.db and the live agents/ tree are NEVER touched.

Assertion-direction discipline (spec section 7, Thor): we assert the DANGEROUS
direction -- that a mutating run is REFUSED without --apply (DB mtime unchanged),
that genesis is REMAPPED (not casefolded) so a casefold bug would be caught, that
every class-(c) id stays OUT of the seed, and (the FK precondition) that after the
normalize the roster covers EVERY non-quarantined core-table agent_id so M3 FK-ON
would not reject a legit row.

Run:
    python3 scripts/__tests__/dim-seed.test.py
    pytest scripts/__tests__/dim-seed.test.py
"""
from __future__ import annotations

import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SCRIPT = _HERE.parent / "migration" / "dim-seed.py"

_spec = importlib.util.spec_from_file_location("dim_seed", _SCRIPT)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


# --- fixture builders ------------------------------------------------------
def _make_roster(tmp: Path, names=("dave", "scout", "thor", "chad")) -> Path:
    """agents/ dir where each name has an agent-config.json. 'marveen' is the
    root-only orchestrator the script injects, so it is intentionally omitted."""
    agents = tmp / "agents"
    agents.mkdir()
    for name in names:
        d = agents / name
        d.mkdir()
        (d / "agent-config.json").write_text(json.dumps({"displayName": name}))
    return agents


def _make_db(
    tmp: Path,
    *,
    kanban_assignees=("dave", "Dave", "Genesis"),
    memory_agents=("marveen", "genesis", "scout"),
    message_from=("dave", "server"),
    token_agents=("thor", "fake-admin", "dave-expired"),
) -> Path:
    """Build a fixture DB whose 4 core tables mirror the live column names, with
    representatives of all three normalize classes in the agent-id columns."""
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
    con.execute(
        "INSERT INTO kanban_cards VALUES (?,?,?,?,?)",
        ("cnull", "unassigned", None, now, now),
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


# --- normalize-class tests -------------------------------------------------
class NormalizeClasses(unittest.TestCase):
    def test_classify_case_remap(self):
        """Class (a): Dave->dave (casefold), Genesis/genesis->marveen (REMAP)."""
        self.assertEqual(mod.normalize_id("Dave"), "dave")
        self.assertEqual(mod.normalize_id("dave"), "dave")
        self.assertEqual(mod.normalize_id("Genesis"), "marveen")
        self.assertEqual(mod.normalize_id("genesis"), "marveen")

    def test_genesis_remap_is_not_casefold(self):
        """DANGEROUS-direction: a plain casefold would yield 'genesis', NOT
        'marveen'. Prove the remap target is the canonical agent, so a casefold
        regression is caught."""
        self.assertNotEqual(mod.normalize_id("Genesis"), "genesis")
        self.assertNotEqual(mod.normalize_id("genesis"), "genesis")
        self.assertEqual(mod.normalize_id("Genesis"), "marveen")

    def test_every_class_b_agent_gets_added_to_seed_source(self):
        """Class (b): config-less real agents are seeded even though they have no
        agent-config.json."""
        expected = {"dampier", "hibiki", "gourmet", "kerrigan", "gelim"}
        self.assertEqual(set(mod.CONFIGLESS_REAL_AGENTS), expected)
        for a in expected:
            self.assertFalse(mod.is_quarantined(a), f"{a} must not be quarantined")

    def test_every_class_c_id_is_quarantined(self):
        """Class (c): service/non-agent ids + test fixtures are quarantined, NOT
        seeded."""
        for ident in (
            "server",
            "gate",
            "fleet-supervisor",
            "servo-skull",
            "appletype",
            "blackbart",
            "dominik",
            "fake-admin",
            "dave-expired",
        ):
            self.assertTrue(mod.is_quarantined(ident), f"{ident} must be quarantined")

    def test_quarantined_ids_never_appear_in_seed_rows(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            rows = mod.build_seed_rows(agents, db)
            seeded = {r["agent_id"] for r in rows}
            for ident in mod.QUARANTINE_IDS:
                self.assertNotIn(ident, seeded)
            # remap: neither 'Genesis' nor 'genesis' may survive as a seeded id
            self.assertNotIn("Genesis", seeded)
            self.assertNotIn("genesis", seeded)
            # but the remap TARGET marveen is present
            self.assertIn("marveen", seeded)


# --- seed-row construction -------------------------------------------------
class SeedRows(unittest.TestCase):
    def test_class_b_present_in_seed_rows(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            rows = mod.build_seed_rows(agents, db)
            seeded = {r["agent_id"] for r in rows}
            for a in mod.CONFIGLESS_REAL_AGENTS:
                self.assertIn(a, seeded, f"class-(b) {a} must be in the seed")

    def test_config_agents_present_in_seed_rows(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp, names=("dave", "scout", "thor"))
            db = _make_db(tmp)
            rows = mod.build_seed_rows(agents, db)
            seeded = {r["agent_id"] for r in rows}
            for a in ("dave", "scout", "thor", "marveen"):
                self.assertIn(a, seeded)

    def test_fk_precondition_roster_covers_all_nonquarantined_core_ids(self):
        """The load-bearing M3 claim: after the three-class normalize, EVERY
        non-quarantined core-table agent_id maps to a seeded agent_id. If any
        legit (non-quarantined) id were missing, M3 FK-ON would reject that row."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            uncovered = mod.fk_uncovered_core_ids(agents, db)
            self.assertEqual(
                uncovered,
                set(),
                f"M3 FK-ON would reject these legit core ids: {sorted(uncovered)}",
            )

    def test_fk_precondition_fails_when_a_legit_id_is_unmapped(self):
        """DANGEROUS-direction: inject a legit (non-quarantined, non-class) core
        id with no config + no class membership -> it MUST surface as uncovered,
        proving the check is not vacuously green."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp, names=("dave",))
            db = _make_db(tmp, memory_agents=("ghost-unknown-agent",))
            uncovered = mod.fk_uncovered_core_ids(agents, db)
            self.assertIn("ghost-unknown-agent", uncovered)


# --- idempotency (apply path) ----------------------------------------------
class ApplyIdempotency(unittest.TestCase):
    def _seed_table(self, tmp: Path):
        agents = _make_roster(tmp)
        db = _make_db(tmp)
        return agents, db

    def test_apply_creates_table_and_seeds(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents, db = self._seed_table(tmp)
            res = mod.run_seed(db, agents, apply=True)
            con = sqlite3.connect(db)
            try:
                have = con.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'"
                ).fetchone()
                self.assertIsNotNone(have, "agents table must be created on --apply")
                n = con.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
            finally:
                con.close()
            self.assertGreater(n, 0)
            self.assertEqual(res["inserted"], n)

    def test_second_apply_run_inserts_zero_new_rows(self):
        """AC6 / T1 idempotency: second run upserts, 0 NEW rows."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents, db = self._seed_table(tmp)
            first = mod.run_seed(db, agents, apply=True)
            con = sqlite3.connect(db)
            try:
                count_after_first = con.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
            finally:
                con.close()
            second = mod.run_seed(db, agents, apply=True)
            con = sqlite3.connect(db)
            try:
                count_after_second = con.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
            finally:
                con.close()
            self.assertEqual(count_after_first, count_after_second)
            self.assertEqual(second["inserted"], 0, "second run must insert 0 new rows")

    def test_agent_id_is_primary_key_no_duplicates(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents, db = self._seed_table(tmp)
            mod.run_seed(db, agents, apply=True)
            mod.run_seed(db, agents, apply=True)
            con = sqlite3.connect(db)
            try:
                rows = con.execute("SELECT agent_id, COUNT(*) FROM agents GROUP BY agent_id HAVING COUNT(*) > 1").fetchall()
            finally:
                con.close()
            self.assertEqual(rows, [], "no duplicate agent_id after repeated apply")


# --- dry-run default (AC7 / T6) --------------------------------------------
class DryRunDefault(unittest.TestCase):
    def _mtime(self, p: Path) -> int:
        return p.stat().st_mtime_ns

    def test_default_run_does_not_create_table(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            mod.run_seed(db, agents, apply=False)
            con = sqlite3.connect(db)
            try:
                have = con.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'"
                ).fetchone()
            finally:
                con.close()
            self.assertIsNone(have, "dry-run must NOT create the agents table")

    def test_cli_without_apply_leaves_db_mtime_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            before = self._mtime(db)
            time.sleep(0.01)
            r = subprocess.run(
                [sys.executable, str(_SCRIPT), "--db", str(db), "--agents-dir", str(agents)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(before, self._mtime(db), "no --apply must not write the DB")

    def test_cli_with_apply_creates_snapshot_and_mutates(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            r = subprocess.run(
                [sys.executable, str(_SCRIPT), "--db", str(db), "--agents-dir", str(agents), "--apply"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            # a pre-apply snapshot must exist next to the DB
            snaps = list(tmp.glob("fixture.db.*.bak"))
            self.assertTrue(snaps, "a DB snapshot must be written before --apply")
            con = sqlite3.connect(db)
            try:
                n = con.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
            finally:
                con.close()
            self.assertGreater(n, 0)


# --- json / cli smoke ------------------------------------------------------
class CliSmoke(unittest.TestCase):
    def test_json_output_reports_classes(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            r = subprocess.run(
                [sys.executable, str(_SCRIPT), "--db", str(db), "--agents-dir", str(agents), "--json"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            payload = json.loads(r.stdout)
            self.assertIn("seed_rows", payload)
            self.assertIn("quarantined", payload)
            self.assertIn("fk_uncovered", payload)
            seeded = {row["agent_id"] for row in payload["seed_rows"]}
            self.assertIn("marveen", seeded)
            self.assertNotIn("Genesis", seeded)

    def test_missing_db_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            r = subprocess.run(
                [sys.executable, str(_SCRIPT), "--db", str(tmp / "nope.db"), "--agents-dir", str(agents)],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
