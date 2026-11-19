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

    # --- GAP 2 (Chad A2): non-standard status-key aliases must still catch
    # a ->done transition. Each covers the status-key-coverage bypass class. ---
    def test_final_status_done_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "final_status": "done"})
        self.assertTrue(g)

    def test_target_status_done_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "target_status": "done"})
        self.assertTrue(g)

    def test_new_status_done_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "new_status": "done"})
        self.assertTrue(g)

    def test_set_status_done_case_space_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "set_status": " DONE "})
        self.assertTrue(g)

    def test_status_to_done_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "status_to": "done"})
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

    # --- GAP 1 (Thor FLAG): boolean/numeric park bypass. _first_str returns
    # None for a non-string value, so a {park: True} park signal must be caught
    # by the _any_truthy pre-check, not slip through as SAFE. ---
    def test_boolean_park_true_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "park": True})
        self.assertTrue(g, "boolean park flag must fail-closed to risky")

    def test_boolean_parked_true_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "parked": True})
        self.assertTrue(g)

    def test_numeric_park_one_blocks(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "park": 1})
        self.assertTrue(g)

    def test_boolean_park_hidden_behind_safe_status_blocks(self):
        # Adversarial: pair the boolean park with a benign status advance.
        g, _, _ = _classify(KANBAN, {"id": "abc", "status": "in_progress", "park": True})
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

    # --- GAP 2 inverse-direction pin: a benign (non-done) value on a NEWLY
    # covered status-key alias must stay SAFE (the widened key set must not
    # over-block an ordinary status write). ---
    def test_final_status_in_progress_is_safe(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "final_status": "in_progress"})
        self.assertFalse(g, "benign value on an aliased status key must stay SAFE")

    def test_target_status_waiting_is_safe(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "target_status": "waiting"})
        self.assertFalse(g)

    # --- GAP 2 false-positive boundary: a PROSE field that merely contains the
    # word "done" is NOT a status key and must NOT be flagged. ---
    def test_prose_note_containing_done_is_safe(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "note": "marked the subtask as done in the comment"})
        self.assertFalse(g, "the word 'done' in prose is not a status transition")

    # --- GAP 1 inverse-direction pin: a FALSY park flag does not establish a
    # park -> with no other risky signal the write stays SAFE. ---
    def test_park_false_flag_is_safe(self):
        g, _, _ = _classify(KANBAN, {"id": "abc", "park": False, "status": "in_progress"})
        self.assertFalse(g, "a falsy park flag must not fail-closed")


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

    def test_boolean_park_blocks_e2e(self):
        # GAP 1 over real stdin-JSON: {park: True} now BLOCKS (exit 2).
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": KANBAN, "tool_input": {"id": "abc", "park": True}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2)
            self.assertIn("RISKY-GATE", r.stderr)

    def test_final_status_done_blocks_e2e(self):
        # GAP 2 over real stdin-JSON: a non-standard status key now BLOCKS.
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": KANBAN, "tool_input": {"id": "abc", "final_status": "done"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2)

    def test_park_false_passes_e2e(self):
        # GAP 1 benign boundary over real stdin-JSON: a falsy park flag passes.
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": KANBAN, "tool_input": {"id": "abc", "park": False, "status": "in_progress"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(os.listdir(appr), [])

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


# ===========================================================================
# CONVERGENCE SWEEP (card ab9b14db): all-scan hardening + exhaustive
# self-adversarial bypass sweep. Every class below is probed; a FOUND bypass
# ships a red->green fixture, an ALREADY-SAFE class ships a pinning fixture, and
# an ACCEPTED-DESIGN-LIMIT class is documented as a pin.
# ===========================================================================


class MultiFieldStatusAllScan(unittest.TestCase):
    """PRIMARY bug (Chad #1036 advisory): first-wins over _STATUS_KEYS let a
    'done' on an ALIAS key hide behind a benign value on an earlier key. All-scan
    must flag if ANY status-key value normalizes to 'done'."""

    def test_benign_first_done_on_alias_blocks(self):
        g, _, _ = _classify(KANBAN, {"status": "in_progress", "final_status": "done"})
        self.assertTrue(g, "done on a later alias key must not hide behind a benign status")

    def test_done_first_benign_later_blocks(self):
        # key-order independence: dangerous value first still blocks.
        g, _, _ = _classify(KANBAN, {"final_status": "done", "status": "in_progress"})
        self.assertTrue(g)

    def test_multi_alias_all_benign_is_safe(self):
        # inverse direction: several alias keys, none 'done' -> SAFE (no over-block).
        g, _, _ = _classify(KANBAN, {"status": "in_progress", "new_status": "waiting", "target_status": "planned"})
        self.assertFalse(g, "several benign status aliases must stay SAFE")

    def test_done_case_space_on_alias_blocks(self):
        g, _, _ = _classify(KANBAN, {"status": "waiting", "set_status": "  DONE "})
        self.assertTrue(g)


