#!/usr/bin/env python3
"""Tests for the scheduled-task reconcile report (GAP G4).

Run: python3 scripts/test_reconcile_scheduled_tasks.py
"""
import contextlib
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reconcile-scheduled-tasks.py")

# The module filename is hyphenated (CLI convention); load it under an
# importable name for the pure-logic tests.
_spec = importlib.util.spec_from_file_location("reconcile_scheduled_tasks", SCRIPT)
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)


class ReconcilePureTest(unittest.TestCase):
    """The set-diff logic in isolation (no I/O)."""

    def test_all_matched_no_orphans(self):
        rep = rc.reconcile({"a", "b"}, {"a": "active", "b": "paused"})
        self.assertEqual(rep["file_orphans"], [])
        self.assertEqual(rep["row_orphans"], [])
        self.assertEqual(rep["deleted_on_disk"], [])
        self.assertEqual(rep["counts"]["matched"], 2)

    def test_file_orphan_dir_without_row(self):
        rep = rc.reconcile({"a", "ghost"}, {"a": "active"})
        self.assertEqual(rep["file_orphans"], ["ghost"])
        self.assertEqual(rep["row_orphans"], [])

    def test_row_orphan_active_row_without_dir(self):
        rep = rc.reconcile({"a"}, {"a": "active", "b": "paused"})
        # b is a non-deleted row with no dir -> broken task
        self.assertEqual(rep["row_orphans"], ["b"])
        self.assertEqual(rep["file_orphans"], [])

    def test_deleted_row_without_dir_is_not_a_row_orphan(self):
        # a deleted tombstone with no dir is the EXPECTED steady state, not drift
        rep = rc.reconcile({"a"}, {"a": "active", "old": "deleted"})
        self.assertEqual(rep["row_orphans"], [])
        self.assertEqual(rep["deleted_on_disk"], [])
        self.assertEqual(rep["counts"]["db_rows_deleted"], 1)

    def test_deleted_row_with_dir_is_cosmetic(self):
        rep = rc.reconcile({"a", "old"}, {"a": "active", "old": "deleted"})
        self.assertEqual(rep["deleted_on_disk"], ["old"])
        # a deleted-on-disk is NOT a file-orphan (the row exists) nor actionable
        self.assertEqual(rep["file_orphans"], [])
        self.assertEqual(rep["row_orphans"], [])

    def test_counts_decompose_the_157_vs_213_shape(self):
        # mirror the live decomposition: rows = non-deleted + deleted,
        # dirs = matched + file-orphans
        db = {f"act{i}": "active" for i in range(155)}
        db.update({f"del{i}": "deleted" for i in range(58)})
        dirs = set(f"act{i}" for i in range(155)) | {"orphan1", "orphan2"}
        rep = rc.reconcile(dirs, db)
        c = rep["counts"]
        self.assertEqual(c["dirs"], 157)
        self.assertEqual(c["db_rows_total"], 213)
        self.assertEqual(c["db_rows_non_deleted"], 155)
        self.assertEqual(c["db_rows_deleted"], 58)
        self.assertEqual(c["matched"], 155)
        self.assertEqual(rep["file_orphans"], ["orphan1", "orphan2"])


class ReconcileIoTest(unittest.TestCase):
    """End-to-end against a temp DB + temp task dir, via the CLI."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "noa.db")
        self.tasks_dir = os.path.join(self.tmp, "scheduled-tasks")
        os.makedirs(self.tasks_dir)
        db = sqlite3.connect(self.db_path)
        db.execute(
            "CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)"
        )
        db.executemany(
            "INSERT INTO scheduled_tasks (id, status) VALUES (?, ?)",
            [("alpha", "active"), ("beta", "paused"), ("gone", "deleted"),
             ("missing-body", "active")],
        )
        db.commit()
        db.close()
        # dirs: alpha+beta have bodies (matched), extra-dir is a file-orphan,
        # missing-body row has NO dir (row-orphan), gone (deleted) has no dir.
        for name in ("alpha", "beta", "extra-dir"):
            d = Path(self.tasks_dir) / name
            d.mkdir()
            (d / "SKILL.md").write_text("---\nname: %s\n---\nbody\n" % name)
        # a dir WITHOUT SKILL.md must be ignored (not counted as a dir)
        (Path(self.tasks_dir) / "not-a-task").mkdir()

    def test_json_report_classifies_orphans(self):
        # Resolve the DB directly through the loader functions: the shared
        # resolver constrains NOA_DB_PATH to live under the project root, which
        # a tempdir is not, so we exercise the reconcile core directly here and
        # cover the full CLI (resolver + exit code) in test_missing_db below.
        dirs = rc.list_task_dirs(Path(self.tasks_dir))
        rows = rc.load_db_rows(Path(self.db_path))
        rep = rc.reconcile(dirs, rows)
        self.assertEqual(rep["file_orphans"], ["extra-dir"])
        self.assertEqual(rep["row_orphans"], ["missing-body"])
        self.assertEqual(rep["deleted_on_disk"], [])
        self.assertEqual(rep["counts"]["dirs"], 3)  # not-a-task excluded
        self.assertEqual(rep["counts"]["matched"], 2)

    def test_list_task_dirs_requires_skill_md(self):
        names = rc.list_task_dirs(Path(self.tasks_dir))
        self.assertIn("alpha", names)
        self.assertNotIn("not-a-task", names)

    def test_missing_db_returns_exit_2(self):
        # The shared resolver intentionally ignores an out-of-root NOA_DB_PATH
        # (it never reads an arbitrary DB), so force the resolver's return value
        # to a non-existent path and assert the CLI's missing-DB branch.
        missing = os.path.join(self.tmp, "nope.db")
        orig = rc.resolve_default_db
        rc.resolve_default_db = lambda: missing
        try:
            os.environ["NOA_SCHEDULED_TASKS_DIR"] = self.tasks_dir
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                code = rc.main(["--json"])
            self.assertEqual(code, 2)
            self.assertIn("error", json.loads(buf.getvalue()))
        finally:
            rc.resolve_default_db = orig
            os.environ.pop("NOA_SCHEDULED_TASKS_DIR", None)


if __name__ == "__main__":
    unittest.main()
