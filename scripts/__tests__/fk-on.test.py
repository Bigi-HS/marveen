#!/usr/bin/env python3
"""Hermetic tests for scripts/migration/fk-on.py (card 26ba217a / 5fd6853b, M3).

M3 = switch the 4 core-table agent-id columns to a real
``REFERENCES agents(agent_id)`` foreign key via the canonical SQLite 12-step
table rebuild, idempotent, dry-run-first, snapshot-gated, precondition-gated.

Every test builds a synthetic SQLite DB + a synthetic roster dir in a temp dir;
the live store/noa.db and the live agents/ tree are NEVER touched. No test ever
runs the migration against the real DB or passes --apply to it.

Assertion-direction discipline (spec section 7, Thor): the load-bearing proof is
the DANGEROUS direction -- after --apply, an INSERT of an orphan agent_id MUST
raise IntegrityError (T-FK1). A test that only asserted a valid INSERT still
works (the safe side) would pass even if the FK were silently dropped.

Thor test-list (spec section 4): T-FK1..T-FK9.

Run:
    python3 scripts/__tests__/fk-on.test.py
    pytest scripts/__tests__/fk-on.test.py
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
_SCRIPT = _HERE.parent / "migration" / "fk-on.py"

_spec = importlib.util.spec_from_file_location("fk_on", _SCRIPT)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


# ---------------------------------------------------------------------------
# fixture builders -- a minimal but faithful copy of the live 4-table schema
# (the FK columns bare, as they are live pre-M3), plus the agents dim-table and
# the memories_fts external-content vtable + 3 triggers.
# ---------------------------------------------------------------------------
_PRE_FK_SCHEMA = """
CREATE TABLE kanban_cards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('low','normal','high','urgent')),
  project TEXT, parent_id TEXT REFERENCES kanban_cards(id), due_date INTEGER,
  sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, archived_at INTEGER, dispatched_at INTEGER,
  priority_score INTEGER, depends_on TEXT REFERENCES kanban_cards(id),
  code TEXT, last_moved INTEGER, parked_until INTEGER,
  boss_waiting INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_kanban_status ON kanban_cards(status, archived_at, sort_order);
CREATE INDEX idx_kanban_parent ON kanban_cards(parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  keywords    TEXT,
  topic_key   TEXT,
  access_scope TEXT,
  embedding   BLOB,
  created_at  INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'legacy'
);
CREATE INDEX idx_memories_agent_cat ON memories(agent_id, category);
CREATE INDEX idx_memories_created   ON memories(created_at);
CREATE INDEX idx_memories_accessed  ON memories(accessed_at);
CREATE INDEX idx_memories_topic     ON memories(agent_id, topic_key) WHERE topic_key IS NOT NULL;

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, keywords, content='memories', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
    VALUES('delete', old.id, old.content, old.keywords);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
    VALUES('delete', old.id, old.content, old.keywords);
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;

CREATE TABLE agent_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent        TEXT    NOT NULL,
  to_agent          TEXT    NOT NULL,
  content           TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 50,
  in_reply_to       INTEGER,
  ack_expected      INTEGER NOT NULL DEFAULT 0,
  result            TEXT,
  created_at        INTEGER NOT NULL,
  delivered_at      INTEGER,
  completed_at      INTEGER,
  last_escalated_at INTEGER
);
CREATE INDEX idx_messages_queue ON agent_messages(to_agent, status, priority DESC, id);
CREATE INDEX idx_agent_messages_status ON agent_messages(status, to_agent);
CREATE INDEX idx_agent_messages_created ON agent_messages(created_at);