class MultiFieldMarkerAllScan(unittest.TestCase):
    """first-wins over _MARKER_KEYS let a risky marker on a later key hide behind
    a benign marker on an earlier key."""

    def test_benign_marker_first_parked_on_alias_blocks(self):
        g, _, _ = _classify(KANBAN, {"marker": "backend", "label": "parked"})
        self.assertTrue(g, "a park on a later marker alias must not hide behind a benign marker")

    def test_awaiting_dominik_on_alias_blocks(self):
        g, _, _ = _classify(KANBAN, {"tag": "frontend", "marker": "awaiting-dominik"})
        self.assertTrue(g)

    def test_all_benign_markers_safe(self):
        g, _, _ = _classify(KANBAN, {"marker": "backend", "label": "frontend", "tag": "infra"})
        self.assertFalse(g, "several benign markers must stay SAFE")


class MultiFieldContentAllScan(unittest.TestCase):
    """first-wins over _CONTENT_KEYS let a risky instruction on a later key hide
    behind a benign body on an earlier key."""

    def test_benign_message_risky_content_blocks(self):
        g, _, _ = _classify(SEND, {"message": "hi there", "content": "deploy prod now"})
        self.assertTrue(g, "risky instruction on a later content alias must block")

    def test_benign_body_risky_text_blocks(self):
        g, _, _ = _classify(SEND, {"body": "status update", "text": "delete the prod bucket"})
        self.assertTrue(g)

    def test_all_benign_content_keys_safe(self):
        g, _, _ = _classify(SEND, {"message": "hi", "content": "any update on the card?"})
        self.assertFalse(g, "several benign content values must stay SAFE")


class MultiFieldTierAllScan(unittest.TestCase):
    """first-wins over _TIER_KEYS let a benign tier on an earlier key hide the
    'shared' tier declared on a later alias key, slipping a shared overwrite."""

    def test_benign_tier_shared_on_alias_overwrite_blocks(self):
        g, _, _ = _classify(MEMORY, {"tier": "hot", "category": "shared", "overwrite": True})
        self.assertTrue(g, "a shared tier on a later alias key must not hide behind a benign tier")

    def test_shared_scope_alias_replace_blocks(self):
        g, _, _ = _classify(MEMORY, {"tier": "warm", "scope": "shared", "replace": True})
        self.assertTrue(g)

    def test_all_benign_tiers_safe(self):
        g, _, _ = _classify(MEMORY, {"tier": "hot", "category": "warm", "overwrite": True})
        self.assertFalse(g, "several non-shared tier aliases must stay SAFE")

    def test_shared_alias_new_entry_safe(self):
        # inverse: shared declared on an alias but NO overwrite signal -> new -> SAFE.
        g, _, _ = _classify(MEMORY, {"tier": "hot", "category": "shared", "text": "new lesson"})
        self.assertFalse(g)


class TypeConfusionNestedValues(unittest.TestCase):
    """GAP1 generalized: a dangerous value wrapped in a list/dict must NOT read as
    SAFE just because a plain str-only check saw no string. _walk_strings recurses."""

    def test_status_done_in_list_blocks(self):
        g, _, _ = _classify(KANBAN, {"status": ["done"]})
        self.assertTrue(g, "done wrapped in a list must still block")

    def test_status_done_in_dict_value_blocks(self):
        g, _, _ = _classify(KANBAN, {"status": {"to": "done"}})
        self.assertTrue(g)

    def test_status_done_in_list_of_dict_blocks(self):
        g, _, _ = _classify(KANBAN, {"new_status": [{"phase": "done"}]})
        self.assertTrue(g)

    def test_marker_parked_in_dict_blocks(self):
        g, _, _ = _classify(KANBAN, {"marker": {"x": "parked"}})
        self.assertTrue(g, "a parked marker nested in a dict must still block")

    def test_content_risky_in_list_blocks(self):
        g, _, _ = _classify(SEND, {"message": ["hi", "deploy prod now"]})
        self.assertTrue(g)

    def test_content_risky_in_dict_value_blocks(self):
        g, _, _ = _classify(SEND, {"content": {"instr": "delete the bucket"}})
        self.assertTrue(g)

    def test_tier_shared_in_list_blocks(self):
        g, _, _ = _classify(MEMORY, {"tier": ["shared"], "overwrite": True})
        self.assertTrue(g)

    # inverse-direction pins: benign nested values must stay SAFE (no over-block).
    def test_status_in_progress_in_list_safe(self):
        g, _, _ = _classify(KANBAN, {"status": ["in_progress"]})
        self.assertFalse(g, "a benign status in a list must stay SAFE")

    def test_benign_marker_in_list_safe(self):
        g, _, _ = _classify(KANBAN, {"marker": ["backend", "infra"]})
        self.assertFalse(g)


