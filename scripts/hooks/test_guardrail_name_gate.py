#!/usr/bin/env python3
"""Tests for the name-gate PreToolUse hook (card 16fd807a).

Adversarial fixture classes required by fleet-policy:
  FP  -- routing-id appearing as a common word/quoted phrase (still warns: soft-block)
  FN  -- multiple routing-ids in one message (all must be caught)
  OPP -- correct display name already used (must NOT warn)
"""

import importlib.util
import os
import unittest

# Load hook module without running main()
_HOOK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guardrail-name-gate.py")
_spec = importlib.util.spec_from_file_location("guardrail_name_gate", _HOOK_PATH)
_hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hook)


# Minimal id-map used in most tests (avoids hitting the live filesystem).
FAKE_ID_MAP = {
    "scout": "Dr. Stone",
    "forge": "Armorer",
    "bigben": "Big Ben",
}


def _payload(tool_name, **tool_input):
    return {"tool_name": tool_name, "tool_input": tool_input}


# ---------------------------------------------------------------------------
# extract_text
# ---------------------------------------------------------------------------
class TestExtractText(unittest.TestCase):

    def test_mcp_reply_extracts_text(self):
        p = _payload("mcp__plugin_telegram_telegram__reply", chat_id="123", text="hello scout")
        text, is_guarded = _hook.extract_text(p)
        self.assertTrue(is_guarded)
        self.assertEqual(text, "hello scout")

    def test_mcp_edit_message_extracts_text(self):
        p = _payload("mcp__plugin_telegram_telegram__edit_message",
                     chat_id="123", message_id=1, text="forge is done")
        text, is_guarded = _hook.extract_text(p)
        self.assertTrue(is_guarded)
        self.assertEqual(text, "forge is done")

    def test_bash_notify_telegram_guarded(self):
        cmd = "curl -s -X POST http://localhost:3420/api/notify/telegram " \
              "-d '{\"chat_id\": \"999\", \"text\": \"scout confirmed\"}'"
        p = _payload("Bash", command=cmd)
        text, is_guarded = _hook.extract_text(p)
        self.assertTrue(is_guarded)
        self.assertIn("scout confirmed", text or "")

    def test_bash_other_api_not_guarded(self):
        # /api/kanban: not a Boss-facing message path
        p = _payload("Bash", command="curl http://localhost:3420/api/kanban")
        _, is_guarded = _hook.extract_text(p)
        self.assertFalse(is_guarded)

    def test_inter_agent_messages_not_guarded(self):
        # /api/messages is inter-agent; routing-id is the correct address there
        cmd = ("curl -X POST http://localhost:3420/api/messages "
               "-d '{\"to\": \"scout\", \"content\": \"hello\"}'")
        _, is_guarded = _hook.extract_text(_payload("Bash", command=cmd))
        self.assertFalse(is_guarded)

    def test_write_tool_not_guarded(self):
        p = _payload("Write", file_path="out.txt", content="scout report")
        _, is_guarded = _hook.extract_text(p)
        self.assertFalse(is_guarded)

    def test_read_tool_not_guarded(self):
        p = _payload("Read", file_path="scout-notes.txt")
        _, is_guarded = _hook.extract_text(p)
        self.assertFalse(is_guarded)

    def test_empty_text_returns_none(self):
        p = _payload("mcp__plugin_telegram_telegram__reply", chat_id="1", text="")
        text, is_guarded = _hook.extract_text(p)
        self.assertTrue(is_guarded)
        self.assertIsNone(text)

    def test_missing_text_field_returns_none(self):
        p = _payload("mcp__plugin_telegram_telegram__reply", chat_id="1")
        text, is_guarded = _hook.extract_text(p)
        self.assertTrue(is_guarded)
        self.assertIsNone(text)


