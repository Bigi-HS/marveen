#!/usr/bin/env python3
"""Tests for the PostToolUse tool-log relay hook (card 229a9000).

Run: python3 scripts/hooks/test_tool_log_relay.py

The hook is a pure LOGGING relay: it maps a PostToolUse payload to a
metadata-only /api/tool-log body and must NEVER carry raw command/prompt/output
content, only whitelisted structural fields. The build is a pure function
(build_payload) exercised here in isolation -- no network, no dashboard needed.
It must also ALWAYS exit 0, even on garbage stdin (a relay failure can never
block a tool call).
"""
import json
import os
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import importlib

relay = importlib.import_module("tool-log-relay")
_HOOK = os.path.join(_HERE, "tool-log-relay.py")


class BuildPayload(unittest.TestCase):
    def test_bash_uses_description_not_command(self):
        p = relay.build_payload({
            "session_id": "sess-1",
            "tool_name": "Bash",
            "tool_input": {"command": "export SECRET=hunter2 && ls", "description": "List files"},
        })
        self.assertEqual(p["session_id"], "sess-1")
        self.assertEqual(p["tool_name"], "Bash")
        self.assertEqual(p["input_summary"], "List files")
        # The secret-bearing command body is never carried.
        self.assertNotIn("hunter2", json.dumps(p))
        self.assertTrue(p["success"])

    def test_file_tool_uses_file_path(self):
        p = relay.build_payload({
            "session_id": "s", "tool_name": "Edit",
            "tool_input": {"file_path": "/repo/src/db.ts", "old_string": "x", "new_string": "y"},
        })
        self.assertEqual(p["input_summary"], "/repo/src/db.ts")

    def test_no_whitelisted_field_yields_null_summary(self):
        # Only a raw command present -> nothing safe to summarize -> None.
        p = relay.build_payload({
            "session_id": "s", "tool_name": "Bash",
            "tool_input": {"command": "rm -rf /tmp/x"},
        })
        self.assertIsNone(p["input_summary"])
        self.assertNotIn("rm -rf", json.dumps(p))

    def test_summary_is_truncated(self):
        long = "a" * 500
        p = relay.build_payload({
            "session_id": "s", "tool_name": "Grep", "tool_input": {"pattern": long},
        })
        self.assertLessEqual(len(p["input_summary"]), relay.SUMMARY_CAP)

    def test_error_response_marks_failure(self):
        p = relay.build_payload({
            "session_id": "s", "tool_name": "Bash",
            "tool_input": {"description": "boom"},
            "tool_response": {"is_error": True},
        })
        self.assertFalse(p["success"])

    def test_error_string_marks_failure(self):
        p = relay.build_payload({
            "session_id": "s", "tool_name": "Read",
            "tool_input": {"file_path": "/x"},
            "tool_response": {"error": "ENOENT"},
        })
        self.assertFalse(p["success"])

    def test_missing_session_falls_back(self):
        p = relay.build_payload({"tool_name": "Bash", "tool_input": {"description": "x"}})
        self.assertEqual(p["session_id"], "unknown")

    def test_non_dict_and_missing_tool_return_none(self):
        self.assertIsNone(relay.build_payload("nope"))
        self.assertIsNone(relay.build_payload(None))
        self.assertIsNone(relay.build_payload({"tool_input": {"description": "x"}}))
        self.assertIsNone(relay.build_payload({"tool_name": "   "}))


class HookExitCode(unittest.TestCase):
    """The hook must always exit 0 -- garbage stdin, empty stdin, no token."""

    def _run(self, stdin_text):
        env = dict(os.environ, DASHBOARD_TOKEN_PATH="/nonexistent/token")
        p = subprocess.run([sys.executable, _HOOK], input=stdin_text,
                           capture_output=True, text=True, env=env)
        return p.returncode

    def test_exit_zero_on_garbage(self):
        self.assertEqual(self._run("not json {{{"), 0)

    def test_exit_zero_on_empty(self):
        self.assertEqual(self._run(""), 0)

    def test_exit_zero_on_valid_no_token(self):
        # Valid payload but token path missing -> _post no-ops, still exit 0.
        self.assertEqual(self._run(json.dumps({
            "session_id": "s", "tool_name": "Bash", "tool_input": {"description": "x"},
        })), 0)


if __name__ == "__main__":
    unittest.main()