class DepthAndBudgetFailClosed(unittest.TestCase):
    """A value too deeply nested OR a huge fan-out that exhausts the node budget
    is UN-INSPECTABLE on a guarded surface -> must fail CLOSED (risky), never
    silently SAFE. Shallow benign values stay SAFE."""

    def test_deep_done_beyond_bound_fails_closed(self):
        node = {}
        cur = node
        for _ in range(_DEEP_DEPTH):
            cur["n"] = {}
            cur = cur["n"]
        cur["v"] = "done"
        g, _, _ = _classify(KANBAN, {"status": node})
        self.assertTrue(g, "a done buried below the depth bound must fail-closed, not pass")

    def test_deep_benign_beyond_bound_also_fails_closed(self):
        # By design the bound makes any too-deep value fail-closed regardless of
        # content (we could not inspect it). This over-blocks a pathological-but-
        # benign blob -- acceptable fail-closed bias on the guarded surface.
        node = {}
        cur = node
        for _ in range(_DEEP_DEPTH):
            cur["n"] = {}
            cur = cur["n"]
        cur["v"] = "in_progress"
        g, _, _ = _classify(KANBAN, {"status": node})
        self.assertTrue(g, "un-inspectable depth fails closed by design")

    def test_shallow_nesting_still_inspected(self):
        # The bound must be generous enough that realistic shallow nesting is
        # fully inspected, not falsely truncated.
        g, _, _ = _classify(KANBAN, {"status": {"a": {"b": {"c": "in_progress"}}}})
        self.assertFalse(g, "shallow benign nesting must be inspected, not over-blocked")

    def test_huge_fanout_list_fails_closed_fast(self):
        # Resource-exhaustion / DoS: a massive fan-out must bound total work AND
        # fail closed (cannot prove SAFE). It must also be fast (node budget).
        big = ["x"] * 500000
        start = time.time()
        g, _, _ = _classify(SEND, {"message": big})
        elapsed = time.time() - start
        self.assertTrue(g, "a huge fan-out exceeding the node budget must fail-closed")
        self.assertLess(elapsed, 5.0, "the node budget must keep the scan fast (no DoS)")


class OverwriteIdentityKeyPresence(unittest.TestCase):
    """Identity overwrite keys (existing_id/entry_id) signal overwrite by
    PRESENCE, not truthiness: a truthy-only check missed existing_id=0 / '' and
    let a shared overwrite of entry 0 slip through as SAFE (fail-open)."""

    def test_existing_id_zero_blocks(self):
        g, _, _ = _classify(MEMORY, {"tier": "shared", "existing_id": 0})
        self.assertTrue(g, "existing_id=0 is still an overwrite of an existing entry")

    def test_existing_id_empty_string_blocks(self):
        g, _, _ = _classify(MEMORY, {"tier": "shared", "existing_id": ""})
        self.assertTrue(g)

    def test_entry_id_present_blocks(self):
        g, _, _ = _classify(MEMORY, {"tier": "shared", "entry_id": 7})
        self.assertTrue(g)

    def test_shared_no_identity_no_flag_is_new_safe(self):
        # inverse: no overwrite signal of any kind -> new shared entry -> SAFE.
        g, _, _ = _classify(MEMORY, {"tier": "shared", "text": "new"})
        self.assertFalse(g)

    def test_identity_key_on_non_shared_is_safe(self):
        # identity presence only matters on the shared tier.
        g, _, _ = _classify(MEMORY, {"tier": "hot", "existing_id": 0})
        self.assertFalse(g)