CREATE TABLE agent_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  scopes_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX idx_agent_tokens_sha   ON agent_tokens(token_sha256);
CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_id);
"""

_CREATE_AGENTS = """
CREATE TABLE IF NOT EXISTS agents (
  agent_id   TEXT PRIMARY KEY,
  display    TEXT NOT NULL,
  team       TEXT, leader TEXT, model TEXT,
  domain_db  INTEGER NOT NULL DEFAULT 0,
  status     TEXT,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
"""

# roster/agents seeded into both the agents dim-table and used as FK targets.
_SEEDED = ("marveen", "dave", "scout", "thor", "chad")


def _make_roster(tmp: Path, names=_SEEDED) -> Path:
    """agents/ dir where each (non-root) name has an agent-config.json. 'marveen'
    is the root-only orchestrator dim-seed injects, so omit it from config dirs."""
    agents = tmp / "agents"
    agents.mkdir()
    for name in names:
        if name == "marveen":
            continue
        d = agents / name
        d.mkdir()
        (d / "agent-config.json").write_text(json.dumps({"displayName": name}))
    return agents


def _make_db(tmp: Path, *, name="fixture.db", seed_agents=True, extra_core=None) -> Path:
    """Build a fixture DB with the 4 pre-FK core tables + memories_fts, a seeded
    agents dim-table, and a couple of valid rows per core table. ``extra_core``
    lets a test inject an orphan row (dict: table -> list of agent-id values)
    used by the precondition test."""
    db = tmp / name
    con = sqlite3.connect(db)
    con.executescript(_PRE_FK_SCHEMA)
    con.executescript(_CREATE_AGENTS)
    now = 1700000000
    if seed_agents:
        for a in _SEEDED:
            con.execute(
                "INSERT INTO agents (agent_id, display, domain_db, created_at) "
                "VALUES (?,?,0,?)",
                (a, a, now),
            )
    # valid core rows (all agent-ids in the seeded set)
    con.execute(
        "INSERT INTO kanban_cards (id,title,assignee,parent_id,sort_order,created_at,updated_at) "
        "VALUES ('c1','root','dave',NULL,0,?,?)",
        (now, now),
    )
    con.execute(
        "INSERT INTO kanban_cards (id,title,assignee,parent_id,depends_on,sort_order,created_at,updated_at) "
        "VALUES ('c2','child','scout','c1','c1',0,?,?)",
        (now, now),
    )
    con.execute(
        "INSERT INTO kanban_cards (id,title,assignee,sort_order,created_at,updated_at) "
        "VALUES ('c3','noassignee',NULL,0,?,?)",
        (now, now),
    )
    for a, kw, body in (
        ("marveen", "alpha beta", "the quick brown fox jumps"),
        ("scout", "gamma", "lazy dog sleeps near the river"),
    ):
        con.execute(
            "INSERT INTO memories (agent_id,category,content,keywords,created_at,accessed_at) "
            "VALUES (?,?,?,?,?,?)",
            (a, "hot", body, kw, now, now),
        )
    con.execute(
        "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) "
        "VALUES ('dave','marveen','hi','pending',?)",
        (now,),
    )
    con.execute(
        "INSERT INTO agent_tokens (agent_id,token_sha256,scopes_json,created_at) "
        "VALUES ('thor','sha-thor','[]',?)",
        (now,),
    )
    if extra_core:
        for table, vals in extra_core.items():
            for v in vals:
                if table == "kanban_cards":
                    con.execute(
                        "INSERT INTO kanban_cards (id,title,assignee,sort_order,created_at,updated_at) "
                        "VALUES (?,?,?,0,?,?)",
                        (f"orphan-{v}", "orphan", v, now, now),
                    )
                elif table == "memories":
                    con.execute(
                        "INSERT INTO memories (agent_id,category,content,created_at,accessed_at) "
                        "VALUES (?,?,?,?,?)",
                        (v, "hot", "orphan", now, now),
                    )
                elif table == "agent_messages":
                    con.execute(
                        "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) "
                        "VALUES (?,?,?,?,?)",
                        (v, "marveen", "orphan", "pending", now),
                    )
                elif table == "agent_tokens":
                    con.execute(
                        "INSERT INTO agent_tokens (agent_id,token_sha256,scopes_json,created_at) "
                        "VALUES (?,?,?,?)",
                        (v, f"sha-{v}", "[]", now),
                    )
    con.commit()
    con.close()
    return db


def _fk_cols(con: sqlite3.Connection, table: str):
    """Return the set of (from_col, ref_table) foreign keys on a table."""
    return {
        (r[3], r[2])
        for r in con.execute(f"PRAGMA foreign_key_list({table})").fetchall()
    }


def _has_agents_fk(con: sqlite3.Connection, table: str, col: str) -> bool:
    return (col, "agents") in _fk_cols(con, table)


# ---------------------------------------------------------------------------
# T-FK1  -- dangerous-direction: orphan INSERT raises IntegrityError
# ---------------------------------------------------------------------------
class TFK1_DangerousDirection(unittest.TestCase):
    def test_orphan_insert_raises_after_apply(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            res = mod.run_migration(db, agents, apply=True)
            self.assertTrue(res["apply"])
            con = sqlite3.connect(db)
            con.execute("PRAGMA foreign_keys = ON")
            try:
                now = 1700000001
                # kanban_cards.assignee
                with self.assertRaises(sqlite3.IntegrityError):
                    con.execute(
                        "INSERT INTO kanban_cards (id,title,assignee,sort_order,created_at,updated_at) "
                        "VALUES ('x','x','no-such-agent',0,?,?)",
                        (now, now),
                    )
                # memories.agent_id
                with self.assertRaises(sqlite3.IntegrityError):
                    con.execute(
                        "INSERT INTO memories (agent_id,category,content,created_at,accessed_at) "
                        "VALUES ('no-such-agent','hot','x',?,?)",
                        (now, now),
                    )
                # agent_messages.from_agent
                with self.assertRaises(sqlite3.IntegrityError):
                    con.execute(
                        "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) "
                        "VALUES ('no-such-agent','marveen','x','pending',?)",
                        (now,),
                    )
                # agent_tokens.agent_id
                with self.assertRaises(sqlite3.IntegrityError):
                    con.execute(
                        "INSERT INTO agent_tokens (agent_id,token_sha256,scopes_json,created_at) "
                        "VALUES ('no-such-agent','sha-x','[]',?)",
                        (now,),
                    )
            finally:
                con.rollback()
                con.close()


# ---------------------------------------------------------------------------
# T-FK2  -- valid INSERT with a seeded agent_id still succeeds
# ---------------------------------------------------------------------------
class TFK2_ValidInsertSucceeds(unittest.TestCase):
    def test_valid_insert_succeeds(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            mod.run_migration(db, agents, apply=True)
            con = sqlite3.connect(db)
            con.execute("PRAGMA foreign_keys = ON")
            try:
                now = 1700000002
                con.execute(
                    "INSERT INTO kanban_cards (id,title,assignee,sort_order,created_at,updated_at) "
                    "VALUES ('ok','ok','dave',0,?,?)",
                    (now, now),
                )
                con.execute(
                    "INSERT INTO memories (agent_id,category,content,created_at,accessed_at) "
                    "VALUES ('scout','hot','ok',?,?)",
                    (now, now),
                )
                con.execute(
                    "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) "
                    "VALUES ('thor','marveen','ok','pending',?)",
                    (now,),
                )
                con.execute(
                    "INSERT INTO agent_tokens (agent_id,token_sha256,scopes_json,created_at) "
                    "VALUES ('chad','sha-ok','[]',?)",
                    (now,),
                )
                con.commit()
            finally:
                con.close()


# ---------------------------------------------------------------------------
# T-FK3  -- idempotency: 2x --apply, second rebuilds 0 tables
# ---------------------------------------------------------------------------
class TFK3_Idempotent(unittest.TestCase):
    def test_second_apply_rebuilds_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            first = mod.run_migration(db, agents, apply=True)
            self.assertEqual(
                sorted(first["rebuilt"]),
                ["agent_messages", "agent_tokens", "kanban_cards", "memories"],
            )
            # row counts after first
            con = sqlite3.connect(db)
            counts1 = {
                t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t, _ in mod.CORE_TABLES
            }
            fk1 = {t: _fk_cols(con, t) for t, _ in mod.CORE_TABLES}
            con.close()

            second = mod.run_migration(db, agents, apply=True)
            self.assertEqual(second["rebuilt"], [], "second run must rebuild 0 tables")
            self.assertEqual(
                sorted(second["skipped"]),
                ["agent_messages", "agent_tokens", "kanban_cards", "memories"],
            )
            con = sqlite3.connect(db)
            counts2 = {
                t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t, _ in mod.CORE_TABLES
            }
            fk2 = {t: _fk_cols(con, t) for t, _ in mod.CORE_TABLES}
            con.close()
            self.assertEqual(counts1, counts2, "row counts stable across reruns")
            self.assertEqual(fk1, fk2, "foreign_key_list stable across reruns")


# ---------------------------------------------------------------------------
# T-FK4  -- data preservation + dependent objects (self-FK, UNIQUE, CHECK)
# ---------------------------------------------------------------------------
class TFK4_Preservation(unittest.TestCase):
    def test_rowcounts_selffk_unique_check_preserved(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            con = sqlite3.connect(db)
            pre = {
                t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t, _ in mod.CORE_TABLES
            }
            sample = con.execute(
                "SELECT id,title,assignee,parent_id,depends_on FROM kanban_cards WHERE id='c2'"
            ).fetchone()
            con.close()

            mod.run_migration(db, agents, apply=True)

            con = sqlite3.connect(db)
            con.execute("PRAGMA foreign_keys = ON")
            try:
                post = {
                    t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                    for t, _ in mod.CORE_TABLES
                }
                self.assertEqual(pre, post, "row counts must be preserved")
                # sample row byte-identical round-trip
                sample2 = con.execute(
                    "SELECT id,title,assignee,parent_id,depends_on FROM kanban_cards WHERE id='c2'"
                ).fetchone()
                self.assertEqual(sample, sample2)
                # self-FK present (parent_id + depends_on -> kanban_cards)
                kfks = _fk_cols(con, "kanban_cards")
                self.assertIn(("parent_id", "kanban_cards"), kfks)
                self.assertIn(("depends_on", "kanban_cards"), kfks)
                self.assertIn(("assignee", "agents"), kfks)
                # self-FK still ENFORCED: bad parent_id raises
                with self.assertRaises(sqlite3.IntegrityError):
                    con.execute(
                        "INSERT INTO kanban_cards (id,title,assignee,parent_id,sort_order,created_at,updated_at) "
                        "VALUES ('bad','bad','dave','no-such-card',0,1,1)"
                    )
                con.rollback()
                # UNIQUE(token_sha256) preserved
                con.execute(
                    "INSERT INTO agent_tokens (agent_id,token_sha256,scopes_json,created_at) "
                    "VALUES ('dave','dup-sha','[]',1)"
                )
                with self.assertRaises(sqlite3.IntegrityError):
                    con.execute(
                        "INSERT INTO agent_tokens (agent_id,token_sha256,scopes_json,created_at) "
                        "VALUES ('scout','dup-sha','[]',1)"
                    )
                con.rollback()
                # CHECK(priority) preserved
                with self.assertRaises(sqlite3.IntegrityError):
                    con.execute(
                        "INSERT INTO kanban_cards (id,title,assignee,priority,sort_order,created_at,updated_at) "
                        "VALUES ('pbad','p','dave','bogus',0,1,1)"
                    )
                con.rollback()
                # indexes preserved
                idx = {
                    r[0]
                    for r in con.execute(
                        "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
                    ).fetchall()
                }
                for want in (
                    "idx_kanban_status",
                    "idx_kanban_parent",
                    "idx_memories_agent_cat",
                    "idx_memories_topic",
                    "idx_messages_queue",
                    "idx_agent_tokens_sha",
                    "idx_agent_tokens_agent",
                ):
                    self.assertIn(want, idx, f"index {want} must survive rebuild")
            finally:
                con.close()


# ---------------------------------------------------------------------------
# T-FK5  -- FTS intact after memories rebuild (triggers alive, in sync)
# ---------------------------------------------------------------------------
class TFK5_FtsIntact(unittest.TestCase):
    def test_fts_match_and_triggers_in_sync(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            mod.run_migration(db, agents, apply=True)
            con = sqlite3.connect(db)
            con.execute("PRAGMA foreign_keys = ON")
            try:
                # pre-existing content still searchable
                hit = con.execute(
                    "SELECT m.content FROM memories_fts f "
                    "JOIN memories m ON m.id = f.rowid "
                    "WHERE memories_fts MATCH 'brown' ORDER BY f.rowid"
                ).fetchall()
                self.assertTrue(
                    any("brown" in r[0] for r in hit),
                    f"FTS must find pre-rebuild content, got {hit}",
                )
                # INSERT trigger: new row is searchable
                con.execute(
                    "INSERT INTO memories (agent_id,category,content,keywords,created_at,accessed_at) "
                    "VALUES ('dave','hot','elephant marches slowly','pink',1,1)"
                )
                con.commit()
                ins = con.execute(
                    "SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'elephant'"
                ).fetchall()
                self.assertEqual(len(ins), 1, "INSERT trigger must sync FTS")
                rid = ins[0][0]
                # UPDATE trigger: old term gone, new term present
                con.execute("UPDATE memories SET content='tiger runs fast' WHERE id=?", (rid,))
                con.commit()
                self.assertEqual(
                    con.execute(
                        "SELECT COUNT(*) FROM memories_fts WHERE memories_fts MATCH 'elephant'"
                    ).fetchone()[0],
                    0,
                    "UPDATE trigger must drop the old term",
                )
                self.assertEqual(
                    con.execute(
                        "SELECT COUNT(*) FROM memories_fts WHERE memories_fts MATCH 'tiger'"
                    ).fetchone()[0],
                    1,
                    "UPDATE trigger must index the new term",
                )
                # DELETE trigger: term gone
                con.execute("DELETE FROM memories WHERE id=?", (rid,))
                con.commit()
                self.assertEqual(
                    con.execute(
                        "SELECT COUNT(*) FROM memories_fts WHERE memories_fts MATCH 'tiger'"
                    ).fetchone()[0],
                    0,
                    "DELETE trigger must remove the row from FTS",
                )
            finally:
                con.close()


# ---------------------------------------------------------------------------
# T-FK6  -- dry-run leaves mtime + schema unchanged, no agents-FK added
# ---------------------------------------------------------------------------
class TFK6_DryRun(unittest.TestCase):
    def test_dryrun_leaves_db_untouched(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            before_mtime = db.stat().st_mtime_ns
            before_sql = _schema_sql(db)
            time.sleep(0.01)
            res = mod.run_migration(db, agents, apply=False)
            self.assertFalse(res["apply"])
            self.assertEqual(res["rebuilt"], [])
            self.assertIsNone(res["snapshot"])
            self.assertEqual(before_mtime, db.stat().st_mtime_ns, "dry-run must not write")
            self.assertEqual(before_sql, _schema_sql(db), "dry-run must not alter schema")
            con = sqlite3.connect(db)
            try:
                for t, col in mod.CORE_TABLES:
                    self.assertFalse(
                        _has_agents_fk(con, t, col),
                        f"dry-run must not add agents-FK to {t}",
                    )
            finally:
                con.close()

    def test_cli_dryrun_mtime_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            before = db.stat().st_mtime_ns
            time.sleep(0.01)
            r = subprocess.run(
                [sys.executable, str(_SCRIPT), "--db", str(db), "--agents-dir", str(agents)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(before, db.stat().st_mtime_ns, "no --apply must not write")


def _schema_sql(db: Path) -> str:
    con = sqlite3.connect(db)
    try:
        return "\n".join(
            r[0]
            for r in con.execute(
                "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
            ).fetchall()
        )
    finally:
        con.close()


# ---------------------------------------------------------------------------
# T-FK7  -- precondition abort on injected orphan (uncovered)
# ---------------------------------------------------------------------------
class TFK7_PreconditionAbort(unittest.TestCase):
    def test_apply_refused_when_orphan_uncovered(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            # inject a legit-looking but unmapped orphan into a core table
            db = _make_db(tmp, extra_core={"memories": ["ghost-unknown-agent"]})
            before_mtime = db.stat().st_mtime_ns
            before_sql = _schema_sql(db)
            with self.assertRaises(mod.PreconditionError):
                mod.run_migration(db, agents, apply=True)
            self.assertEqual(before_mtime, db.stat().st_mtime_ns, "abort must not write")
            self.assertEqual(before_sql, _schema_sql(db), "abort must not alter schema")

    def test_apply_refused_when_agents_table_missing(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp, seed_agents=False)
            # drop the agents table entirely
            con = sqlite3.connect(db)
            con.execute("DROP TABLE agents")
            con.commit()
            con.close()
            with self.assertRaises(mod.PreconditionError):
                mod.run_migration(db, agents, apply=True)

    def test_apply_refused_when_agents_empty(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp, seed_agents=False)  # table exists but empty
            with self.assertRaises(mod.PreconditionError):
                mod.run_migration(db, agents, apply=True)

    def test_cli_precondition_abort_nonzero(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp, extra_core={"memories": ["ghost-unknown-agent"]})
            before = db.stat().st_mtime_ns
            r = subprocess.run(
                [sys.executable, str(_SCRIPT), "--db", str(db), "--agents-dir", str(agents), "--apply"],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(r.returncode, 0, "precondition abort must exit non-zero")
            self.assertEqual(before, db.stat().st_mtime_ns, "abort must not write")


# ---------------------------------------------------------------------------
# T-FK8  -- (P2) deferred: db.ts connection enforces foreign_keys=ON.
#          P2 is a separate follow-up (TS). Here we only assert the P1 contract
#          that the migration itself leaves foreign_keys ON after apply, so a
#          caller that forgets to re-enable still inherits a safe default from
#          the fresh connection (documented asymmetry).
# ---------------------------------------------------------------------------
class TFK8_ForeignKeysRestored(unittest.TestCase):
    def test_default_connection_foreign_keys_off_is_sqlite_default(self):
        # sanity: SQLite connections default foreign_keys=OFF; P2 (TS) is what
        # flips it ON for the live writer. This test documents the P1 boundary.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            mod.run_migration(db, agents, apply=True)
            con = sqlite3.connect(db)
            try:
                # a brand-new connection defaults OFF (SQLite semantics)
                self.assertEqual(
                    con.execute("PRAGMA foreign_keys").fetchone()[0],
                    0,
                    "fresh sqlite3 connection defaults foreign_keys=OFF (P2/db.ts flips it)",
                )
            finally:
                con.close()


# ---------------------------------------------------------------------------
# T-FK9  -- foreign_key_check returns 0 rows post-rebuild
# ---------------------------------------------------------------------------
class TFK9_ForeignKeyCheckClean(unittest.TestCase):
    def test_no_violations_post_rebuild(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            res = mod.run_migration(db, agents, apply=True)
            self.assertEqual(res["fk_check_violations"], 0)
            con = sqlite3.connect(db)
            try:
                violations = con.execute("PRAGMA foreign_key_check").fetchall()
                self.assertEqual(violations, [], f"foreign_key_check must be clean: {violations}")
            finally:
                con.close()


# ---------------------------------------------------------------------------
# extra: snapshot 0600 + token never printed
# ---------------------------------------------------------------------------
class SafetyBounds(unittest.TestCase):
    def test_snapshot_is_0600_and_taken_before_mutation(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agents = _make_roster(tmp)
            db = _make_db(tmp)
            res = mod.run_migration(db, agents, apply=True)
            snap = Path(res["snapshot"])
            self.assertTrue(snap.is_file(), "snapshot must exist")
            self.assertEqual(snap.stat().st_mode & 0o777, 0o600)

    def test_token_value_never_printed(self):
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
            combined = r.stdout + r.stderr
            self.assertNotIn("sha-thor", combined, "token_sha256 value must never be printed")

    def test_json_output_shape(self):
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
            for key in ("apply", "rebuilt", "skipped", "snapshot", "fk_clauses", "fk_uncovered"):
                self.assertIn(key, payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
