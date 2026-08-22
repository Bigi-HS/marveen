#!/usr/bin/env python3
"""Unit tests for ledger_lib live-DB resolution (noa.db cutover, card 88849f24).

Before this change ledger_lib.db_path() hard-coded store/claudeclaw.db. After the
server cutover (NOA_DB_PATH -> store/noa.db, loaded from .env via dotenv-preload)
that left every ledger / memory-replay / hot-cache hook reading the FROZEN legacy
DB: the ledger writer stayed on claudeclaw.db while memories/kanban went live on
noa.db -- a split-brain. The hooks run WITHOUT the server's dotenv-preload, so
db_path() must resolve the same live DB the server does, reading NOA_DB_PATH from
the environment OR from <install>/.env, with the identical .db + containment guard
(mirrors src/db-path.ts resolveNoaDbPath), and fail-open to the legacy default on
a bad value (a hook must never throw and break session start).
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


class ResolveLiveDbTest(unittest.TestCase):
    """Pure precedence + guard logic (no filesystem / no real .env)."""

    INSTALL = "/opt/noa"
    # Post-retire (card 57480c07): the fail-open default is the LIVE noa.db, not
    # the frozen claudeclaw.db -- a misconfigured NOA_DB_PATH must never route the
    # ledger back to the frozen legacy DB.
    DEFAULT = os.path.join("/opt/noa", "store", "noa.db")

    def r(self, ledger_override, noa_setting):
        return ledger_lib._resolve_live_db(ledger_override, noa_setting, self.INSTALL)

    def test_ledger_override_wins_over_everything(self):
        self.assertEqual(self.r("/tmp/x.db", "store/noa.db"), "/tmp/x.db")

    def test_noa_relative_resolves_under_install(self):
        self.assertEqual(self.r(None, "store/noa.db"), os.path.join(self.INSTALL, "store", "noa.db"))

    def test_unset_falls_back_to_noa_default(self):
        self.assertEqual(self.r(None, None), self.DEFAULT)

    def test_blank_falls_back_to_default(self):
        self.assertEqual(self.r(None, "   "), self.DEFAULT)

    def test_non_db_suffix_falls_back_to_default(self):
        # A misconfigured non-.db value must not be opened; fail-open to default.
        self.assertEqual(self.r(None, "store/noa.sqlite"), self.DEFAULT)

    def test_traversal_escape_falls_back_to_default(self):
        # `../` escaping the install root is rejected (matches server guard).
        self.assertEqual(self.r(None, "../evil.db"), self.DEFAULT)

    def test_absolute_out_of_root_falls_back_to_default(self):
        self.assertEqual(self.r(None, "/etc/passwd.db"), self.DEFAULT)

    def test_absolute_in_root_is_accepted(self):
        inroot = os.path.join(self.INSTALL, "store", "noa.db")
        self.assertEqual(self.r(None, inroot), inroot)

    def test_sibling_root_prefix_is_rejected(self):
        # "/opt/noa-evil/x.db" shares the "/opt/noa" prefix but is NOT under it.
        self.assertEqual(self.r(None, "/opt/noa-evil/x.db"), self.DEFAULT)


class DotenvValueTest(unittest.TestCase):
    def test_reads_value_from_env_file(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, ".env"), "w") as f:
                f.write("BOT_NAME=noa\nNOA_DB_PATH=store/noa.db\nX=y\n")
            self.assertEqual(ledger_lib._dotenv_value(d, "NOA_DB_PATH"), "store/noa.db")

    def test_missing_key_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, ".env"), "w") as f:
                f.write("BOT_NAME=noa\n")
            self.assertIsNone(ledger_lib._dotenv_value(d, "NOA_DB_PATH"))

    def test_missing_file_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(ledger_lib._dotenv_value(d, "NOA_DB_PATH"))

    def test_strips_surrounding_whitespace(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, ".env"), "w") as f:
                f.write("NOA_DB_PATH=  store/noa.db  \n")
            self.assertEqual(ledger_lib._dotenv_value(d, "NOA_DB_PATH"), "store/noa.db")


class NoaSettingPrecedenceTest(unittest.TestCase):
    """Env var beats the .env file; blank env falls through to the file."""

    def setUp(self):
        self._saved = os.environ.get("NOA_DB_PATH")
        os.environ.pop("NOA_DB_PATH", None)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("NOA_DB_PATH", None)
        else:
            os.environ["NOA_DB_PATH"] = self._saved

    def test_env_var_wins_over_dotenv(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, ".env"), "w") as f:
                f.write("NOA_DB_PATH=store/from-file.db\n")
            os.environ["NOA_DB_PATH"] = "store/from-env.db"
            self.assertEqual(ledger_lib._noa_db_setting(d), "store/from-env.db")

    def test_blank_env_falls_through_to_dotenv(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, ".env"), "w") as f:
                f.write("NOA_DB_PATH=store/from-file.db\n")
            os.environ["NOA_DB_PATH"] = "   "
            self.assertEqual(ledger_lib._noa_db_setting(d), "store/from-file.db")

    def test_no_env_no_file_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(ledger_lib._noa_db_setting(d))


class DbPathIntegrationTest(unittest.TestCase):
    def setUp(self):
        self._saved_ledger = os.environ.get("LEDGER_DB_PATH")

    def tearDown(self):
        if self._saved_ledger is None:
            os.environ.pop("LEDGER_DB_PATH", None)
        else:
            os.environ["LEDGER_DB_PATH"] = self._saved_ledger

    def test_ledger_db_path_override_still_honoured(self):
        # The existing bash suite relies on LEDGER_DB_PATH as the test seam.
        os.environ["LEDGER_DB_PATH"] = "/tmp/override-ledger.db"
        self.assertEqual(ledger_lib.db_path(), "/tmp/override-ledger.db")


if __name__ == "__main__":
    unittest.main(verbosity=2)
