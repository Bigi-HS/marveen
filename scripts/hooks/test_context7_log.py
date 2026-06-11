#!/usr/bin/env python3
"""Tests for the context7 PreToolUse logging hook.

Run: python3 scripts/hooks/test_context7_log.py

The hook is a Tier-B External-MCP-Adoption-Policy gate condition: it logs ONE
audit line per context7 tool call (timestamp + agent + tool name + target
library identifier) and NEVER logs prompt content, topic, or any free text. It
is a pure logging hook: it must ALWAYS exit 0 (a logging failure can never block
context7 for Dave) and must be a silent no-op for any non-context7 tool.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import context7_log  # noqa: E402

_HOOK = os.path.join(_HERE, "context7_log.py")
_NOW = 1_700_000_000


def _run(payload, log_path):
    """Invoke the hook as a subprocess with stdin=payload; return exit code."""
    env = dict(os.environ, CONTEXT7_LOG_PATH=log_path)
    raw = payload if isinstance(payload, str) else json.dumps(payload)
    p = subprocess.run(
        [sys.executable, _HOOK],
        input=raw, capture_output=True, text=True, env=env,
    )
    return p.returncode


def _read_lines(log_path):
    if not os.path.exists(log_path):
        return []
    with open(log_path, encoding="utf-8") as f:
        return [json.loads(ln) for ln in f if ln.strip()]


class ExtractEntryTests(unittest.TestCase):
    def test_resolve_library_id_logs_library_name(self):
        entry = context7_log.extract_entry(
            {"tool_name": "mcp__context7__resolve-library-id",
             "tool_input": {"libraryName": "react"}}, _NOW)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["tool"], "mcp__context7__resolve-library-id")
        self.assertEqual(entry["library"], "react")
        self.assertEqual(entry["ts"], _NOW)
        self.assertEqual(set(entry.keys()), {"ts", "agent", "tool", "library"})

    def test_get_library_docs_logs_library_id_not_content(self):
        entry = context7_log.extract_entry(
            {"tool_name": "mcp__context7__get-library-docs",
             "tool_input": {"context7CompatibleLibraryID": "/facebook/react",
                            "topic": "INTERNAL-SECRET-do-not-log",
                            "tokens": 5000}}, _NOW)
        self.assertEqual(entry["library"], "/facebook/react")
        # Content/topic must NEVER reach the audit entry.
        self.assertNotIn("topic", entry)
        self.assertNotIn("INTERNAL-SECRET-do-not-log", json.dumps(entry))
        self.assertEqual(set(entry.keys()), {"ts", "agent", "tool", "library"})

    def test_non_context7_tool_is_none(self):
        self.assertIsNone(context7_log.extract_entry(
            {"tool_name": "Bash", "tool_input": {"command": "ls"}}, _NOW))
        self.assertIsNone(context7_log.extract_entry(
            {"tool_name": "mcp__plugin_telegram_telegram__reply",
             "tool_input": {"chat_id": "1"}}, _NOW))

    def test_malformed_payloads_are_none(self):
        for bad in (None, [], "string", 42, {}, {"tool_input": {}}):
            self.assertIsNone(context7_log.extract_entry(bad, _NOW))

    def test_context7_call_with_no_library_arg_still_logs_empty(self):
        # A context7 call we can't resolve a library for is still an auditable
        # event -- log it with an empty library rather than dropping it.
        entry = context7_log.extract_entry(
            {"tool_name": "mcp__context7__get-library-docs", "tool_input": {}}, _NOW)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["library"], "")

    def test_library_arg_must_be_a_nonempty_string(self):
        entry = context7_log.extract_entry(
            {"tool_name": "mcp__context7__resolve-library-id",
             "tool_input": {"libraryName": 12345}}, _NOW)
        self.assertEqual(entry["library"], "")


class HookSubprocessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.log = os.path.join(self.tmp, "context7-usage.log")

    def test_context7_call_writes_one_audit_line_exit0(self):
        rc = _run({"tool_name": "mcp__context7__resolve-library-id",
                   "tool_input": {"libraryName": "next.js"}}, self.log)
        self.assertEqual(rc, 0)
        lines = _read_lines(self.log)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["tool"], "mcp__context7__resolve-library-id")
        self.assertEqual(lines[0]["library"], "next.js")
        self.assertEqual(set(lines[0].keys()), {"ts", "agent", "tool", "library"})

    def test_content_never_hits_the_log_file(self):
        rc = _run({"tool_name": "mcp__context7__get-library-docs",
                   "tool_input": {"context7CompatibleLibraryID": "/vercel/next.js",
                                  "topic": "LEAK-CANARY-STRING"}}, self.log)
        self.assertEqual(rc, 0)
        with open(self.log, encoding="utf-8") as f:
            raw = f.read()
        self.assertNotIn("LEAK-CANARY-STRING", raw)
        self.assertNotIn("topic", raw)
        self.assertIn("/vercel/next.js", raw)

    def test_non_context7_tool_writes_nothing_exit0(self):
        rc = _run({"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}, self.log)
        self.assertEqual(rc, 0)
        self.assertEqual(_read_lines(self.log), [])

    def test_malformed_stdin_exit0_no_crash(self):
        for bad in ("", "not json", "[1,2,3]", "null"):
            rc = _run(bad, self.log)
            self.assertEqual(rc, 0)
        self.assertEqual(_read_lines(self.log), [])

    def test_created_log_is_owner_only_0600(self):
        _run({"tool_name": "mcp__context7__resolve-library-id",
              "tool_input": {"libraryName": "react"}}, self.log)
        self.assertEqual(os.stat(self.log).st_mode & 0o777, 0o600)

    def test_appends_across_calls(self):
        _run({"tool_name": "mcp__context7__resolve-library-id",
              "tool_input": {"libraryName": "a"}}, self.log)
        _run({"tool_name": "mcp__context7__resolve-library-id",
              "tool_input": {"libraryName": "b"}}, self.log)
        libs = [ln["library"] for ln in _read_lines(self.log)]
        self.assertEqual(libs, ["a", "b"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
