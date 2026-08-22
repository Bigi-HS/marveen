#!/usr/bin/env python3
"""Wiring tests: the manual/on-demand vault readers must resolve the LIVE DB
(card 57480c07 PR3b). vault-lint-layer2.py and generate-concept-index.py read the
memories table; before the retire both defaulted to the FROZEN store/claudeclaw.db
-> stale lint / stale concept-index, and would break when the file is archived.

Run: python3 scripts/test_manual_readers_dbpath.py
"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # so the loaded modules can `from db_resolve import ...`


def _load(mod_name, filename):
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class VaultLintDbPathTest(unittest.TestCase):
    def setUp(self):
        self.vl2 = _load("vault_lint_layer2", "vault-lint-layer2.py")

    def test_db_path_is_not_frozen_legacy(self):
        self.assertFalse(self.vl2.DB_PATH.endswith("claudeclaw.db"))

    def test_db_path_resolves_live_noa_under_root(self):
        self.assertTrue(self.vl2.DB_PATH.endswith("noa.db"))
        self.assertTrue(os.path.isabs(self.vl2.DB_PATH))
        self.assertTrue(self.vl2.DB_PATH.startswith(self.vl2.PROJECT_ROOT + os.sep))


class ConceptIndexDbPathTest(unittest.TestCase):
    def setUp(self):
        self.gci = _load("generate_concept_index", "generate-concept-index.py")

    def test_default_db_path_is_not_frozen_legacy(self):
        got = self.gci.default_db_path()
        self.assertFalse(got.endswith("claudeclaw.db"))

    def test_default_db_path_resolves_live_noa(self):
        got = self.gci.default_db_path()
        self.assertTrue(got.endswith("noa.db"))
        self.assertTrue(os.path.isabs(got))


if __name__ == "__main__":
    unittest.main()