# ---------------------------------------------------------------------------
# find_routing_ids
# ---------------------------------------------------------------------------
class TestFindRoutingIds(unittest.TestCase):

    def test_finds_single_routing_id(self):
        found = _hook.find_routing_ids("scout confirmed the task", FAKE_ID_MAP)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0], ("scout", "Dr. Stone"))

    # FN fixture: multiple routing-ids in one message -- all must be caught
    def test_finds_multiple_ids_in_one_message(self):
        found = _hook.find_routing_ids("scout and forge are both ready", FAKE_ID_MAP)
        ids = [f[0] for f in found]
        self.assertIn("scout", ids)
        self.assertIn("forge", ids)

    # OPP fixture: correct display name already used -- must NOT block
    def test_correct_display_name_not_flagged(self):
        found = _hook.find_routing_ids("Dr. Stone confirmed the result", FAKE_ID_MAP)
        self.assertEqual(len(found), 0)

    def test_armorer_display_name_not_flagged(self):
        found = _hook.find_routing_ids("Armorer finished the build", FAKE_ID_MAP)
        self.assertEqual(len(found), 0)

    # FP fixture: routing-id used as a common word -- soft-block still fires
    # (the agent must use the display name even in prose; the hook is intentionally
    # broad because a false positive only costs a one-time correction, while a
    # false negative leaks an internal ID to Boss-facing text)
    def test_routing_id_as_common_word_still_flagged(self):
        found = _hook.find_routing_ids("the scout mission is complete", FAKE_ID_MAP)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0][0], "scout")

    def test_word_boundary_no_partial_match(self):
        # 'scouting' must NOT match 'scout'
        found = _hook.find_routing_ids("scouting for resources", FAKE_ID_MAP)
        self.assertEqual(len(found), 0)

    def test_case_insensitive_match(self):
        # 'SCOUT' and 'Scout' should also trigger
        found = _hook.find_routing_ids("SCOUT completed the task", FAKE_ID_MAP)
        self.assertEqual(len(found), 1)
        found2 = _hook.find_routing_ids("Scout is done", FAKE_ID_MAP)
        self.assertEqual(len(found2), 1)

    def test_hyphenated_compound_id(self):
        # devil-advocate would require \\b at the boundary of the hyphen
        id_map = {"devil-advocate": "Ordogugyvede"}
        # The hyphen is a word boundary in Python regex, so \b matches there
        found = _hook.find_routing_ids("Contact devil-advocate for review", id_map)
        self.assertEqual(len(found), 1)

    def test_empty_text_returns_empty(self):
        found = _hook.find_routing_ids("", FAKE_ID_MAP)
        self.assertEqual(len(found), 0)

    def test_empty_id_map_returns_empty(self):
        found = _hook.find_routing_ids("scout and forge", {})
        self.assertEqual(len(found), 0)

    def test_id_not_present_no_match(self):
        found = _hook.find_routing_ids("everything looks fine", FAKE_ID_MAP)
        self.assertEqual(len(found), 0)

    # OPP fixture: displayName == capitalize(id) case -- must NOT block.
    # Before the fix, build_id_map added {'dave': 'Dave'} (display != agent_id
    # case-sensitively), and find_routing_ids then blocked the correct use of 'Dave'.
    def test_capitalized_id_as_displayname_not_in_map(self):
        # The live map must NOT contain agents whose displayName is just the
        # capitalized routing-id (dave->Dave, thor->Thor, bond->Bond, etc.).
        live_map = _hook.build_id_map()
        self.assertNotIn("dave", live_map,
                         "dave->Dave should be excluded (capitalised id, not a distinct Boss name)")
        self.assertNotIn("thor", live_map,
                         "thor->Thor should be excluded")
        # End-to-end: writing the correct display name must not trigger a block
        live_found = _hook.find_routing_ids("Dave is done, Thor approved.", live_map)
        self.assertEqual(len(live_found), 0,
                         "Correct display names must not trigger a soft-block")


# ---------------------------------------------------------------------------
# build_id_map (integration: hits real filesystem)
# ---------------------------------------------------------------------------
class TestBuildIdMap(unittest.TestCase):

    def test_returns_dict(self):
        result = _hook.build_id_map()
        self.assertIsInstance(result, dict)

    def test_known_agent_in_map(self):
        # 'scout' has displayName='Dr. Stone', so must appear
        result = _hook.build_id_map()
        self.assertIn("scout", result)
        self.assertEqual(result["scout"], "Dr. Stone")

    def test_forge_in_map(self):
        result = _hook.build_id_map()
        self.assertIn("forge", result)
        self.assertEqual(result["forge"], "Armorer")

    def test_nonexistent_agents_dir_returns_empty(self):
        result = _hook.build_id_map(agents_dir="/nonexistent/path")
        self.assertEqual(result, {})


if __name__ == "__main__":
    unittest.main()
