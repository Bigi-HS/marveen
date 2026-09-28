#!/usr/bin/env python3
"""Tests for DA post-run finding-followup scheduler (card 76c6be72).

AC1: T3 run with >= 1 CRITICAL finding creates a follow-up task at completion
     (sentinel has follow_up_scheduled=True + follow_up_task_name set)
AC2: Follow-up fires at 72h if no reply from triggering agent
AC3: No follow-up fires if triggering agent replied within 72h
AC4: Sentinel JSON includes follow_up_scheduled field
AC5: T1/T2 runs with only MEDIUM/LOW findings do NOT create follow-up task
     (follow_up_scheduled=False)
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

_THIS_DIR = Path(__file__).resolve().parent
_MODULE_PATH = _THIS_DIR.parent / "da-followup-check.py"

_spec = importlib.util.spec_from_file_location("da_followup_check", _MODULE_PATH)
assert _spec and _spec.loader, f"cannot load {_MODULE_PATH}"
mod = importlib.util.module_from_spec(_spec)
sys.modules["da_followup_check"] = mod
_spec.loader.exec_module(mod)

FOLLOWUP_DELAY = 72 * 3600  # 72h in seconds


def _make_sentinel(critical_count=0, high_block_count=0, trigger="T3", run_id="abc12345",
                   completed_at="2026-09-22T10:00:00+02:00", findings=None):
    """Build a minimal sentinel dict for testing."""
    s = {
        "trigger": trigger,
        "id": run_id,
        "completed_at": completed_at,
        "critical_count": critical_count,
        "high_block_count": high_block_count,
        "triggering_agent": "dave",
        "run_ts": 1790000000,
    }
    if findings is not None:
        s["findings"] = findings
    return s


class ShouldScheduleFollowupTests(unittest.TestCase):
    """AC1 + AC5: logic gate deciding whether a follow-up task should be created."""

    def test_critical_finding_triggers_followup(self):
        # AC1
        sentinel = _make_sentinel(critical_count=1)
        self.assertTrue(mod.should_schedule_followup(sentinel))

    def test_high_block_finding_triggers_followup(self):
        # AC1 (HIGH BLOCK counts too)
        sentinel = _make_sentinel(high_block_count=1)
        self.assertTrue(mod.should_schedule_followup(sentinel))

    def test_both_critical_and_high_triggers_followup(self):
        sentinel = _make_sentinel(critical_count=2, high_block_count=1)
        self.assertTrue(mod.should_schedule_followup(sentinel))

    def test_medium_low_only_no_followup(self):
        # AC5: only MEDIUM/LOW -> no follow-up
        sentinel = _make_sentinel(critical_count=0, high_block_count=0)
        self.assertFalse(mod.should_schedule_followup(sentinel))

    def test_t1_with_no_critical_no_followup(self):
        # AC5: T1 with only MEDIUM findings
        sentinel = _make_sentinel(trigger="T1", critical_count=0, high_block_count=0)
        self.assertFalse(mod.should_schedule_followup(sentinel))

    def test_t2_with_no_critical_no_followup(self):
        # AC5
        sentinel = _make_sentinel(trigger="T2", critical_count=0, high_block_count=0)
        self.assertFalse(mod.should_schedule_followup(sentinel))


class SentinelSchemaTests(unittest.TestCase):
    """AC4: sentinel JSON must include follow_up_scheduled (and follow_up_task_name when True)."""

    def test_build_followup_fields_true(self):
        # AC4 + AC1
        task_name = "da-followup-T3-abc12345"
        fields = mod.build_followup_sentinel_fields(scheduled=True, task_name=task_name)
        self.assertIn("follow_up_scheduled", fields)
        self.assertTrue(fields["follow_up_scheduled"])
        self.assertIn("follow_up_task_name", fields)
        self.assertEqual(fields["follow_up_task_name"], task_name)

    def test_build_followup_fields_false(self):
        # AC5: low-severity run -> follow_up_scheduled=False, task_name=""
        fields = mod.build_followup_sentinel_fields(scheduled=False, task_name="")
        self.assertIn("follow_up_scheduled", fields)
        self.assertFalse(fields["follow_up_scheduled"])
        self.assertEqual(fields.get("follow_up_task_name", ""), "")

    def test_followup_task_name_format(self):
        name = mod.followup_task_name("T3", "abc12345")
        self.assertEqual(name, "da-followup-T3-abc12345")

    def test_followup_task_name_t1(self):
        name = mod.followup_task_name("T1", "deadbeef")
        self.assertEqual(name, "da-followup-T1-deadbeef")


class FollowupCheckTimingTests(unittest.TestCase):
    """AC2 + AC3: timing gate -- only act after 72h elapsed."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.token_file = os.path.join(self.tmpdir, "token")
        open(self.token_file, "w").write("testtoken123\n")

        # Sentinel with 1 CRITICAL finding
        self.run_ts = int(time.time()) - (FOLLOWUP_DELAY + 1)  # 72h+1s ago
        self.sentinel = _make_sentinel(
            critical_count=1,
            run_id="test1234",
            findings=[{"id": "F1", "severity": "CRITICAL", "label": "test-finding", "verdict": "BLOCK"}]
        )
        self.sentinel["run_ts"] = self.run_ts
        self.sentinel_path = os.path.join(self.tmpdir, "T3-test1234.json")
        with open(self.sentinel_path, "w") as f:
            json.dump(self.sentinel, f)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_too_early_does_nothing(self):
        # AC2: if < 72h elapsed, no action
        recent_run_ts = int(time.time()) - 100  # 100 seconds ago, way less than 72h
        result = mod.run_followup_check(
            sentinel_path=self.sentinel_path,
            task_name="da-followup-T3-test1234",
            triggering_agent="dave",
            run_ts=recent_run_ts,
            api_base="http://localhost:3420",
            token=self.token_file,
            _now=int(time.time()),
        )
        self.assertEqual(result, "too-early")

    def test_reply_found_no_followup_sent(self):
        # AC3: reply exists -> no follow-up, still self-deletes
        with patch.object(mod, "check_for_reply", return_value=True), \
             patch.object(mod, "send_followup_message") as mock_send, \
             patch.object(mod, "delete_task") as mock_delete:
            result = mod.run_followup_check(
                sentinel_path=self.sentinel_path,
                task_name="da-followup-T3-test1234",
                triggering_agent="dave",
                run_ts=self.run_ts,
                api_base="http://localhost:3420",
                token=self.token_file,
                _now=int(time.time()),
            )
        self.assertEqual(result, "replied")
        mock_send.assert_not_called()
        mock_delete.assert_called_once()

    def test_no_reply_followup_sent_and_self_deletes(self):
        # AC2: no reply after 72h -> send follow-up AND self-delete
        with patch.object(mod, "check_for_reply", return_value=False), \
             patch.object(mod, "send_followup_message") as mock_send, \
             patch.object(mod, "delete_task") as mock_delete:
            result = mod.run_followup_check(
                sentinel_path=self.sentinel_path,
                task_name="da-followup-T3-test1234",
                triggering_agent="dave",
                run_ts=self.run_ts,
                api_base="http://localhost:3420",
                token=self.token_file,
                _now=int(time.time()),
            )
        self.assertEqual(result, "sent")
        mock_send.assert_called_once()
        mock_delete.assert_called_once()

    def test_followup_message_contains_findings(self):
        # AC2: the follow-up message body includes the CRITICAL/HIGH findings
        captured = {}
        def fake_send(api_base, token, agent, findings, sentinel):
            captured["findings"] = findings
            captured["agent"] = agent

        with patch.object(mod, "check_for_reply", return_value=False), \
             patch.object(mod, "send_followup_message", side_effect=fake_send), \
             patch.object(mod, "delete_task"):
            mod.run_followup_check(
                sentinel_path=self.sentinel_path,
                task_name="da-followup-T3-test1234",
                triggering_agent="dave",
                run_ts=self.run_ts,
                api_base="http://localhost:3420",
                token=self.token_file,
                _now=int(time.time()),
            )
        self.assertEqual(captured.get("agent"), "dave")
        self.assertIsInstance(captured.get("findings"), list)
        self.assertGreater(len(captured["findings"]), 0)


