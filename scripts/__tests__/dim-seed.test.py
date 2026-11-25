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
        expected = {
            "dampier",
            "hibiki",
            "gourmet",
            "kerrigan",
            "gelim",
            "blackbart",
            "servo-skull",
        }
        self.assertEqual(set(mod.CONFIGLESS_REAL_AGENTS), expected)
        for a in expected:
            self.assertFalse(mod.is_quarantined(a), f"{a} must not be quarantined")

    def test_only_synthetic_fixtures_are_quarantined(self):
        """Reclassification (card cfeb868b): quarantine now holds ONLY the two
        synthetic test fixtures. service/owner ids are SEEDED, not quarantined."""
        self.assertEqual(set(mod.QUARANTINE_IDS), {"fake-admin", "dave-expired"})
        for ident in ("fake-admin", "dave-expired"):
            self.assertTrue(mod.is_quarantined(ident), f"{ident} must be quarantined")
        for ident in ("server", "gate", "fleet-supervisor", "appletype", "dominik"):
            self.assertFalse(
                mod.is_quarantined(ident), f"{ident} must NOT be quarantined anymore"
            )

    def test_kind_for_classification(self):
        """kind_for: owner for dominik, service for the 4 service ids, else agent."""
        self.assertEqual(mod.kind_for("dominik"), "owner")
        for ident in ("gate", "server", "fleet-supervisor", "appletype"):
            self.assertEqual(mod.kind_for(ident), "service", f"{ident} must be service")
        for ident in ("dave", "scout", "marveen", "blackbart", "servo-skull"):
            self.assertEqual(mod.kind_for(ident), "agent", f"{ident} must be agent")

    def test_dominik_seeded_as_owner_not_quarantined(self):
        """(b) dominik is seeded with kind='owner' and is NOT in QUARANTINE_IDS."""
        self.assertNotIn("dominik", mod.QUARANTINE_IDS)
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            rows = {r["agent_id"]: r for r in mod.build_seed_rows(agents, db)}
            self.assertIn("dominik", rows, "dominik must be seeded")
            self.assertEqual(rows["dominik"]["kind"], "owner")

    def test_service_ids_seeded_with_kind_service(self):
        """(c) gate/server/fleet-supervisor/appletype are seeded with
        kind='service'; a DB carrying their historical rows yields fk_uncovered=[]
        because they are now genuinely seeded (not quarantine-skipped)."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(
                tmp,
                kanban_assignees=("dave", "gate", "appletype"),
                message_from=("dave", "server", "fleet-supervisor"),
                token_agents=("thor",),
            )
            rows = {r["agent_id"]: r for r in mod.build_seed_rows(agents, db)}
            for ident in ("gate", "server", "fleet-supervisor", "appletype"):
                self.assertIn(ident, rows, f"{ident} must be seeded")
                self.assertEqual(rows[ident]["kind"], "service")
            uncovered = mod.fk_uncovered_core_ids(agents, db)
            self.assertEqual(uncovered, set(), f"uncovered: {sorted(uncovered)}")

    def test_fk_uncovered_honesty_not_via_quarantine_skip(self):
        """(e) a DB whose only orphans are dominik/gate/etc yields fk_uncovered=[]
        GENUINELY (because seeded), NOT because quarantine skips them."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp, names=("dave",))
            db = _make_db(
                tmp,
                kanban_assignees=("dominik", "gate"),
                memory_agents=("server", "appletype"),
                message_from=("fleet-supervisor",),
                token_agents=("dave",),
            )
            for ident in ("dominik", "gate", "server", "appletype", "fleet-supervisor"):
                self.assertFalse(mod.is_quarantined(ident))
            uncovered = mod.fk_uncovered_core_ids(agents, db)
            self.assertEqual(uncovered, set(), f"uncovered: {sorted(uncovered)}")

    def test_routable_agent_ids_excludes_service_and_owner(self):
        """(g) routable_agent_ids returns kind='agent' rows only -- gate/server/
        fleet-supervisor/appletype/dominik are EXCLUDED (security invariant)."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            mod.run_seed(db, agents, apply=True)
            routable = mod.routable_agent_ids(db)
            for ident in ("gate", "server", "fleet-supervisor", "appletype", "dominik"):
                self.assertNotIn(ident, routable, f"{ident} must NOT be routable")
            for ident in ("dave", "scout", "marveen"):
                self.assertIn(ident, routable, f"{ident} must be routable")

    def test_blackbart_and_servo_skull_are_real_agents_not_quarantined(self):
        """Reversed classification (card 5fd6853b): blackbart (248 actor-rows)
        and servo-skull (56 incl agent_tokens.agent_id) are class-(b) real
        agents, NOT quarantined. Quarantining them would make M3 FK-ON reject
        their legit rows."""
        for ident in ("blackbart", "servo-skull"):
            self.assertFalse(
                mod.is_quarantined(ident), f"{ident} must NOT be quarantined"
            )
            self.assertEqual(
                mod.normalize_id(ident), ident, f"{ident} must normalize to itself"
            )
            self.assertIn(ident, mod.CONFIGLESS_REAL_AGENTS)
            self.assertNotIn(ident, mod.QUARANTINE_IDS)

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

    def test_dryrun_covers_blackbart_and_servo_skull_as_seeded(self):
        """Dry-run (apply=False) with blackbart + servo-skull present as live
        core-table actor-rows: they must be SEEDED (in seed_rows) and ABSENT
        from quarantined, and fk_uncovered must be empty. Reversed from the old
        quarantine classification (card 5fd6853b)."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(
                tmp,
                memory_agents=("marveen", "genesis", "scout", "blackbart"),
                token_agents=("thor", "fake-admin", "dave-expired", "servo-skull"),
            )
            res = mod.run_seed(db, agents, apply=False)
            self.assertFalse(res["apply"])
            self.assertEqual(
                res["fk_uncovered"],
                [],
                f"fk_uncovered must be empty, got {res['fk_uncovered']}",
            )
            seeded = {r["agent_id"] for r in res["seed_rows"]}
            for ident in ("blackbart", "servo-skull"):
                self.assertIn(ident, seeded, f"{ident} must be in seed_rows")
                self.assertNotIn(
                    ident, res["quarantined"], f"{ident} must not be quarantined"
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

    def test_snapshot_file_is_mode_0600(self):
        """The pre-apply snapshot of noa.db (which holds tokens) must be written
        with restrictive 0600 perms, not world/group readable."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents, db = self._seed_table(tmp)
            snap = mod._snapshot(db)
            self.assertTrue(snap.is_file(), "snapshot must exist")
            mode = snap.stat().st_mode & 0o777
            self.assertEqual(
                mode, 0o600, f"snapshot perms must be 0600, got {oct(mode)}"
            )

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


# --- quarantine honesty + purge (card cfeb868b) ----------------------------
class QuarantineViolations(unittest.TestCase):
    def test_live_rows_detected_for_fixtures(self):
        """(a) quarantine_ids_with_live_rows reports the synthetic fixtures with
        correct per-(table,col) counts when they own live rows."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(
                tmp,
                kanban_assignees=("dave", "fake-admin"),
                memory_agents=("scout", "fake-admin"),
                message_from=("dave",),
                token_agents=("thor", "fake-admin", "dave-expired"),
            )
            viol = mod.quarantine_ids_with_live_rows(db)
            self.assertIn("fake-admin", viol)
            self.assertIn("dave-expired", viol)
            self.assertEqual(viol["fake-admin"]["kanban_cards.assignee"], 1)
            self.assertEqual(viol["fake-admin"]["memories.agent_id"], 1)
            self.assertEqual(viol["fake-admin"]["agent_tokens.agent_id"], 1)
            self.assertEqual(viol["dave-expired"]["agent_tokens.agent_id"], 1)
            # only >0 entries present
            self.assertNotIn("agent_messages.from_agent", viol["fake-admin"])

    def test_clean_db_has_no_violations(self):
        """(a) a DB with no fixture rows -> empty."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            db = _make_db(
                tmp,
                kanban_assignees=("dave",),
                memory_agents=("scout",),
                message_from=("dave",),
                token_agents=("thor",),
            )
            self.assertEqual(mod.quarantine_ids_with_live_rows(db), {})

    def test_dryrun_reports_purge_plan_but_does_not_delete(self):
        """(d-dry) dry-run includes purge_plan + quarantine_violations, deletes
        nothing."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)  # token_agents default has fake-admin + dave-expired
            res = mod.run_seed(db, agents, apply=False)
            self.assertIn("quarantine_violations", res)
            self.assertIn("purge_plan", res)
            self.assertIn("fake-admin", res["purge_plan"])
            self.assertEqual(res.get("purged", 0), 0)
            # nothing deleted in dry-run
            self.assertNotEqual(mod.quarantine_ids_with_live_rows(db), {})

    def test_apply_purges_fixtures_and_is_idempotent(self):
        """(d) apply deletes the fixture rows across the 4 core tables; purged
        count matches; re-run purges 0 (idempotent); post-apply violations empty."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(
                tmp,
                kanban_assignees=("dave", "fake-admin"),
                memory_agents=("scout", "dave-expired"),
                message_from=("dave", "fake-admin"),
                token_agents=("thor", "fake-admin", "dave-expired"),
            )
            before = mod.quarantine_ids_with_live_rows(db)
            expected = sum(sum(v.values()) for v in before.values())
            self.assertEqual(expected, 5)
            res = mod.run_seed(db, agents, apply=True)
            self.assertEqual(res["purged"], expected)
            # fixture rows gone from every core table
            con = sqlite3.connect(db)
            try:
                for ident in ("fake-admin", "dave-expired"):
                    for tbl, col in mod.CORE_TABLES:
                        n = con.execute(
                            f"SELECT COUNT(*) FROM {tbl} WHERE {col}=?", (ident,)
                        ).fetchone()[0]
                        self.assertEqual(n, 0, f"{ident} still in {tbl}.{col}")
            finally:
                con.close()
            self.assertEqual(mod.quarantine_ids_with_live_rows(db), {})
            # idempotent: second apply purges 0
            res2 = mod.run_seed(db, agents, apply=True)
            self.assertEqual(res2["purged"], 0)
            self.assertEqual(res2["quarantine_violations"], {})


# --- misclassification fail-closed guard (card 5dd2d982) -------------------
class MisclassificationGuard(unittest.TestCase):
    """A quarantined id that OWNS live FK-target rows but is NOT a synthetic
    fixture (SYNTHETIC_FIXTURES) is a REAL actor wrongly quarantined
    (the blackbart/servo-skull class bug). The seed must catch this at seed-time
    and fail CLOSED -- never silently purge a real actor's historical rows."""

    def _patch_quarantine(self, extra):
        """Temporarily add `extra` ids to QUARANTINE_IDS WITHOUT touching the
        production membership, so the misclassification path can be exercised
        against a real-actor id that is NOT a synthetic fixture."""
        saved = mod.QUARANTINE_IDS
        mod.QUARANTINE_IDS = tuple(saved) + tuple(extra)
        return saved

    def test_synthetic_fixtures_allowlist_is_the_two_fixtures(self):
        """SYNTHETIC_FIXTURES is the explicit purge-safe allowlist = exactly the
        two synthetic fixtures (today equal to QUARANTINE_IDS)."""
        self.assertEqual(
            set(mod.SYNTHETIC_FIXTURES), {"fake-admin", "dave-expired"}
        )

    def test_misclassified_real_actor_is_flagged_and_fails_closed(self):
        """RED-on-pre-fix: a quarantined id that is NOT a synthetic fixture but
        owns a live core row is MISCLASSIFIED. run_seed must surface it under
        'misclassified' and main() must exit NON-ZERO, and the row must NOT be
        deleted."""
        saved = self._patch_quarantine(("blackbart",))
        try:
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td)
                agents = _make_roster(tmp)
                db = _make_db(
                    tmp,
                    kanban_assignees=("dave", "blackbart"),
                    memory_agents=("scout",),
                    message_from=("dave",),
                    token_agents=("thor",),
                )
                res = mod.run_seed(db, agents, apply=True)
                # misclassified surfaced with the live-row census
                self.assertIn("blackbart", res.get("misclassified", {}))
                self.assertIn(
                    "kanban_cards.assignee", res["misclassified"]["blackbart"]
                )
                # the real actor's row is NOT deleted (fail-closed before purge)
                con = sqlite3.connect(db)
                try:
                    n = con.execute(
                        "SELECT COUNT(*) FROM kanban_cards WHERE assignee=?",
                        ("blackbart",),
                    ).fetchone()[0]
                finally:
                    con.close()
                self.assertEqual(n, 1, "misclassified actor row must NOT be purged")
                # main() must exit non-zero (3)
                rc = mod.main(
                    ["--db", str(db), "--agents-dir", str(agents), "--apply"]
                )
                self.assertEqual(rc, 3, "misclassification must fail closed with rc=3")
        finally:
            mod.QUARANTINE_IDS = saved

    def test_misclassified_fails_closed_in_dry_run_too(self):
        """Fail-closed happens BEFORE any write, so dry-run also returns non-zero
        when a misclassified real actor is present."""
        saved = self._patch_quarantine(("servo-skull",))
        try:
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td)
                agents = _make_roster(tmp)
                db = _make_db(
                    tmp,
                    kanban_assignees=("dave",),
                    memory_agents=("scout", "servo-skull"),
                    message_from=("dave",),
                    token_agents=("thor",),
                )
                res = mod.run_seed(db, agents, apply=False)
                self.assertIn("servo-skull", res.get("misclassified", {}))
                rc = mod.main(
                    ["--db", str(db), "--agents-dir", str(agents)]
                )
                self.assertEqual(rc, 3)
                # dry-run wrote nothing
                self.assertEqual(mod.quarantine_ids_with_live_rows(db), res.get("quarantine_violations", {}))
        finally:
            mod.QUARANTINE_IDS = saved

    def test_no_misclassification_when_all_quarantined_are_fixtures(self):
        """Preservation: with the real QUARANTINE_IDS == SYNTHETIC_FIXTURES,
        a DB whose only quarantined rows are the fixtures has an EMPTY
        misclassified set and main() returns 0."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(
                tmp,
                kanban_assignees=("dave", "fake-admin"),
                memory_agents=("scout", "dave-expired"),
                message_from=("dave",),
                token_agents=("thor",),
            )
            res = mod.run_seed(db, agents, apply=False)
            self.assertEqual(res.get("misclassified", {}), {})
            rc = mod.main(["--db", str(db), "--agents-dir", str(agents)])
            self.assertEqual(rc, 0)

    def test_purge_scoped_to_synthetic_fixtures_only(self):
        """Even if a non-fixture id were quarantined (and happened to own no
        rows, so not misclassified), the purge loop only deletes
        SYNTHETIC_FIXTURES rows -- never a blanket QUARANTINE_IDS delete."""
        saved = self._patch_quarantine(("harmless-extra",))
        try:
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td)
                agents = _make_roster(tmp)
                # harmless-extra owns NO rows -> not misclassified -> run proceeds
                db = _make_db(
                    tmp,
                    kanban_assignees=("dave", "fake-admin"),
                    memory_agents=("scout",),
                    message_from=("dave",),
                    token_agents=("thor", "dave-expired"),
                )
                res = mod.run_seed(db, agents, apply=True)
                self.assertEqual(res.get("misclassified", {}), {})
                # fixtures purged, post-apply clean
                self.assertEqual(res["quarantine_violations"], {})
        finally:
            mod.QUARANTINE_IDS = saved

    def test_post_apply_assert_nonempty_violations_returns_nonzero(self):
        """Post-apply ASSERT: if after the fixture purge
        quarantine_ids_with_live_rows is STILL non-empty, main() returns
        non-zero (hard signal the purge did not clear)."""
        saved_purge = mod._purge_fixtures

        def _noop_purge(con):  # simulate a purge that fails to clear rows
            return 0

        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(
                tmp,
                kanban_assignees=("dave", "fake-admin"),
                memory_agents=("scout",),
                message_from=("dave",),
                token_agents=("thor",),
            )
            mod._purge_fixtures = _noop_purge
            try:
                res = mod.run_seed(db, agents, apply=True)
                # purge was neutered -> fixture row still present
                self.assertNotEqual(res["quarantine_violations"], {})
                rc = mod.main(["--db", str(db), "--agents-dir", str(agents), "--apply"])
                self.assertEqual(rc, 3)
            finally:
                mod._purge_fixtures = saved_purge

    def test_synthetic_fixtures_allowlist_is_exact(self):
        """Trust-anchor pin: SYNTHETIC_FIXTURES is the purge-safe allowlist --
        _purge_fixtures deletes rows ONLY for ids in it. Its membership is PINNED
        to exactly ("fake-admin", "dave-expired"), no more and no fewer. Any future
        change to this allowlist MUST be a conscious, reviewed edit, because adding
        a real actor id here would silently purge that actor's historical rows --
        exactly the data-loss this guard exists to prevent."""
        # Order-insensitive but EXACT membership (no extra, no missing).
        self.assertEqual(
            set(mod.SYNTHETIC_FIXTURES),
            {"fake-admin", "dave-expired"},
            "SYNTHETIC_FIXTURES membership drifted -- this is the purge trust-anchor",
        )
        self.assertEqual(
            len(mod.SYNTHETIC_FIXTURES),
            2,
            "SYNTHETIC_FIXTURES must contain exactly two ids (no duplicates/extras)",
        )

    def test_no_real_actor_can_enter_purge_allowlist(self):
        """Load-bearing invariant: SYNTHETIC_FIXTURES must be DISJOINT from the
        seeded real-agent roster. A real seeded actor can never fall into the purge
        bag -- if any seeded agent_id appeared in SYNTHETIC_FIXTURES it would be
        silently purged on the next --apply run."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            seed_rows = mod.build_seed_rows(agents, db)
            seeded_ids = {r["agent_id"] for r in seed_rows}
            self.assertEqual(
                set(mod.SYNTHETIC_FIXTURES) & seeded_ids,
                set(),
                "a seeded real actor must never be in the purge allowlist: "
                f"overlap={sorted(set(mod.SYNTHETIC_FIXTURES) & seeded_ids)}",
            )


