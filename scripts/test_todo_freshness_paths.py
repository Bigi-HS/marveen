#!/usr/bin/env python3
"""Tests for todo-freshness-check.py default path constants.

Verifies that DEFAULT_DB/DEFAULT_STATE/DEFAULT_TOKEN are __file__-relative
absolute paths (not CWD-dependent relative paths). A CWD-relative default
broke the supervisor when it ran from a non-INSTALL_DIR working directory
(card 4c90c53e, 500 failures 09-20). Run: python3 -m pytest scripts/test_todo_freshness_paths.py
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, "todo-freshness-check.py")
_spec = importlib.util.spec_from_file_location("todo_freshness_check", _MOD_PATH)
fresh = importlib.util.module_from_spec(_spec)
# Unset NOA_DB_PATH so we test the fallback, not the env override
_saved_noa_db = os.environ.pop("NOA_DB_PATH", None)
_spec.loader.exec_module(fresh)
if _saved_noa_db is not None:
    os.environ["NOA_DB_PATH"] = _saved_noa_db


class TestDefaultPaths(unittest.TestCase):
    def test_default_db_is_absolute(self):
        self.assertTrue(
            os.path.isabs(fresh.DEFAULT_DB),
            f"DEFAULT_DB should be absolute, got: {fresh.DEFAULT_DB!r}",
        )

    def test_default_db_points_to_noa_db(self):
        self.assertTrue(
            fresh.DEFAULT_DB.endswith("store/noa.db"),
            f"DEFAULT_DB should end with store/noa.db, got: {fresh.DEFAULT_DB!r}",
        )

    def test_default_state_is_absolute(self):
        self.assertTrue(
            os.path.isabs(fresh.DEFAULT_STATE),
            f"DEFAULT_STATE should be absolute, got: {fresh.DEFAULT_STATE!r}",
        )

    def test_default_token_is_absolute(self):
        self.assertTrue(
            os.path.isabs(fresh.DEFAULT_TOKEN),
            f"DEFAULT_TOKEN should be absolute, got: {fresh.DEFAULT_TOKEN!r}",
        )

    def test_paths_resolve_to_marveen_tree(self):
        install_dir = os.path.dirname(_HERE)
        self.assertTrue(
            fresh.DEFAULT_DB.startswith(install_dir),
            f"DEFAULT_DB should be under {install_dir}, got: {fresh.DEFAULT_DB!r}",
        )


if __name__ == "__main__":
    unittest.main()
