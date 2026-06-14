#!/usr/bin/env python3
"""Tests for scripts/bond_db.py -- the bond.db schema initialiser.

Asserts all six authoritative tables exist with the spec's key columns, that
init is idempotent, and that a freshly initialised db is empty (so the digest
hook reports "first session"). Run: python3 scripts/__tests__/bond-db.test.py
"""
import importlib.util
import os
import sqlite3
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.normpath(os.path.join(HERE, "..", "bond_db.py"))

spec = importlib.util.spec_from_file_location("bond_db", MODULE_PATH)
bond_db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bond_db)


def columns(con, table):
    return {row[1] for row in con.execute(f"PRAGMA table_info({table})").fetchall()}


def table_names(con):
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    return {r[0] for r in rows}


class BondDbSchemaTest(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        os.unlink(self.path)  # init_db should create it
        bond_db.init_db(self.path)
        self.con = sqlite3.connect(self.path)

    def tearDown(self):
        self.con.close()
        if os.path.exists(self.path):
            os.unlink(self.path)

    def test_all_six_tables_exist(self):
        names = table_names(self.con)
        for t in bond_db.TABLES:
            self.assertIn(t, names, f"missing table {t}")
        self.assertEqual(len(bond_db.TABLES), 6)

    def test_sessions_columns(self):
        self.assertEqual(
            columns(self.con, "sessions"),
            {"id", "started_at", "ended_at", "type", "turn_count", "format_cycle"},
        )

    def test_lessons_columns(self):
        self.assertEqual(
            columns(self.con, "lessons"),
            {"id", "session_id", "topic", "homework_text", "next_lesson_date",
             "format_cycle", "created_at"},
        )

    def test_corrections_columns_include_review_due_epoch(self):
        cols = columns(self.con, "corrections")
        self.assertEqual(
            cols,
            {"id", "session_id", "turn_ts", "error_text", "corrected_form",
             "category", "review_due_epoch"},
        )

    def test_vocab_columns(self):
        self.assertEqual(
            columns(self.con, "vocab"),
            {"id", "word", "context_sentence", "review_due_epoch", "interval_days"},
        )

    def test_baseline_assessment_columns(self):
        self.assertEqual(
            columns(self.con, "baseline_assessment"),
            {"skill", "level", "notes", "assessed_at"},
        )

    def test_daily_check_columns(self):
        self.assertEqual(
            columns(self.con, "daily_check"),
            {"id", "date", "duolingo_reported", "notes"},
        )

    def test_fresh_db_is_empty(self):
        for t in bond_db.TABLES:
            n = self.con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            self.assertEqual(n, 0, f"{t} should start empty")

    def test_init_is_idempotent(self):
        # Insert a row, re-run init, row must survive and no error raised.
        self.con.execute(
            "INSERT INTO sessions (started_at, type) VALUES (?, ?)", (100, "diagnostic")
        )
        self.con.commit()
        bond_db.init_db(self.path)  # second run
        n = self.con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        self.assertEqual(n, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
