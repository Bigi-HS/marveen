#!/usr/bin/env python3
"""Unit tests for the conversation_log migration (claudeclaw.db -> noa.db).

The noa.db cutover moved the server tables but left the ledger writer on
claudeclaw.db (ledger_lib hard-coded it). Flipping the hooks to noa.db without
first backfilling the post-cutover conversation_log rows would regress respawn
continuity (the fresh session would read a transcript frozen at cutover time).
This migration copies the missing rows, idempotently. The dedup key is a content
tuple, NOT the UNIQUE(agent_id,chat_id,direction,message_id) index: outbound rows
carry a NULL message_id, so an INSERT OR IGNORE would duplicate every reply on a
re-run. The content tuple (agent_id, chat_id, direction, created_at, text,
message_id) is NULL-safe and re-run safe.
"""
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402
import importlib.util  # noqa: E402

_here = os.path.dirname(os.path.abspath(__file__))
_mig_path = os.path.join(os.path.dirname(_here), "migrate-ledger-to-noa.py")
_spec = importlib.util.spec_from_file_location("migrate_ledger_to_noa", _mig_path)
migrate_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migrate_mod)


def _mkdb(path, rows):
    con = sqlite3.connect(path)
    con.execute(ledger_lib.SCHEMA)
    con.execute(ledger_lib.INDEX)
    for r in rows:
        con.execute(
            "INSERT INTO conversation_log"
            " (agent_id, chat_id, direction, message_id, text, ts, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            r,
        )
    con.commit()
    con.close()


def _count(path):
    con = sqlite3.connect(path)
    try:
        return con.execute("SELECT COUNT(*) FROM conversation_log").fetchone()[0]
    finally:
        con.close()


# (agent_id, chat_id, direction, message_id, text, ts, created_at)
IN1 = ("marveen", "42", "in", "m1", "hello", "2026-07-01T10:00:00Z", 1000)
OUT1 = ("marveen", "42", "out", None, "hi back", "2026-07-01T10:00:05Z", 1005)
IN2 = ("marveen", "42", "in", "m2", "how are you", "2026-07-01T10:01:00Z", 1060)
OUT2 = ("marveen", "42", "out", None, "fine", "2026-07-01T10:01:05Z", 1065)


class MigrateLedgerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.src = os.path.join(self.dir, "claudeclaw.db")
        self.tgt = os.path.join(self.dir, "noa.db")

    def test_copies_rows_absent_in_target(self):
        _mkdb(self.src, [IN1, OUT1, IN2, OUT2])
        _mkdb(self.tgt, [IN1, OUT1])  # target frozen at cutover: missing IN2/OUT2
        inserted = migrate_mod.migrate(self.src, self.tgt)
        self.assertEqual(inserted, 2)
        self.assertEqual(_count(self.tgt), 4)

    def test_idempotent_second_run_inserts_zero(self):
        _mkdb(self.src, [IN1, OUT1, IN2, OUT2])
        _mkdb(self.tgt, [IN1, OUT1])
        migrate_mod.migrate(self.src, self.tgt)
        second = migrate_mod.migrate(self.src, self.tgt)
        self.assertEqual(second, 0)
        self.assertEqual(_count(self.tgt), 4)

    def test_outbound_null_message_id_not_duplicated(self):
        # The core idempotency risk: NULL message_id rows must not re-insert.
        _mkdb(self.src, [OUT1, OUT2])
        _mkdb(self.tgt, [])
        self.assertEqual(migrate_mod.migrate(self.src, self.tgt), 2)
        self.assertEqual(migrate_mod.migrate(self.src, self.tgt), 0)
        self.assertEqual(_count(self.tgt), 2)

    def test_target_only_rows_untouched(self):
        tgt_only = ("hibiki", "99", "in", "h1", "keep me", "2026-06-15T00:00:00Z", 500)
        _mkdb(self.src, [IN1])
        _mkdb(self.tgt, [tgt_only])
        migrate_mod.migrate(self.src, self.tgt)
        self.assertEqual(_count(self.tgt), 2)  # tgt_only kept + IN1 added

    def test_creates_target_schema_if_missing(self):
        _mkdb(self.src, [IN1, OUT1])
        # target file does not exist yet
        inserted = migrate_mod.migrate(self.src, self.tgt)
        self.assertEqual(inserted, 2)
        self.assertEqual(_count(self.tgt), 2)

    def test_empty_source_is_noop(self):
        _mkdb(self.src, [])
        _mkdb(self.tgt, [IN1])
        self.assertEqual(migrate_mod.migrate(self.src, self.tgt), 0)
        self.assertEqual(_count(self.tgt), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
