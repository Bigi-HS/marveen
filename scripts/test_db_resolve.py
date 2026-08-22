#!/usr/bin/env python3
"""Tests for the shared live-DB resolver (scripts/db_resolve.py, card 57480c07).

Run: python3 scripts/test_db_resolve.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db_resolve import resolve_default_db  # noqa: E402


class ResolveDefaultDbTest(unittest.TestCase):
    ROOT = "/proj/root"

    def _default(self):
        return os.path.join(self.ROOT, "store", "noa.db")

    def test_honors_noa_db_path(self):
        got = resolve_default_db({"NOA_DB_PATH": "store/noa.db"}, self.ROOT)
        self.assertEqual(got, os.path.join(self.ROOT, "store", "noa.db"))

    def test_unset_falls_back_to_noa(self):
        self.assertEqual(resolve_default_db({}, self.ROOT), self._default())

    def test_blank_falls_back_to_noa(self):
        self.assertEqual(resolve_default_db({"NOA_DB_PATH": "   "}, self.ROOT), self._default())

    def test_non_db_target_rejected(self):
        self.assertEqual(
            resolve_default_db({"NOA_DB_PATH": "store/evil.txt"}, self.ROOT), self._default()
        )

    def test_root_escape_rejected(self):
        self.assertEqual(
            resolve_default_db({"NOA_DB_PATH": "../outside.db"}, self.ROOT), self._default()
        )

    def test_absolute_in_root_honored(self):
        got = resolve_default_db({"NOA_DB_PATH": "/proj/root/store/noa.db"}, self.ROOT)
        self.assertEqual(got, "/proj/root/store/noa.db")

    def test_absolute_outside_root_rejected(self):
        self.assertEqual(
            resolve_default_db({"NOA_DB_PATH": "/etc/passwd.db"}, self.ROOT), self._default()
        )

    def test_never_frozen_db_when_cutover_active(self):
        got = resolve_default_db({"NOA_DB_PATH": "store/noa.db"}, self.ROOT)
        self.assertFalse(got.endswith("claudeclaw.db"))
        self.assertTrue(got.endswith("noa.db"))

    def test_default_project_root_is_repo_root(self):
        # Omitting project_root resolves to <scripts/..>/store/noa.db (repo root).
        got = resolve_default_db({})
        self.assertTrue(got.endswith(os.path.join("store", "noa.db")))
        self.assertTrue(os.path.isabs(got))


if __name__ == "__main__":
    unittest.main()
