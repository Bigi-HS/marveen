#!/usr/bin/env python3
"""Tests for Medic bot's DB-path resolution (card 57480c07 retire).

Medic's Executor.query() reads the LIVE agent_messages table (probe_stuck's
stuck-message diagnosis). Before the retire, DB_PATH hardcoded the FROZEN
store/claudeclaw.db -> stuck-diagnosis saw a stale/empty table (split-brain).
The resolver honors NOA_DB_PATH (the cutover live DB) and fails open to the
LIVE store/noa.db, never the frozen legacy DB.

Run: python3 scripts/test_medic_bot_dbpath.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import bot  # noqa: E402


class ResolveDefaultDbTest(unittest.TestCase):
    ROOT = "/proj/root"

    def _default(self):
        return os.path.join(self.ROOT, "store", "noa.db")

    def test_honors_noa_db_path(self):
        got = bot.resolve_default_db({"NOA_DB_PATH": "store/noa.db"}, self.ROOT)
        self.assertEqual(got, os.path.join(self.ROOT, "store", "noa.db"))

    def test_unset_falls_back_to_noa(self):
        self.assertEqual(bot.resolve_default_db({}, self.ROOT), self._default())

    def test_blank_falls_back_to_noa(self):
        self.assertEqual(bot.resolve_default_db({"NOA_DB_PATH": "   "}, self.ROOT), self._default())

    def test_non_db_target_rejected(self):
        self.assertEqual(
            bot.resolve_default_db({"NOA_DB_PATH": "store/evil.txt"}, self.ROOT), self._default()
        )

    def test_root_escape_rejected(self):
        self.assertEqual(
            bot.resolve_default_db({"NOA_DB_PATH": "../outside.db"}, self.ROOT), self._default()
        )

    def test_absolute_in_root_honored(self):
        got = bot.resolve_default_db({"NOA_DB_PATH": "/proj/root/store/noa.db"}, self.ROOT)
        self.assertEqual(got, "/proj/root/store/noa.db")

    def test_never_frozen_db_when_cutover_active(self):
        got = bot.resolve_default_db({"NOA_DB_PATH": "store/noa.db"}, self.ROOT)
        self.assertFalse(got.endswith("claudeclaw.db"))
        self.assertTrue(got.endswith("noa.db"))


class ModuleDefaultTest(unittest.TestCase):
    """The module-level DB_PATH the Executor reads must not point at the frozen db."""

    def test_module_db_path_is_not_frozen_legacy(self):
        self.assertFalse(bot.DB_PATH.endswith("claudeclaw.db"))

    def test_module_db_path_resolves_under_install_dir(self):
        self.assertTrue(bot.DB_PATH.startswith(bot.INSTALL_DIR + os.sep))
        self.assertTrue(bot.DB_PATH.endswith(".db"))


if __name__ == "__main__":
    unittest.main()
