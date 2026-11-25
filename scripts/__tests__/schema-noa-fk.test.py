#!/usr/bin/env python3
"""P3 acceptance tests (card ff80db66 / 26ba217a, M3 FK-ON) for the canonical
fresh-DB DDL in scripts/schema-noa.sql (AC-M3-6).

A FRESHLY created DB (built the way the app boots a new noa.db -- via
scripts/schema-noa.sql, the file migrate-to-noa.py applies) MUST already declare
the 4 agents-FKs, so a from-scratch DB matches a migrated one. Without this a
fresh DB drifts back to no-FK.

The 4 target columns:
  * kanban_cards.assignee   -> REFERENCES agents(agent_id)  (NULLABLE)
  * memories.agent_id       -> NOT NULL REFERENCES agents(agent_id)
  * agent_messages.from_agent -> NOT NULL REFERENCES agents(agent_id)
  * agent_tokens.agent_id   -> NOT NULL REFERENCES agents(agent_id)

The `agents` dim-table MUST be declared BEFORE the referencing tables: with
foreign_keys=ON a FK to a non-existent table raises `no such table: agents` on
any insert (proven in recon), which would brick a fresh DB. Ordering is part of
the contract.

Run: python3 scripts/__tests__/schema-noa-fk.test.py
"""
import os
import sqlite3
import tempfile
import unittest

SCHEMA_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "schema-noa.sql"
)

FK_TABLES = {
    "kanban_cards": "assignee",
    "memories": "agent_id",
    "agent_messages": "from_agent",
    "agent_tokens": "agent_id",
}


def _fresh_db(path: str) -> sqlite3.Connection:
    """Build a brand-new DB from the canonical schema file, the same way a
    from-scratch noa.db is materialized, then open it with FK enforcement ON
    (what noa-db.ts / db.ts do at connection init)."""
    con = sqlite3.connect(path)
    with open(SCHEMA_PATH, "r", encoding="utf-8") as fh:
        con.executescript(fh.read())
    con.execute("PRAGMA foreign_keys = ON")
    return con


def _seed_agent(con: sqlite3.Connection, agent_id: str = "dave") -> None:
    con.execute(
        "INSERT INTO agents (agent_id, display, created_at) VALUES (?, ?, ?)",
        (agent_id, agent_id.capitalize(), 1),
    )


class SchemaNoaFkTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self._tmp.close()
        self.path = self._tmp.name
        self.con = _fresh_db(self.path)

    def tearDown(self) -> None:
        try:
            self.con.close()
        finally:
            os.unlink(self.path)

    # --- AC-M3-6: the 4 FKs are declared on a FRESH DB -------------------------

    def test_agents_table_exists_on_fresh_db(self) -> None:
        """Precondition for every FK: the referenced dim-table must be present."""
        rows = self.con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
        ).fetchall()
        self.assertEqual(len(rows), 1, "agents dim-table missing from schema-noa.sql")

    def test_agents_declared_before_referencing_tables(self) -> None:
        """Ordering contract: `agents` CREATE must appear before any of the 4
        referencing tables, else a fresh DB bricks on first insert."""
        with open(SCHEMA_PATH, "r", encoding="utf-8") as fh:
            sql = fh.read().lower()
        agents_pos = sql.find("create table agents")
        if agents_pos < 0:
            agents_pos = sql.find("create table if not exists agents")
        self.assertGreaterEqual(agents_pos, 0, "no CREATE TABLE agents found")
        for tbl in FK_TABLES:
            tbl_pos = sql.find(f"create table {tbl}")
            if tbl_pos < 0:
                tbl_pos = sql.find(f"create table if not exists {tbl}")
            self.assertGreaterEqual(tbl_pos, 0, f"no CREATE TABLE {tbl} found")
            self.assertLess(
                agents_pos,
                tbl_pos,
                f"agents must be declared before {tbl} (FK target ordering)",
            )

    def test_each_table_declares_agents_fk(self) -> None:
        """PRAGMA foreign_key_list must include an agents-FK on the right column."""
        for tbl, col in FK_TABLES.items():
            fks = self.con.execute(f"PRAGMA foreign_key_list({tbl})").fetchall()
            # row: (id, seq, table, from, to, on_update, on_delete, match)
            agents_fks = [f for f in fks if f[2] == "agents" and f[3] == col]
            self.assertEqual(
                len(agents_fks),
                1,
                f"{tbl}.{col} missing agents-FK (got {fks})",
            )
            # bare REFERENCES: NO ACTION on both sides (matches parent_id precedent)
            self.assertEqual(agents_fks[0][5], "NO ACTION", f"{tbl} on_update drift")
            self.assertEqual(agents_fks[0][6], "NO ACTION", f"{tbl} on_delete drift")

    # --- enforcement: orphan blocked, valid allowed ----------------------------

    def test_orphan_insert_blocked_on_each_table(self) -> None:
        """Dangerous-direction: an agent_id not in agents must raise IntegrityError
        (FK actually enforced on a fresh DB)."""
        self._orphan_assert("kanban_cards", "INSERT INTO kanban_cards (id, title, status, assignee, created_at, updated_at) VALUES ('c-orphan','t','planned','ghost',1,1)")
        self._orphan_assert("memories", "INSERT INTO memories (agent_id, category, content, created_at, accessed_at) VALUES ('ghost','hot','x',1,1)")
        self._orphan_assert("agent_messages", "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES ('ghost','dave','x','pending',1)")
        self._orphan_assert("agent_tokens", "INSERT INTO agent_tokens (agent_id, token_sha256, scopes_json, created_at) VALUES ('ghost','sha-x','[]',1)")

    def _orphan_assert(self, tbl: str, sql: str) -> None:
        with self.assertRaises(sqlite3.IntegrityError, msg=f"{tbl} orphan not blocked"):
            self.con.execute(sql)
        self.con.rollback()

    def test_valid_insert_succeeds_on_each_table(self) -> None:
        """No false-positive block: a seeded agent_id is accepted."""
        _seed_agent(self.con, "dave")
        self.con.execute("INSERT INTO kanban_cards (id, title, status, assignee, created_at, updated_at) VALUES ('c-ok','t','planned','dave',1,1)")
        self.con.execute("INSERT INTO memories (agent_id, category, content, created_at, accessed_at) VALUES ('dave','hot','x',1,1)")
        self.con.execute("INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES ('dave','dave','x','pending',1)")
        self.con.execute("INSERT INTO agent_tokens (agent_id, token_sha256, scopes_json, created_at) VALUES ('dave','sha-ok','[]',1)")
        self.con.commit()
        self.assertEqual(self.con.execute("SELECT count(*) FROM kanban_cards").fetchone()[0], 1)

    # --- T-FK11: nullable assignee FK ------------------------------------------

    def test_null_assignee_insert_succeeds(self) -> None:
        """kanban_cards.assignee is nullable; a bare REFERENCES must still permit
        NULL (SQLite FK allows NULL child values). Guards a future NOT NULL drift
        silently breaking unassigned cards."""
        self.con.execute("INSERT INTO kanban_cards (id, title, status, assignee, created_at, updated_at) VALUES ('c-null','t','planned',NULL,1,1)")
        self.con.commit()
        row = self.con.execute("SELECT assignee FROM kanban_cards WHERE id='c-null'").fetchone()
        self.assertIsNone(row[0])

    # --- T-FK10: structural integrity ------------------------------------------

    def test_integrity_check_ok_on_fresh_db(self) -> None:
        """PRAGMA integrity_check must return 'ok' on the fresh DB (catches
        structural corruption the FK-check alone misses)."""
        res = self.con.execute("PRAGMA integrity_check").fetchone()
        self.assertEqual(res[0], "ok")

    def test_foreign_key_check_clean_on_fresh_db(self) -> None:
        """No orphan rows on a fresh (empty) DB."""
        self.assertEqual(self.con.execute("PRAGMA foreign_key_check").fetchall(), [])

    # --- preservation: existing objects still present --------------------------

    def test_kanban_self_fks_preserved(self) -> None:
        """parent_id + depends_on self-FKs on kanban_cards must survive alongside
        the new agents-FK."""
        fks = self.con.execute("PRAGMA foreign_key_list(kanban_cards)").fetchall()
        self_fk_cols = {f[3] for f in fks if f[2] == "kanban_cards"}
        self.assertIn("parent_id", self_fk_cols)
        self.assertIn("depends_on", self_fk_cols)

    def test_memories_fts_triggers_preserved(self) -> None:
        """memories_fts virtual table + its 3 sync triggers must still exist, and
        FTS must stay in sync after an insert through the FK'd table."""
        triggers = {
            r[0]
            for r in self.con.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memories_fts_%'"
            ).fetchall()
        }
        self.assertEqual(
            triggers,
            {"memories_fts_insert", "memories_fts_delete", "memories_fts_update"},
        )
        _seed_agent(self.con, "dave")
        self.con.execute("INSERT INTO memories (agent_id, category, content, created_at, accessed_at) VALUES ('dave','hot','needleword',1,1)")
        self.con.commit()
        hit = self.con.execute(
            "SELECT m.id FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH 'needleword'"
        ).fetchall()
        self.assertEqual(len(hit), 1, "FTS trigger did not index the inserted row")

    def test_agent_tokens_unique_preserved(self) -> None:
        """UNIQUE(token_sha256) on agent_tokens must survive the FK addition."""
        _seed_agent(self.con, "dave")
        self.con.execute("INSERT INTO agent_tokens (agent_id, token_sha256, scopes_json, created_at) VALUES ('dave','dup-sha','[]',1)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.con.execute("INSERT INTO agent_tokens (agent_id, token_sha256, scopes_json, created_at) VALUES ('dave','dup-sha','[]',2)")
        self.con.rollback()


if __name__ == "__main__":
    unittest.main(verbosity=2)