# --- kind column DDL (card cfeb868b) ---------------------------------------
class KindColumn(unittest.TestCase):
    def test_create_agents_sql_has_kind_column(self):
        """(f) CREATE_AGENTS_SQL creates a table with a 'kind' column."""
        self.assertIn("kind", mod.CREATE_AGENTS_SQL)
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "k.db"
            con = sqlite3.connect(db)
            try:
                con.execute(mod.CREATE_AGENTS_SQL)
                cols = {r[1] for r in con.execute("PRAGMA table_info(agents)").fetchall()}
                self.assertIn("kind", cols)
            finally:
                con.close()

    def test_kind_default_is_agent(self):
        """(f) inserting without kind defaults to 'agent'."""
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "k.db"
            con = sqlite3.connect(db)
            try:
                con.execute(mod.CREATE_AGENTS_SQL)
                con.execute(
                    "INSERT INTO agents (agent_id, display, created_at) VALUES (?,?,?)",
                    ("x", "X", 1),
                )
                kind = con.execute("SELECT kind FROM agents WHERE agent_id='x'").fetchone()[0]
                self.assertEqual(kind, "agent")
            finally:
                con.close()

    def test_bogus_kind_raises_check(self):
        """(f) kind='bogus' violates the CHECK constraint."""
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "k.db"
            con = sqlite3.connect(db)
            try:
                con.execute(mod.CREATE_AGENTS_SQL)
                with self.assertRaises(sqlite3.IntegrityError):
                    con.execute(
                        "INSERT INTO agents (agent_id, display, created_at, kind) VALUES (?,?,?,?)",
                        ("y", "Y", 1, "bogus"),
                    )
            finally:
                con.close()

    def test_seeded_rows_carry_correct_kind(self):
        """(c/b) after apply, the dim-table rows carry the right kind per id."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            mod.run_seed(db, agents, apply=True)
            con = sqlite3.connect(db)
            try:
                kinds = dict(con.execute("SELECT agent_id, kind FROM agents").fetchall())
            finally:
                con.close()
            self.assertEqual(kinds.get("dominik"), "owner")
            for ident in ("gate", "server", "fleet-supervisor", "appletype"):
                self.assertEqual(kinds.get(ident), "service", f"{ident}")
            self.assertEqual(kinds.get("dave"), "agent")


if __name__ == "__main__":
    unittest.main(verbosity=2)
