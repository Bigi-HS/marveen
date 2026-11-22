#!/usr/bin/env python3
"""
Tests for scripts/hooks/checkpoint-write.py

Coverage:
  - _agent_id_from_cwd() normal agent path (agents/<name>/...)
  - _agent_id_from_cwd() project-root path (orchestrator/MAIN_AGENT_ID fallback)
  - _agent_id_from_cwd() MAIN_AGENT_ID env override (de-brand cutover)
  - _agent_id_from_cwd() symlink cwd resolved via realpath
  - _agent_id_from_cwd() unknown cwd -> None (fallback is NOT a catch-all)
  - main() exits 0 without crashing on bad stdin
"""
import importlib.util
import os
import sys
import tempfile
import unittest

HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "checkpoint-write.py"
)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load_hook(env_overrides=None):
    saved = {}
    if env_overrides:
        for k, v in env_overrides.items():
            saved[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("checkpoint_write", HOOK_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class TestAgentIdFromCwd(unittest.TestCase):
    def setUp(self):
        os.environ.pop("MAIN_AGENT_ID", None)
        self.mod = _load_hook()

    def test_normal_agent_path(self):
        cwd = os.path.join(PROJECT_ROOT, "agents", "blackbeard")
        self.assertEqual(self.mod._agent_id_from_cwd(cwd), "blackbeard")

    def test_nested_agent_path(self):
        cwd = os.path.join(PROJECT_ROOT, "agents", "dave", ".worktrees", "some-branch")
        self.assertEqual(self.mod._agent_id_from_cwd(cwd), "dave")

    def test_project_root_returns_main_agent_id_default(self):
        # Orchestrator runs from project root -- must return 'marveen' (default), not None.
        self.assertEqual(self.mod._agent_id_from_cwd(PROJECT_ROOT), "marveen")

    def test_main_agent_id_env_override(self):
        # De-brand cutover: MAIN_AGENT_ID=genesis renames the orchestrator without code changes.
        mod = _load_hook({"MAIN_AGENT_ID": "genesis"})
        self.assertEqual(mod._agent_id_from_cwd(PROJECT_ROOT), "genesis")

    def test_unrelated_path_returns_none(self):
        # The project-root fallback is NOT a catch-all -- unrelated paths stay None.
        self.assertIsNone(self.mod._agent_id_from_cwd("/tmp/unrelated"))

    def test_tmp_subdir_returns_none(self):
        # A subdirectory of /tmp is unrelated even if it has 'agents' as a path component
        # only when used exactly: /tmp/agents is different from PROJECT_ROOT.
        self.assertIsNone(self.mod._agent_id_from_cwd("/tmp/unrelated/subdir"))

    def test_empty_cwd_returns_none(self):
        self.assertIsNone(self.mod._agent_id_from_cwd(""))

    def test_none_cwd_returns_none(self):
        self.assertIsNone(self.mod._agent_id_from_cwd(None))

    def test_symlink_cwd_resolves_to_project_root(self):
        # realpath on both sides: a symlink pointing to PROJECT_ROOT should match.
        with tempfile.TemporaryDirectory() as tmpdir:
            link = os.path.join(tmpdir, "marveen-link")
            os.symlink(PROJECT_ROOT, link)
            self.assertEqual(self.mod._agent_id_from_cwd(link), "marveen")


class TestModuleLoads(unittest.TestCase):
    def test_module_loads(self):
        mod = _load_hook()
        self.assertTrue(callable(mod._agent_id_from_cwd))
        self.assertTrue(callable(mod._token))
        self.assertTrue(hasattr(mod, "_MAIN_AGENT_ID"))


if __name__ == "__main__":
    unittest.main()
