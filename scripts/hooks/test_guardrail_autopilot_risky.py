#!/usr/bin/env python3
"""Tests for the autopilot RISKY-GATE PreToolUse hook (guardrail-autopilot-risky.py).

Run: python3 scripts/hooks/test_guardrail_autopilot_risky.py

This hook is the FAIL-CLOSED sibling of guardrail-ask-first.py. Its DANGEROUS
direction (assertion-direction-check skill) is a RISKY action read as SAFE and
let through autonomously, so the bulk of the assertions pin the BLOCK side, and
every new detector branch ships adversarial fixtures for its known bypass
classes (adversarial-fixture-gate skill):
  - inter-agent content: slash/space/case/zero-width keyword evasion, benign
    wrapper around a risky instruction, grey-zone (no content) -> fail-closed.
  - kanban: status->done incl. case/space; PARKED/awaiting-dominik marker;
    done smuggled while a benign-looking status field is absent; SAFE advances.
  - shared-memory: shared OVERWRITE (several overwrite-signal keys); shared NEW
    entry SAFE; tier-less shared-overwrite grey-zone -> fail-closed; hot/warm SAFE.
Plus plain true-positive / true-negative coverage and the end-to-end exit-code +
marker side-effect path, including the inverse-of-sibling fail-closed on a
malformed payload for a GUARDED tool.
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
_HOOK = os.path.join(_HERE, "guardrail-autopilot-risky.py")

_spec = importlib.util.spec_from_file_location("guardrail_autopilot_risky", _HOOK)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

SEND = "send_agent_message"
KANBAN = "kanban_update"
MEMORY = "memory_save"


def _classify(tool, inp):
    return guard.classify({"tool_name": tool, "tool_input": inp})


# ---------------------------------------------------------------------------
# RK-01: inter-agent message content inspection (delegates to risky_content).
# ---------------------------------------------------------------------------
class InterAgentContentRisky(unittest.TestCase):
    """DANGEROUS side: a risky instruction in the message MUST block."""

    def test_plain_deploy(self):
        g, _, _ = _classify(SEND, {"message": "please deploy the server now"})
        self.assertTrue(g)

    def test_plain_delete(self):
        g, _, _ = _classify(SEND, {"content": "delete the store/ backups"})
        self.assertTrue(g)

    def test_merge_to_main(self):
        g, _, _ = _classify(SEND, {"message": "go ahead and merge to main"})
        self.assertTrue(g)

    def test_hungarian_torol(self):
        g, _, _ = _classify(SEND, {"body": "töröld a kártyát és a markert"})
        self.assertTrue(g)

    # --- adversarial: keyword obfuscation / normalization evasion ---
    def test_case_evasion(self):
        g, _, _ = _classify(SEND, {"message": "DEPLOY IT NOW"})
        self.assertTrue(g)

    def test_inter_letter_separator_evasion(self):
        g, _, _ = _classify(SEND, {"message": "d-e-p-l-o-y the build"})
        self.assertTrue(g)

    def test_hyphen_compound_evasion(self):
        g, _, _ = _classify(SEND, {"message": "proceed, merge-to-main asap"})
        self.assertTrue(g)

    def test_zero_width_evasion(self):
        g, _, _ = _classify(SEND, {"message": "de​ploy the service"})
        self.assertTrue(g)

    def test_benign_wrapper_embeds_risky(self):
        # Looks like routine chatter but embeds a risky instruction.
        msg = "thanks for the update! quick thing: can you delete the prod bucket?"
        g, _, _ = _classify(SEND, {"message": msg})
        self.assertTrue(g)

    def test_alt_content_key_text(self):
        g, _, _ = _classify(SEND, {"text": "publish the video to the channel"})
        self.assertTrue(g)


class InterAgentContentSafe(unittest.TestCase):
    """TRUE-NEGATIVE: benign nudges MUST NOT block (avoid FP churn, H3)."""

    def test_benign_nudge(self):
        g, _, _ = _classify(SEND, {"message": "any progress on card 05c1671f? deadline today"})
        self.assertFalse(g)

    def test_benign_status_question(self):
        g, _, _ = _classify(SEND, {"message": "can you review the spec draft when free?"})
        self.assertFalse(g)

    def test_benign_merge_the_branch(self):
        # H3 FP-boundary: routine phrasing that must NOT trip the matcher.
        g, _, _ = _classify(SEND, {"message": "I will merge the feature branch into develop"})
        self.assertFalse(g)

    def test_internal_thread_post_fp_is_core_pending_H3(self):
        # KNOWN LIMITATION, not this hook's bug: the merged risky_content core
        # (PR #883) still carries the BROAD 'post to' stem; the spec §2.3.1 H3
        # narrowing (bind 'post to' to external publish only) is a SEPARATE
        # step-5 hardening AC that has NOT shipped yet. So an internal
        # 'post-to-thread' message currently over-matches (fail-closed bias =
        # one extra ask-first click, acceptable per H3). This test PINS that
        # dependency: when H3 lands it should flip to assertFalse. The hook
        # delegates faithfully; it does not re-implement the stem logic.
        g, _, _ = _classify(SEND, {"message": "add-comment-and-post-to-thread please"})
        self.assertTrue(g)


class InterAgentGreyZone(unittest.TestCase):
    """Grey-zone on the send surface MUST fail-closed to risky."""

    def test_no_content_field_blocks(self):
        # Matched send tool but no inspectable content -> cannot prove SAFE.
        g, _, _ = _classify(SEND, {"to": "dave"})
        self.assertTrue(g)

    def test_empty_content_blocks(self):
        g, _, _ = _classify(SEND, {"message": "   "})
        self.assertTrue(g)

    def test_non_dict_input_blocks_on_guarded_tool(self):
        g, _, _ = guard.classify({"tool_name": SEND, "tool_input": None})
        self.assertTrue(g, "guarded tool + un-inspectable input must fail-closed")


# ---------------------------------------------------------------------------
# RK-02 / PARKED: kanban status / marker.
# ---------------------------------------------------------------------------
class KanbanDoneRisky(unittest.TestCase):
    def test_status_done_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "status": "done"})
        self.assertTrue(g)

    def test_status_done_case_space_evasion(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "status": "  Done "})
        self.assertTrue(g)

    def test_alt_status_key(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "to_status": "done"})
        self.assertTrue(g)


class KanbanParkedMarkerRisky(unittest.TestCase):
    def test_parked_marker_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "marker": "PARKED"})
        self.assertTrue(g)

    def test_awaiting_dominik_marker_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "tag": "awaiting-dominik"})
        self.assertTrue(g)

    def test_parked_marker_with_safe_status_still_blocks(self):
        # Adversarial: hide a park behind a benign status advance.
        g, _, _ = _classify(KANBAN, {"id": "abc", "status": "in_progress", "label": "parked: waiting on boss"})
        self.assertTrue(g)


class KanbanSafe(unittest.TestCase):
    """TRUE-NEGATIVE: autonomous status ADVANCE and create stay SAFE (§2.3)."""

    def test_advance_to_in_progress(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "status": "in_progress"})
        self.assertFalse(g)

    def test_advance_to_waiting(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "status": "waiting"})
        self.assertFalse(g)

    def test_advance_to_planned(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "status": "planned"})
        self.assertFalse(g)

    def test_field_edit_no_status_no_marker(self):
        # A note/title edit with no status and no risky marker is SAFE.
        g, _, _ = _classify(KANBAN, {"id": "abc", "note": "advanced the repro"})
        self.assertFalse(g)

    def test_benign_tag(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "tag": "backend"})
        self.assertFalse(g)


# ---------------------------------------------------------------------------
# RK-03: shared-tier memory OVERWRITE.
# ---------------------------------------------------------------------------
class SharedMemoryOverwriteRisky(unittest.TestCase):
    def test_shared_overwrite_flag(self):
        g, _, _ = _classify(MEMORY, {"tier": "shared", "text": "x", "overwrite": True})
        self.assertTrue(g)

    def test_shared_replace_flag(self):
        g, _, _ = _classify(MEMORY, {"tier": "shared", "text": "x", "replace": True})
        self.assertTrue(g)

    def test_shared_existing_id(self):
        g, _, _ = _classify(MEMORY, {"tier": "shared", "text": "x", "existing_id": 42})
        self.assertTrue(g)

    def test_shared_alt_tier_key_category(self):
        g, _, _ = _classify(MEMORY, {"category": "shared", "text": "x", "update_existing": True})
        self.assertTrue(g)

    def test_shared_overwrite_disguised_tierless(self):
        # Adversarial (c): overwrite with the tier field omitted -> cannot prove
        # the non-shared/new SAFE case -> fail-closed.
        g, _, _ = _classify(MEMORY, {"text": "x", "overwrite": True})
        self.assertTrue(g)


class SharedMemorySafe(unittest.TestCase):
    """TRUE-NEGATIVE: new shared entry + any hot/warm/cold write stay SAFE."""

    def test_shared_new_entry(self):
        g, _, _ = _classify(MEMORY, {"tier": "shared", "text": "new lesson"})
        self.assertFalse(g)

    def test_hot_overwrite_is_safe(self):
        g, _, _ = _classify(MEMORY, {"tier": "hot", "text": "x", "overwrite": True})
        self.assertFalse(g)

    def test_warm_write(self):
        g, _, _ = _classify(MEMORY, {"tier": "warm", "text": "config"})
        self.assertFalse(g)

    def test_cold_overwrite_is_safe(self):
        g, _, _ = _classify(MEMORY, {"tier": "cold", "text": "x", "replace": True})
        self.assertFalse(g)


# ---------------------------------------------------------------------------
# Matched-surface scoping: a tool on NO guarded surface always passes.
# ---------------------------------------------------------------------------
class NonGuardedPassThrough(unittest.TestCase):
    def test_unknown_tool_with_risky_text_passes(self):
        # A risky-looking string on an unguarded tool is NOT this hook's surface.
        g, _, _ = _classify("Bash", {"command": "deploy prod && merge to main"})
        self.assertFalse(g)

    def test_read_tool_passes(self):
        g, _, _ = _classify("Read", {"file_path": "/x"})
        self.assertFalse(g)

    def test_non_dict_payload_passes(self):
        g, _, _ = guard.classify("nope")
        self.assertFalse(g)

    def test_non_dict_input_on_unguarded_tool_passes(self):
        g, _, _ = guard.classify({"tool_name": "Bash", "tool_input": None})
        self.assertFalse(g)


# ---------------------------------------------------------------------------
# Pure approval-marker + decision layer (shared ask-first channel).
# ---------------------------------------------------------------------------
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


class ActionTokenTests(unittest.TestCase):
    def test_stable_and_key_order_independent(self):
        a = guard.action_token(SEND, {"message": "deploy", "to": "x"})
        b = guard.action_token(SEND, {"to": "x", "message": "deploy"})
        self.assertEqual(a, b)

    def test_differs_on_input_change(self):
        a = guard.action_token(SEND, {"message": "deploy"})
        b = guard.action_token(SEND, {"message": "delete"})
        self.assertNotEqual(a, b)


# ---------------------------------------------------------------------------
# End-to-end: real hook over stdin -> exit code + marker side effects.
# ---------------------------------------------------------------------------
class EndToEndTests(unittest.TestCase):
    def _run(self, payload_or_raw, approvals_dir, raw=False):
        env = dict(os.environ, ASK_APPROVALS_DIR=approvals_dir)
        data = payload_or_raw if raw else json.dumps(payload_or_raw)
        return subprocess.run(
            [sys.executable, _HOOK], input=data,
            capture_output=True, text=True, env=env,
        )

    def test_risky_send_blocks_and_writes_pending(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": SEND, "tool_input": {"message": "deploy prod now"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2)
            self.assertIn("RISKY-GATE", r.stderr)
            token = guard.action_token(SEND, {"message": "deploy prod now"})
            self.assertIn(token, r.stderr)
            self.assertTrue(os.path.exists(os.path.join(appr, token + ".pending")))

    def test_kanban_done_blocks(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": KANBAN, "tool_input": {"id": "abc", "status": "done"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2)

    def test_shared_overwrite_blocks(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": MEMORY, "tool_input": {"tier": "shared", "text": "x", "overwrite": True}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2)

    def test_benign_send_passes(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": SEND, "tool_input": {"message": "any progress on the card?"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(os.listdir(appr), [], "benign call must not write a marker")

    def test_safe_advance_passes(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": KANBAN, "tool_input": {"id": "abc", "status": "in_progress"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 0)

    def test_fresh_marker_allows_and_consumes(self):
        with tempfile.TemporaryDirectory() as appr:
            inp = {"message": "deploy prod now"}
            token = guard.action_token(SEND, inp)
            marker = os.path.join(appr, token + ".approved")
            open(marker, "w").close()
            r = self._run({"tool_name": SEND, "tool_input": inp}, appr)
            self.assertEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(marker), "marker must be consumed (one-shot)")

    def test_stale_marker_reblocks(self):
        with tempfile.TemporaryDirectory() as appr:
            inp = {"message": "deploy prod now"}
            token = guard.action_token(SEND, inp)
            marker = os.path.join(appr, token + ".approved")
            open(marker, "w").close()
            old = time.time() - guard.APPROVAL_TTL_SECONDS - 10
            os.utime(marker, (old, old))
            r = self._run({"tool_name": SEND, "tool_input": inp}, appr)
            self.assertEqual(r.returncode, 2)

    def test_malformed_stdin_for_guarded_tool_fails_closed(self):
        # assertion-direction-check falsifier: the INVERSE of the fail-open
        # sibling. A payload that names a GUARDED tool but is otherwise
        # un-inspectable (non-dict input) must BLOCK, not allow.
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": SEND, "tool_input": None}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2, "guarded tool + un-inspectable input must block")

    def test_malformed_stdin_unguarded_passes(self):
        # Broken JSON (no identifiable guarded surface) -> pass (scoped).
        with tempfile.TemporaryDirectory() as appr:
            r = self._run("{ broken", appr, raw=True)
            self.assertEqual(r.returncode, 0)

    def test_unguarded_tool_passes_e2e(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": "Bash", "tool_input": {"command": "deploy && merge to main"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(os.listdir(appr), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