class GetOpenCriticalHighTests(unittest.TestCase):
    """Helper: extract CRITICAL/HIGH BLOCK findings from sentinel."""

    def test_extracts_critical(self):
        sentinel = _make_sentinel(findings=[
            {"id": "F1", "severity": "CRITICAL", "verdict": "BLOCK", "label": "crit-finding"},
            {"id": "F2", "severity": "MEDIUM", "verdict": "FLAG", "label": "med-finding"},
        ])
        findings = mod.get_open_critical_high(sentinel)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["id"], "F1")

    def test_extracts_high_block(self):
        sentinel = _make_sentinel(findings=[
            {"id": "F1", "severity": "HIGH", "verdict": "BLOCK", "label": "high-block"},
            {"id": "F2", "severity": "HIGH", "verdict": "FLAG", "label": "high-flag"},
        ])
        findings = mod.get_open_critical_high(sentinel)
        # Only BLOCK verdict for HIGH counts
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["id"], "F1")

    def test_empty_findings_returns_empty(self):
        sentinel = _make_sentinel(findings=[])
        self.assertEqual(mod.get_open_critical_high(sentinel), [])

    def test_no_findings_key_returns_empty(self):
        sentinel = _make_sentinel()  # no findings key
        self.assertEqual(mod.get_open_critical_high(sentinel), [])


if __name__ == "__main__":
    unittest.main()
