#!/usr/bin/env python3
"""Tests for the PreToolUse ask-first approval-gate guardrail hook.

Run: python3 scripts/hooks/test_guardrail_ask_first.py

Covers the token derivation (action_token), classification (classify), the
approval-marker resolver (approval_status), the pure decision (decide), and an
end-to-end subprocess pass (stdin JSON + marker dir -> exit code + marker side
effects). The fail-safe-by-design invariants are pinned: matched-tool-only,
fail-open on every error/ambiguity, block only on a positively-matched guarded
tool with no fresh approval, one-shot consume.

The live GUARDED_TOOLS enum is intentionally empty (no real irreversible MCP
tool is wired yet), so tests inject a tool name:
  - unit tests monkeypatch the in-process module's GUARDED_TOOLS;
  - e2e tests run a tiny driver that loads the hook and sets the enum, which
    keeps the real hook's enum fixed/non-overridable while still exercising
    main()'s full IO path.
One e2e test asserts the real hook (empty enum) is an inert no-op.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_HOOK = os.path.join(_HERE, "guardrail-ask-first.py")

_spec = importlib.util.spec_from_file_location("guardrail_ask_first", _HOOK)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

SEND = "mcp__test__send"


class ActionTokenTests(unittest.TestCase):
    def test_stable_for_same_input(self):
        a = guard.action_token(SEND, {"to": "x@y.z", "body": "hi"})
        b = guard.action_token(SEND, {"to": "x@y.z", "body": "hi"})
        self.assertEqual(a, b)

    def test_key_order_independent(self):
        a = guard.action_token(SEND, {"to": "x", "body": "hi"})
        b = guard.action_token(SEND, {"body": "hi", "to": "x"})
        self.assertEqual(a, b)

    def test_differs_on_input_change(self):
        a = guard.action_token(SEND, {"to": "x", "body": "hi"})
        b = guard.action_token(SEND, {"to": "x", "body": "HELLO"})
        self.assertNotEqual(a, b)

    def test_differs_on_tool_change(self):
        a = guard.action_token(SEND, {"to": "x"})
        b = guard.action_token("mcp__test__other", {"to": "x"})
        self.assertNotEqual(a, b)


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self._orig = guard.GUARDED_TOOLS
        guard.GUARDED_TOOLS = frozenset({SEND})

    def tearDown(self):
        guard.GUARDED_TOOLS = self._orig

    def test_guarded_tool_yields_token(self):
        guarded, token = guard.classify({"tool_name": SEND, "tool_input": {"to": "x"}})
        self.assertTrue(guarded)
        self.assertEqual(token, guard.action_token(SEND, {"to": "x"}))

    def test_non_guarded_tool_passes(self):
        guarded, token = guard.classify({"tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertFalse(guarded)
        self.assertEqual(token, "")

    def test_non_dict_input_fails_open(self):
        guarded, _ = guard.classify({"tool_name": SEND, "tool_input": None})
        self.assertFalse(guarded)

    def test_non_dict_payload_fails_open(self):
        guarded, _ = guard.classify("nope")
        self.assertFalse(guarded)

    def test_empty_enum_is_noop(self):
        guard.GUARDED_TOOLS = frozenset()
        guarded, _ = guard.classify({"tool_name": SEND, "tool_input": {"to": "x"}})
        self.assertFalse(guarded)


class ApprovalStatusTests(unittest.TestCase):
    def test_absent(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(guard.approval_status(d, "tok", time.time()), "absent")

    def test_fresh(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "tok.approved"), "w").close()
            self.assertEqual(guard.approval_status(d, "tok", time.time()), "fresh")

    def test_stale(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "tok.approved")
            open(p, "w").close()
            old = time.time() - guard.APPROVAL_TTL_SECONDS - 10
            os.utime(p, (old, old))
            self.assertEqual(guard.approval_status(d, "tok", time.time()), "stale")


class DecideTests(unittest.TestCase):
    def test_not_guarded_allows(self):
        self.assertEqual(guard.decide(False, "absent"), "allow")

    def test_fresh_consumes(self):
        self.assertEqual(guard.decide(True, "fresh"), "consume")

    def test_absent_blocks(self):
        self.assertEqual(guard.decide(True, "absent"), "block")

    def test_stale_blocks(self):
        self.assertEqual(guard.decide(True, "stale"), "block")


# A driver that loads the real hook but registers a test tool in the enum, so we
# exercise main()'s full IO/exit behavior without making the production enum
# overridable from outside.
_DRIVER = (
    "import importlib.util\n"
    "spec = importlib.util.spec_from_file_location('g', {hook!r})\n"
    "g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n"
    "g.GUARDED_TOOLS = frozenset({{'" + SEND + "'}})\n"
    "g.main()\n"
)


class EndToEndTests(unittest.TestCase):
    def _run_driver(self, payload, approvals_dir):
        with tempfile.TemporaryDirectory() as cwd:
            driver = os.path.join(cwd, "driver.py")
            with open(driver, "w", encoding="utf-8") as f:
                f.write(_DRIVER.format(hook=_HOOK))
            env = dict(os.environ, ASK_APPROVALS_DIR=approvals_dir)
            return subprocess.run(
                [sys.executable, driver], input=json.dumps(payload),
                capture_output=True, text=True, cwd=cwd, env=env,
            )

    def test_block_exit_2_and_writes_pending(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": SEND, "tool_input": {"to": "x@y.z", "body": "hi"}}
            r = self._run_driver(payload, appr)
            self.assertEqual(r.returncode, 2)
            self.assertIn("ASK-FIRST", r.stderr)
            token = guard.action_token(SEND, {"to": "x@y.z", "body": "hi"})
            self.assertIn(token, r.stderr)
            pending = os.path.join(appr, token + ".pending")
            self.assertTrue(os.path.exists(pending))
            with open(pending, encoding="utf-8") as f:
                rec = json.load(f)
            self.assertEqual(rec["tool_input"], {"to": "x@y.z", "body": "hi"})

    def test_fresh_marker_allows_and_consumes(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": SEND, "tool_input": {"to": "x@y.z"}}
            token = guard.action_token(SEND, {"to": "x@y.z"})
            marker = os.path.join(appr, token + ".approved")
            open(marker, "w").close()
            r = self._run_driver(payload, appr)
            self.assertEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(marker), "marker must be consumed (one-shot)")

    def test_stale_marker_reblocks(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": SEND, "tool_input": {"to": "x@y.z"}}
            token = guard.action_token(SEND, {"to": "x@y.z"})
            marker = os.path.join(appr, token + ".approved")
            open(marker, "w").close()
            old = time.time() - guard.APPROVAL_TTL_SECONDS - 10
            os.utime(marker, (old, old))
            r = self._run_driver(payload, appr)
            self.assertEqual(r.returncode, 2)

    def test_malformed_stdin_fails_open(self):
        with tempfile.TemporaryDirectory() as appr, tempfile.TemporaryDirectory() as cwd:
            driver = os.path.join(cwd, "driver.py")
            with open(driver, "w", encoding="utf-8") as f:
                f.write(_DRIVER.format(hook=_HOOK))
            r = subprocess.run(
                [sys.executable, driver], input="{ broken",
                capture_output=True, text=True, cwd=cwd,
                env=dict(os.environ, ASK_APPROVALS_DIR=appr),
            )
            self.assertEqual(r.returncode, 0)

    def test_real_hook_empty_enum_is_inert(self):
        # The production hook with its real (empty) enum must pass everything
        # through -- inert until a tool name is registered.
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": SEND, "tool_input": {"to": "x"}}
            r = subprocess.run(
                [sys.executable, _HOOK], input=json.dumps(payload),
                capture_output=True, text=True,
                env=dict(os.environ, ASK_APPROVALS_DIR=appr),
            )
            self.assertEqual(r.returncode, 0)
            self.assertEqual(os.listdir(appr), [], "inert hook must not write markers")


if __name__ == "__main__":
    unittest.main(verbosity=2)
