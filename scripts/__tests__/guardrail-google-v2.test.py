#!/usr/bin/env python3
"""Acceptance tests for the Claudia Google MCP v2 ask-first registrations
(SEC-AC5). Cross-pins the 7 new hard-guarded tools against the single source of
truth in src/mcp/tool-names.ts so the python hook and the TypeScript server
cannot drift apart, and pins that the new read/unguarded-write tools are NOT
ask-first gated. The v1 test (guardrail-gmail-send.test.py) stays untouched
(F-AC10); this is the v2 addition only.

Run: python3 scripts/__tests__/guardrail-google-v2.test.py
"""
import importlib.util
import os
import re
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_HOOK = os.path.join(_HERE, "..", "hooks", "guardrail-ask-first.py")
_TOOL_NAMES_TS = os.path.join(_HERE, "..", "..", "src", "mcp", "tool-names.ts")

# The 7 ask-first=YES tools (SEC-AC5), as (ts_const_name, expected_tool_string).
GUARDED_V2 = [
    ("TOOL_GMAIL_TRASH_MESSAGE", "gmail_trash_message"),
    ("TOOL_GMAIL_DELETE_LABEL", "gmail_delete_label"),
    ("TOOL_GMAIL_CREATE_FILTER", "gmail_create_filter"),
    ("TOOL_GMAIL_DELETE_FILTER", "gmail_delete_filter"),
    ("TOOL_GMAIL_UPDATE_VACATION", "gmail_update_vacation"),
    ("TOOL_CALENDAR_DELETE_EVENT", "calendar_delete_event"),
    ("TOOL_CALENDAR_UPDATE_EVENT_ALL", "calendar_update_event_all"),
    # ENG-048: Drive overwrite is an irreversible external write -> ask-first.
    ("TOOL_DRIVE_UPLOAD_FILE", "drive_upload_file"),
]

# New v2 tools that MUST NOT be ask-first gated (reads + reversible writes).
UNGUARDED_V2 = [
    "gmail_list_messages",
    "gmail_get_message",
    "gmail_get_thread",
    "gmail_archive_message",
    "gmail_mark_read",
    "gmail_label_message",
    "gmail_create_label",
    "gmail_list_filters",
    "calendar_list_events",
    "calendar_create_event",
    "calendar_update_event",
    # ENG-048: Drive reads are NOT guarded (only the overwrite/upload is).
    "drive_list_files",
    "drive_download_file",
]


def _load_hook():
    spec = importlib.util.spec_from_file_location("guardrail_ask_first", _HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


hook = _load_hook()


def _ts_source():
    with open(_TOOL_NAMES_TS, encoding="utf-8") as f:
        return f.read()


def _server_key(src):
    return re.search(r"SERVER_KEY\s*=\s*'([^']+)'", src).group(1)


def _ts_const(src, const_name):
    """Read the string literal assigned to a `export const <name> = '...'`."""
    m = re.search(const_name + r"\s*=\s*'([^']+)'", src)
    assert m, "constant %s not found in tool-names.ts" % const_name
    return m.group(1)


class TestV2Registration(unittest.TestCase):
    def setUp(self):
        self.src = _ts_source()
        self.server = _server_key(self.src)

    def test_seven_guarded_tools_cross_pinned(self):
        # Reconstruct each guarded name from the TS source of truth and assert it
        # is registered in the hook's GUARDED_TOOLS. A rename on either side
        # breaks this until both are updated in lockstep.
        for const_name, expected_tool in GUARDED_V2:
            ts_tool = _ts_const(self.src, const_name)
            self.assertEqual(
                ts_tool, expected_tool,
                "tool-names.ts %s drifted from spec" % const_name,
            )
            namespaced = "mcp__%s__%s" % (self.server, ts_tool)
            self.assertIn(
                namespaced, hook.GUARDED_TOOLS,
                "%s not in GUARDED_TOOLS" % namespaced,
            )

    def test_v1_gmail_send_still_guarded(self):
        # F-AC10: no regression on the v1 send guard.
        self.assertIn("mcp__claudia_google__gmail_send", hook.GUARDED_TOOLS)

    def test_reads_and_reversible_writes_not_guarded(self):
        for tool in UNGUARDED_V2:
            self.assertNotIn(
                "mcp__%s__%s" % (self.server, tool), hook.GUARDED_TOOLS,
                "%s must NOT be ask-first gated" % tool,
            )

    def test_guarded_set_size_is_exactly_nine(self):
        # 1 v1 (gmail_send) + 7 v2 + 1 ENG-048 (drive_upload_file) = 9.
        # Catches an accidental extra/missing entry.
        self.assertEqual(len(hook.GUARDED_TOOLS), 9)


class TestV2ClassifyBlocks(unittest.TestCase):
    def test_each_guarded_tool_blocks_without_approval(self):
        for _, tool in GUARDED_V2:
            name = "mcp__claudia_google__%s" % tool
            guarded, token = hook.classify({"tool_name": name, "tool_input": {"id": "x"}})
            self.assertTrue(guarded, "%s should classify guarded" % name)
            self.assertEqual(hook.decide(guarded, "absent"), "block")
            self.assertEqual(hook.decide(guarded, "fresh"), "consume")


if __name__ == "__main__":
    unittest.main()
