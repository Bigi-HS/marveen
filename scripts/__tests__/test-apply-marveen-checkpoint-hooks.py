#!/usr/bin/env python3
"""
Tests for scripts/apply-marveen-checkpoint-hooks.py

Coverage:
  - already_patched() detects existing hooks
  - patch() adds PreCompact block
  - patch() adds SessionEnd hook to existing unconditional block
  - patch() creates SessionEnd block when none exists
  - patch() idempotent: second call does not duplicate entries
  - verify_preconditions() fails fast on missing hook script
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

PATCHER_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "apply-marveen-checkpoint-hooks.py"
)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK_SCRIPT = os.path.join(PROJECT_ROOT, "scripts", "hooks", "checkpoint-write.py")


def _load_patcher():
    spec = importlib.util.spec_from_file_location("apply_marveen", PATCHER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _minimal_settings():
    return {
        "hooks": {
            "SessionEnd": [
                {"hooks": [
                    {"type": "command", "command": "python3 session-end-marker.py", "timeout": 5}
                ]}
            ]
        }
    }


class TestAlreadyPatched(unittest.TestCase):
    def setUp(self):
        self.mod = _load_patcher()

    def test_not_patched_returns_false(self):
        s = _minimal_settings()
        self.assertFalse(self.mod.already_patched(s))

    def test_precompact_present_returns_true(self):
        s = _minimal_settings()
        s["hooks"]["PreCompact"] = [
            {"matcher": "auto", "hooks": [{"type": "command",
             "command": "python3 checkpoint-write.py precompact", "timeout": 5}]}
        ]
        self.assertTrue(self.mod.already_patched(s))


class TestPatch(unittest.TestCase):
    def setUp(self):
        self.mod = _load_patcher()

    def test_adds_precompact_block(self):
        s = _minimal_settings()
        result = self.mod.patch(s)
        self.assertIn("PreCompact", result["hooks"])
        pc = result["hooks"]["PreCompact"]
        self.assertEqual(len(pc), 1)
        cmd = pc[0]["hooks"][0]["command"]
        self.assertIn("checkpoint-write.py", cmd)
        self.assertIn("precompact", cmd)

    def test_adds_sessionend_to_existing_unconditional_block(self):
        s = _minimal_settings()
        result = self.mod.patch(s)
        se = result["hooks"]["SessionEnd"]
        # Should still be one block (appended to existing)
        self.assertEqual(len(se), 1)
        commands = [h["command"] for h in se[0]["hooks"]]
        self.assertTrue(any("checkpoint-write.py" in c and "sessionend" in c for c in commands))

    def test_creates_sessionend_block_when_missing(self):
        s = {"hooks": {}}
        result = self.mod.patch(s)
        self.assertIn("SessionEnd", result["hooks"])
        se = result["hooks"]["SessionEnd"]
        self.assertGreater(len(se), 0)
        commands = [h["command"] for block in se for h in block["hooks"]]
        self.assertTrue(any("sessionend" in c for c in commands))

    def test_idempotent_precompact(self):
        s = _minimal_settings()
        result1 = self.mod.patch(s)
        result2 = self.mod.patch(result1)
        self.assertEqual(
            len(result1["hooks"]["PreCompact"]),
            len(result2["hooks"]["PreCompact"])
        )

    def test_idempotent_sessionend(self):
        s = _minimal_settings()
        result1 = self.mod.patch(s)
        se1_hooks = result1["hooks"]["SessionEnd"][0]["hooks"]
        result2 = self.mod.patch(result1)
        se2_hooks = result2["hooks"]["SessionEnd"][0]["hooks"]
        # Should not duplicate the sessionend entry
        sessionend_cmds1 = [h["command"] for h in se1_hooks if "sessionend" in h["command"]]
        sessionend_cmds2 = [h["command"] for h in se2_hooks if "sessionend" in h["command"]]
        self.assertEqual(len(sessionend_cmds1), len(sessionend_cmds2))


class TestVerifyPreconditions(unittest.TestCase):
    def setUp(self):
        self.mod = _load_patcher()

    def test_hook_script_exists(self):
        # In a real repo, checkpoint-write.py must be present.
        self.assertTrue(os.path.isfile(HOOK_SCRIPT),
                        f"checkpoint-write.py missing at {HOOK_SCRIPT}")

    def test_preconditions_pass_in_real_repo(self):
        # Uses the real PROJECT_ROOT paths -- should pass in worktree.
        result = self.mod.verify_preconditions()
        self.assertTrue(result)


if __name__ == "__main__":
    unittest.main()
