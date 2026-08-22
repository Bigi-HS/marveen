#!/usr/bin/env python3
"""Acceptance tests for the gmail-send registration in the ask-first guardrail.

Pins that Claudia's local Google MCP send tool is guarded (ask-first) while its
read-only calendar tool is not, and cross-pins the exact guarded string against
the single source of truth in src/mcp/tool-names.ts so the python hook and the
TypeScript server cannot drift apart.

Run: python3 scripts/__tests__/guardrail-gmail-send.test.py
"""
import importlib.util
import os
import re
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_HOOK = os.path.join(_HERE, "..", "hooks", "guardrail-ask-first.py")
_TOOL_NAMES_TS = os.path.join(_HERE, "..", "..", "src", "mcp", "tool-names.ts")

GMAIL_SEND = "mcp__claudia_google__gmail_send"
CALENDAR_TODAY = "mcp__claudia_google__calendar_today"


def _load_hook():
    spec = importlib.util.spec_from_file_location("guardrail_ask_first", _HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


hook = _load_hook()


def _derive_guarded_name_from_ts():
    """Reconstruct mcp__<SERVER_KEY>__<TOOL_GMAIL_SEND> from the TS source of
    truth so a rename there breaks this test until the hook is updated too."""
    with open(_TOOL_NAMES_TS, encoding="utf-8") as f:
        src = f.read()
    server = re.search(r"SERVER_KEY\s*=\s*'([^']+)'", src).group(1)
    tool = re.search(r"TOOL_GMAIL_SEND\s*=\s*'([^']+)'", src).group(1)
    return f"mcp__{server}__{tool}"


class TestRegistration(unittest.TestCase):
    def test_gmail_send_is_guarded(self):
        self.assertIn(GMAIL_SEND, hook.GUARDED_TOOLS)

    def test_calendar_read_is_not_guarded(self):
        # read-only (calendar.events.readonly) must never be ask-first gated
        self.assertNotIn(CALENDAR_TODAY, hook.GUARDED_TOOLS)

    def test_guarded_name_matches_ts_source_of_truth(self):
        self.assertEqual(_derive_guarded_name_from_ts(), GMAIL_SEND)
        self.assertIn(_derive_guarded_name_from_ts(), hook.GUARDED_TOOLS)


class TestClassifyAndDecide(unittest.TestCase):
    def test_gmail_send_classifies_as_guarded_with_token(self):
        guarded, token = hook.classify(
            {"tool_name": GMAIL_SEND, "tool_input": {"to": "a@b.com", "subject": "x", "body": "y"}}
        )
        self.assertTrue(guarded)
        self.assertTrue(token)

    def test_calendar_call_passes_through(self):
        guarded, token = hook.classify({"tool_name": CALENDAR_TODAY, "tool_input": {}})
        self.assertFalse(guarded)

    def test_decide_blocks_unapproved_send_and_consumes_fresh(self):
        self.assertEqual(hook.decide(True, "absent"), "block")
        self.assertEqual(hook.decide(True, "stale"), "block")
        self.assertEqual(hook.decide(True, "fresh"), "consume")
        self.assertEqual(hook.decide(False, "absent"), "allow")


if __name__ == "__main__":
    unittest.main()