class NormalizationPinsAndDesignLimits(unittest.TestCase):
    """Content normalization classes: pin the ones the merged risky_content core
    already resists, and DOCUMENT the accepted design limits (not fixed here)."""

    # --- ALREADY-SAFE, pinned so they can't regress ---
    def test_combining_marks_still_caught(self):
        # NFKD strips combining accents: "d{combining}eploy" -> "deploy".
        g, _, _ = _classify(SEND, {"message": "d́́eploy the server"})
        self.assertTrue(g, "combining marks around a stem must still be caught")

    def test_bidi_marks_still_caught(self):
        # RLO/PDF bidi controls survive normalize() but are dropped by the
        # collapsed (non-alnum-stripped) surface, so the stem still matches.
        g, _, _ = _classify(SEND, {"message": "de‮ploy‬ now"})
        self.assertTrue(g, "bidi control chars must not break stem matching")

    def test_zero_width_inside_stem_still_caught(self):
        g, _, _ = _classify(SEND, {"message": "de​ploy now"})
        self.assertTrue(g)

    def test_separator_and_case_still_caught(self):
        g, _, _ = _classify(SEND, {"message": "D.E.P.L.O.Y now"})
        self.assertTrue(g)

    # --- ACCEPTED DESIGN LIMITS (documented, deliberately NOT fixed here) ---
    def test_homoglyph_is_accepted_design_limit(self):
        # Cyrillic 'e' (U+0435) in "deploy" is a HOMOGLYPH, not an accent/combining
        # mark, so NFKD does not fold it. Per the risky_content SCOPE comment and
        # the prior gate, homoglyph resistance is OUT OF SCOPE for this sender-side
        # tripwire; the RECEIVING agent is the second line of defence. This pin
        # documents the boundary (currently NOT flagged) -- do not "fix" it here.
        g, _, _ = _classify(SEND, {"message": "dеploy now"})
        self.assertFalse(g, "homoglyph evasion is an accepted design limit (receiver is 2nd line)")

    def test_elongated_chars_is_accepted_design_limit(self):
        # Character INSERTION ("deeeeploy") is the same determined-obfuscation
        # class as homoglyph: out of scope for the keyword tripwire.
        g, _, _ = _classify(SEND, {"message": "deeeeploy now"})
        self.assertFalse(g, "elongated-char evasion is an accepted design limit")


class ReDoSAbsence(unittest.TestCase):
    """The content core is a pure substring matcher (no regex), so there is no
    catastrophic-backtracking surface. Pin linear-time behaviour on adversarial
    separator/whitespace blowups (regex-redos-patterns)."""

    def test_separator_blowup_linear(self):
        payload = "d" + "-" * 200000 + "eploy"
        start = time.time()
        _classify(SEND, {"message": payload})
        self.assertLess(time.time() - start, 3.0)

    def test_whitespace_blowup_linear(self):
        payload = " " * 500000 + "deploy"
        start = time.time()
        _classify(SEND, {"message": payload})
        self.assertLess(time.time() - start, 3.0)


class OverBlockGuard(unittest.TestCase):
    """Convergence requirement: the hardening must NOT brick unrelated autopilot
    work. A tool on no guarded surface, and benign guarded calls, still pass."""

    def test_unguarded_tool_with_nested_risky_passes(self):
        g, _, _ = _classify("Bash", {"command": {"nested": "deploy prod"}})
        self.assertFalse(g, "a non-guarded tool is never this hook's surface")

    def test_benign_guarded_calls_all_pass(self):
        self.assertFalse(_classify(KANBAN, {"id": "x", "status": "in_progress"})[0])
        self.assertFalse(_classify(MEMORY, {"tier": "warm", "text": "cfg"})[0])
        self.assertFalse(_classify(SEND, {"message": "deadline today, any progress?"})[0])


class EndToEndConvergence(unittest.TestCase):
    """Real hook over stdin: the multi-field core bug and the newly-found
    bypasses BLOCK (exit 2); representative benign cases PASS (exit 0)."""

    def _run(self, payload, approvals_dir):
        env = dict(os.environ, ASK_APPROVALS_DIR=approvals_dir)
        return subprocess.run(
            [sys.executable, _HOOK], input=json.dumps(payload),
            capture_output=True, text=True, env=env,
        )

    def test_multifield_status_alias_blocks_e2e(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": KANBAN, "tool_input": {"status": "in_progress", "final_status": "done"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2, "the Chad #1036 multi-field case must BLOCK e2e")
            self.assertIn("RISKY-GATE", r.stderr)

    def test_status_done_in_list_blocks_e2e(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": KANBAN, "tool_input": {"status": ["done"]}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2)

    def test_content_alias_blocks_e2e(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": SEND, "tool_input": {"message": "hi", "content": "deploy prod now"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2)

    def test_tier_alias_overwrite_blocks_e2e(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": MEMORY, "tool_input": {"tier": "hot", "category": "shared", "overwrite": True}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2)

    def test_existing_id_zero_blocks_e2e(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": MEMORY, "tool_input": {"tier": "shared", "existing_id": 0}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 2)

    def test_benign_multifield_passes_e2e(self):
        with tempfile.TemporaryDirectory() as appr:
            payload = {"tool_name": KANBAN, "tool_input": {"status": "in_progress", "new_status": "waiting"}}
            r = self._run(payload, appr)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(os.listdir(appr), [], "benign multi-field call must not write a marker")


# Depth constant for the depth-bound tests: comfortably beyond the hook's bound.
_DEEP_DEPTH = guard._WALK_MAX_DEPTH + 6


if __name__ == "__main__":
    unittest.main(verbosity=2)
