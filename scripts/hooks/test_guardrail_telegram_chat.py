#!/usr/bin/env python3
"""Tests for the PreToolUse Telegram broadcast/injection guardrail hook.

Run: python3 scripts/hooks/test_guardrail_telegram_chat.py

Covers the pure decision (decide), the allowlist resolver (resolve_allowlist),
and an end-to-end subprocess pass (stdin JSON -> exit code), with the
fail-safe-by-design invariants pinned: matched-tool-only, fail-open on every
error/ambiguity, block only on a positively-matched foreign chat_id.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_HOOK = os.path.join(_HERE, "guardrail-telegram-chat.py")

# Load the hyphenated hook module by path so we can unit-test its functions.
_spec = importlib.util.spec_from_file_location("guardrail_telegram_chat", _HOOK)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

REPLY = "mcp__plugin_telegram_telegram__reply"
EDIT = "mcp__plugin_telegram_telegram__edit_message"
ALLOW = {"8643929442", "555"}


class DecideTests(unittest.TestCase):
    def test_blocks_foreign_chat_on_reply(self):
        block, reason = guard.decide(
            {"tool_name": REPLY, "tool_input": {"chat_id": "999", "text": "hi"}}, ALLOW
        )
        self.assertTrue(block)
        self.assertIn("999", reason)

    def test_blocks_foreign_chat_on_edit_message(self):
        block, _ = guard.decide(
            {"tool_name": EDIT, "tool_input": {"chat_id": 999, "message_id": 1}}, ALLOW
        )
        self.assertTrue(block)  # int chat_id is coerced to str before the check

    def test_allows_paired_chat(self):
        block, _ = guard.decide(
            {"tool_name": REPLY, "tool_input": {"chat_id": "8643929442", "text": "ok"}}, ALLOW
        )
        self.assertFalse(block)

    def test_allows_int_paired_chat(self):
        block, _ = guard.decide(
            {"tool_name": REPLY, "tool_input": {"chat_id": 555}}, ALLOW
        )
        self.assertFalse(block)

    # --- matched-tool-only: only GUARDED_TOOLS can ever be blocked ---
    def test_ignores_other_telegram_tools(self):
        for tool in ("mcp__plugin_telegram_telegram__react",
                     "mcp__plugin_telegram_telegram__download_attachment"):
            block, _ = guard.decide({"tool_name": tool, "tool_input": {"chat_id": "999"}}, ALLOW)
            self.assertFalse(block, tool)

    def test_ignores_non_telegram_tools(self):
        block, _ = guard.decide({"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}, ALLOW)
        self.assertFalse(block)

    # --- fail-open on every ambiguity ---
    def test_fail_open_when_allowlist_unresolved(self):
        block, _ = guard.decide({"tool_name": REPLY, "tool_input": {"chat_id": "999"}}, None)
        self.assertFalse(block)  # None allowlist -> allow, never block blind

    def test_fail_open_when_chat_id_missing(self):
        block, _ = guard.decide({"tool_name": REPLY, "tool_input": {"text": "no chat"}}, ALLOW)
        self.assertFalse(block)

    def test_fail_open_when_tool_input_not_dict(self):
        block, _ = guard.decide({"tool_name": REPLY, "tool_input": None}, ALLOW)
        self.assertFalse(block)

    def test_fail_open_when_payload_not_dict(self):
        block, _ = guard.decide("not-a-dict", ALLOW)
        self.assertFalse(block)


class ResolveAllowlistTests(unittest.TestCase):
    def _write(self, d, data):
        p = os.path.join(d, "access.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return p

    def test_unions_allowfrom_groups_pending(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._write(d, {
                "allowFrom": ["111"],
                "groups": {"-100222": {}},
                "pending": {"333": {}},
            })
            allow = guard.resolve_allowlist([p])
            self.assertEqual(allow, {"111", "-100222", "333"})

    def test_unions_across_multiple_files(self):
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
            p1 = self._write(d1, {"allowFrom": ["111"]})
            p2 = self._write(d2, {"allowFrom": ["222"]})
            allow = guard.resolve_allowlist([p1, p2])
            self.assertEqual(allow, {"111", "222"})

    def test_returns_none_when_no_candidate_parses(self):
        with tempfile.TemporaryDirectory() as d:
            missing = os.path.join(d, "nope.json")
            bad = os.path.join(d, "bad.json")
            with open(bad, "w", encoding="utf-8") as f:
                f.write("{ not json")
            self.assertIsNone(guard.resolve_allowlist([missing, bad]))

    def test_skips_unparseable_but_keeps_good(self):
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
            bad = os.path.join(d1, "bad.json")
            with open(bad, "w", encoding="utf-8") as f:
                f.write("oops")
            good = self._write(d2, {"allowFrom": ["111"]})
            self.assertEqual(guard.resolve_allowlist([bad, good]), {"111"})


class EndToEndTests(unittest.TestCase):
    """Run the hook as a subprocess: cwd holds an access.json, stdin is the
    PreToolUse payload, assert the exit code (0 = allow, 2 = block)."""
    def _run(self, payload, allowfrom):
        with tempfile.TemporaryDirectory() as cwd:
            acc_dir = os.path.join(cwd, ".claude", "channels", "telegram")
            os.makedirs(acc_dir)
            with open(os.path.join(acc_dir, "access.json"), "w", encoding="utf-8") as f:
                json.dump({"allowFrom": allowfrom, "groups": {}, "pending": {}}, f)
            # HOME points at the empty cwd so the global candidate is absent and
            # only the cwd-relative access.json resolves.
            env = dict(os.environ, HOME=cwd)
            return subprocess.run(
                [sys.executable, _HOOK], input=json.dumps(payload),
                capture_output=True, text=True, cwd=cwd, env=env,
            )

    def test_block_exit_2_on_foreign_chat(self):
        r = self._run({"tool_name": REPLY, "tool_input": {"chat_id": "999"}}, ["111"])
        self.assertEqual(r.returncode, 2)
        self.assertIn("guardrail", r.stderr.lower())

    def test_allow_exit_0_on_paired_chat(self):
        r = self._run({"tool_name": REPLY, "tool_input": {"chat_id": "111"}}, ["111"])
        self.assertEqual(r.returncode, 0)

    def test_allow_exit_0_on_malformed_stdin(self):
        with tempfile.TemporaryDirectory() as cwd:
            r = subprocess.run(
                [sys.executable, _HOOK], input="{ broken",
                capture_output=True, text=True, cwd=cwd,
                env=dict(os.environ, HOME=cwd),
            )
            self.assertEqual(r.returncode, 0)

    def test_allow_exit_0_on_empty_stdin(self):
        with tempfile.TemporaryDirectory() as cwd:
            r = subprocess.run(
                [sys.executable, _HOOK], input="",
                capture_output=True, text=True, cwd=cwd,
                env=dict(os.environ, HOME=cwd),
            )
            self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
