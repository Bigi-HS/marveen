#!/usr/bin/env python3
"""Hermetic tests for scripts/migrate-kanban-timestamps.py.

Run: python3 scripts/__tests__/migrate-kanban-timestamps.test.py

All tests build a synthetic SQLite db in a temp dir; no live db is touched.
The expected epoch values for ISO strings are constructed independently here
(via the stdlib) so the test does not just mirror the script's own logic.
"""
import importlib.util
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

_HERE = Path(__file__).resolve().parent
_SCRIPT = _HERE.parent / "migrate-kanban-timestamps.py"

_spec = importlib.util.spec_from_file_location("migrate_kanban_timestamps", _SCRIPT)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

BUDAPEST = ZoneInfo("Europe/Budapest")

# --- truth values built independently of the module under test -------------
NAIVE_ISO = "2026-06-10 17:35:14"
NAIVE_EPOCH = int(datetime(2026, 6, 10, 17, 35, 14, tzinfo=BUDAPEST).timestamp())
TZ_ISO = "2026-06-09T11:07:42.173895+02:00"
TZ_EPOCH = int(datetime.fromisoformat(TZ_ISO).timestamp())
MS_VALUE = 1780837074631
MS_EPOCH = 1780837074
S_VALUE = 1780602975


def _make_db(rows):
    """rows: list of (id, created_at, updated_at). Returns db path in a fresh tmp dir."""
    d = tempfile.mkdtemp()
    path = os.path.join(d, "k.db")
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, "
        "created_at, updated_at)"
    )
    for i, (cid, c, u) in enumerate(rows):
        con.execute(
            "INSERT INTO kanban_cards (id, title, created_at, updated_at) VALUES (?,?,?,?)",
            (cid, f"card{i}", c, u),
        )
    con.commit()
    con.close()
    return path


def _read(path, col):
    con = sqlite3.connect(path)
    out = [r[0] for r in con.execute(f"SELECT {col} FROM kanban_cards ORDER BY id")]
    con.close()
    return out


class ToEpochTests(unittest.TestCase):
    def test_epoch_ms_floored_to_seconds(self):
        self.assertEqual(mod.to_epoch_s(MS_VALUE)[0], MS_EPOCH)

    def test_epoch_s_unchanged(self):
        self.assertEqual(mod.to_epoch_s(S_VALUE)[0], S_VALUE)

    def test_naive_iso_interpreted_as_budapest(self):
        self.assertEqual(mod.to_epoch_s(NAIVE_ISO)[0], NAIVE_EPOCH)

    def test_tzaware_iso_uses_offset(self):
        self.assertEqual(mod.to_epoch_s(TZ_ISO)[0], TZ_EPOCH)

    def test_none_returns_none(self):
        self.assertIsNone(mod.to_epoch_s(None)[0])

    def test_small_number_skipped(self):
        val, reason = mod.to_epoch_s(12345)
        self.assertIsNone(val)
        self.assertIn("small", reason)

    def test_garbage_string_skipped_not_raised(self):
        val, reason = mod.to_epoch_s("definitely not a date")
        self.assertIsNone(val)
        self.assertIn("parse", reason)


class AnalyzeTests(unittest.TestCase):
    def test_distribution_counts_formats(self):
        path = _make_db([
            ("a", S_VALUE, MS_VALUE),
            ("b", NAIVE_ISO, TZ_ISO),
        ])
        con = sqlite3.connect(path)
        report = mod.analyze(con)
        con.close()
        # created_at: one epoch_s, one iso ; updated_at: one epoch_ms, one iso
        self.assertEqual(report["columns"]["created_at"]["dist"].get("epoch_s"), 1)
        self.assertEqual(report["columns"]["created_at"]["dist"].get("iso"), 1)
        self.assertEqual(report["columns"]["updated_at"]["dist"].get("epoch_ms"), 1)


class ApplyTests(unittest.TestCase):
    def test_mixed_normalized_to_epoch_s(self):
        path = _make_db([
            ("a", S_VALUE, MS_VALUE),
            ("b", NAIVE_ISO, TZ_ISO),
        ])
        con = sqlite3.connect(path)
        mod.apply(con, mod.analyze(con))
        con.commit()
        con.close()
        self.assertEqual(_read(path, "created_at"), [S_VALUE, NAIVE_EPOCH])
        self.assertEqual(_read(path, "updated_at"), [MS_EPOCH, TZ_EPOCH])

    def test_idempotent_second_apply_changes_nothing(self):
        path = _make_db([("a", NAIVE_ISO, MS_VALUE)])
        con = sqlite3.connect(path)
        mod.apply(con, mod.analyze(con))
        con.commit()
        after_first = (_read(path, "created_at"), _read(path, "updated_at"))
        report2 = mod.analyze(con)
        changed2 = mod.apply(con, report2)
        con.commit()
        after_second = (_read(path, "created_at"), _read(path, "updated_at"))
        con.close()
        self.assertEqual(after_first, after_second)
        self.assertEqual(changed2, 0)

    def test_parse_fail_row_skipped_others_normalized(self):
        path = _make_db([
            ("a", "garbage-not-a-date", MS_VALUE),
            ("b", NAIVE_ISO, S_VALUE),
        ])
        con = sqlite3.connect(path)
        mod.apply(con, mod.analyze(con))
        con.commit()
        con.close()
        # row a created_at unparseable -> left intact; its updated_at still normalized
        self.assertEqual(_read(path, "created_at"), ["garbage-not-a-date", NAIVE_EPOCH])
        self.assertEqual(_read(path, "updated_at"), [MS_EPOCH, S_VALUE])


class DryRunTests(unittest.TestCase):
    def test_dry_run_does_not_mutate(self):
        path = _make_db([("a", NAIVE_ISO, MS_VALUE)])
        before = (_read(path, "created_at"), _read(path, "updated_at"))
        rc = mod.main(["--db", path])  # no --apply
        after = (_read(path, "created_at"), _read(path, "updated_at"))
        self.assertEqual(before, after)
        self.assertEqual(rc, 0)

    def test_apply_creates_backup(self):
        path = _make_db([("a", NAIVE_ISO, MS_VALUE)])
        rc = mod.main(["--db", path, "--apply"])
        self.assertTrue(os.path.exists(path + ".bak"))
        self.assertEqual(rc, 0)
        self.assertEqual(_read(path, "created_at"), [NAIVE_EPOCH])


if __name__ == "__main__":
    unittest.main(verbosity=2)
