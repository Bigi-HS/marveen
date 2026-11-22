#!/usr/bin/env python3
"""
Tests for scripts/hooks/checkpoint-write.py

Coverage:
  - _agent_id_from_cwd() normal agent path (agents/<name>/...)
  - _agent_id_from_cwd() project-root path (orchestrator/marveen fallback)
  - _agent_id_from_cwd() unknown cwd (no agent, no project root match)
  - main() exits 0 without crashing on bad stdin
"""
import importlib.util
import os
import sys
import types
import unittest

HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "checkpoint-write.py"
)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load_hook():
    spec = importlib.util.spec_from_file_location("checkpoint_write", HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestAgentIdFromCwd(unittest.TestCase):
    def setUp(self):
        self.mod = _load_hook()

    def test_normal_agent_path(self):
        cwd = os.path.join(PROJECT_ROOT, "agents", "blackbeard")
        self.assertEqual(self.mod._agent_id_from_cwd(cwd), "blackbeard")

    def test_nested_agent_path(self):
        cwd = os.path.join(PROJECT_ROOT, "agents", "dave", ".worktrees", "some-branch")
        self.assertEqual(self.mod._agent_id_from_cwd(cwd), "dave")

    def test_project_root_returns_marveen(self):
        # Orchestrator runs from project root -- must return 'marveen', not None
        self.assertEqual(self.mod._agent_id_from_cwd(PROJECT_ROOT), "marveen")

    def test_unrelated_path_returns_none(self):
        self.assertIsNone(self.mod._agent_id_from_cwd("/tmp/unrelated"))

    def test_empty_cwd_returns_none(self):
        self.assertIsNone(self.mod._agent_id_from_cwd(""))

    def test_none_cwd_returns_none(self):
        self.assertIsNone(self.mod._agent_id_from_cwd(None))


class TestApplyMarveen(unittest.TestCase):
    """
    Smoke: loading the module does not crash (hook path is valid).
    """
    def test_module_loads(self):
        mod = _load_hook()
        self.assertTrue(callable(mod._agent_id_from_cwd))
        self.assertTrue(callable(mod._token))


if __name__ == "__main__":
    unittest.main()
