#!/usr/bin/env python3
"""Tests for ledger_lib.agent_id_from_cwd phantom-agent fix (FIX-002, 3e331d41).

The bug: agent_id_from_cwd's fallback returned os.path.basename(cwd) for
any cwd outside the install tree, which generated phantom agent IDs like
'store', 'agents', 'n8n-workflows' in the conversation_log ledger.

Fix: return main_agent_id() (not basename) for unknown cwd paths.

Run: python3 scripts/__tests__/ledger-lib-agent-id.test.py
"""

import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.normpath(os.path.join(HERE, "..", "..", "scripts", "hooks", "ledger_lib.py"))

spec_obj = importlib.util.spec_from_file_location("ledger_lib", MODULE_PATH)
ll = importlib.util.module_from_spec(spec_obj)
spec_obj.loader.exec_module(ll)

MAIN_ID = ll.main_agent_id()


class TestAgentIdFromCwd(unittest.TestCase):

    # F1: Sub-agent cwd: <install>/agents/<name> -> <name>
    def test_agents_subdir_returns_agent_name(self):
        install = ll._install_dir()
        cwd = os.path.join(install, "agents", "dave")
        self.assertEqual(ll.agent_id_from_cwd(cwd), "dave")

    # F2: Install root -> main_agent_id
    def test_install_root_returns_main(self):
        install = ll._install_dir()
        self.assertEqual(ll.agent_id_from_cwd(install), MAIN_ID)

    # F3 (the bug): cwd outside install tree -> must NOT return basename.
    # Previously returned 'store' / 'agents' / 'n8n-workflows' etc.
    def test_outside_install_returns_main_not_basename(self):
        result_store = ll.agent_id_from_cwd("/home/domin/marveen/store")
        result_wf    = ll.agent_id_from_cwd("/home/domin/marveen/n8n-workflows")
        result_tmp   = ll.agent_id_from_cwd("/tmp/random-dir")
        # Must NOT be the basename of the path
        self.assertNotEqual(result_store, "store")
        self.assertNotEqual(result_wf,    "n8n-workflows")
        self.assertNotEqual(result_tmp,   "random-dir")
        # Must be the main agent id
        self.assertEqual(result_store, MAIN_ID)
        self.assertEqual(result_wf,    MAIN_ID)
        self.assertEqual(result_tmp,   MAIN_ID)

    # F4: empty/None cwd -> main
    def test_empty_cwd_returns_main(self):
        self.assertEqual(ll.agent_id_from_cwd(""), MAIN_ID)
        self.assertEqual(ll.agent_id_from_cwd(None), MAIN_ID)


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
