#!/usr/bin/env python3
"""Unit tests for scripts/change-impact-log.py (Fleet-expansion Phase 1, Dave).

The change-impact-analysis skill's RUN-SIGNAL: every invocation appends one
validated JSONL line to store/change-impact-log.jsonl. The contract this test
pins (trigger-first rule, Chad+Dave):

  - a `ran` line carries findings_count and a decision, so ran+caught
    (findings>0) is distinguishable from ran+clean (findings==0);
  - a `skipped-trivial` line is ALSO logged (findings==0, decision=proceed), so
    a period with ZERO lines means the trigger itself never fired -- a
    detectable dead-skill -- not "nothing happened";
  - invalid enums / negative findings are rejected and append NOTHING (an
    honest telemetry file never holds a malformed row).

The target module has a hyphen in its name, so it is loaded via importlib.
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_MODULE_PATH = _THIS_DIR / "change-impact-log.py"

_spec = importlib.util.spec_from_file_location("change_impact_log", _MODULE_PATH)
assert _spec and _spec.loader, f"cannot load module at {_MODULE_PATH}"
cil = importlib.util.module_from_spec(_spec)
sys.modules["change_impact_log"] = cil
_spec.loader.exec_module(cil)


class BuildRecordTests(unittest.TestCase):
    def test_ran_caught_record_has_all_fields(self):
        rec = cil.build_record(
            agent="dave", change_ref="pr#500", classification="ran",
            findings=3, top_risk="live-vs-source delta", decision="mitigate",
        )
        self.assertEqual(rec["agent"], "dave")
        self.assertEqual(rec["change_ref"], "pr#500")
        self.assertEqual(rec["classification"], "ran")
        self.assertEqual(rec["findings_count"], 3)
        self.assertEqual(rec["top_risk"], "live-vs-source delta")
        self.assertEqual(rec["decision"], "mitigate")
        # ts is stamped and carries a timezone offset (Europe/Budapest).
        self.assertIn("ts", rec)
        self.assertRegex(rec["ts"], r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*[+-]\d{2}:\d{2}")

    def test_ran_clean_is_logged_not_dropped(self):
        # ran + zero findings is a REAL signal (clean != absent), must build.
        rec = cil.build_record(
            agent="dave", change_ref="abc123", classification="ran",
            findings=0, top_risk="", decision="proceed",
        )
        self.assertEqual(rec["classification"], "ran")
        self.assertEqual(rec["findings_count"], 0)

    def test_skipped_trivial_is_valid(self):
        rec = cil.build_record(
            agent="kidd", change_ref="branch/x", classification="skipped-trivial",
            findings=0, top_risk="", decision="proceed",
        )
        self.assertEqual(rec["classification"], "skipped-trivial")
        self.assertEqual(rec["findings_count"], 0)
        self.assertEqual(rec["decision"], "proceed")

    def test_skipped_trivial_with_findings_rejected(self):
        # A skip means no analysis ran -> it cannot carry findings.
        with self.assertRaises(ValueError):
            cil.build_record(
                agent="dave", change_ref="x", classification="skipped-trivial",
                findings=2, top_risk="", decision="proceed",
            )

    def test_skipped_trivial_non_proceed_rejected(self):
        with self.assertRaises(ValueError):
            cil.build_record(
                agent="dave", change_ref="x", classification="skipped-trivial",
                findings=0, top_risk="", decision="hold",
            )

    def test_invalid_classification_rejected(self):
        with self.assertRaises(ValueError):
            cil.build_record(
                agent="dave", change_ref="x", classification="maybe",
                findings=0, top_risk="", decision="proceed",
            )

    def test_invalid_decision_rejected(self):
        with self.assertRaises(ValueError):
            cil.build_record(
                agent="dave", change_ref="x", classification="ran",
                findings=1, top_risk="r", decision="ship-it",
            )

    def test_negative_findings_rejected(self):
        with self.assertRaises(ValueError):
            cil.build_record(
                agent="dave", change_ref="x", classification="ran",
                findings=-1, top_risk="r", decision="proceed",
            )

    def test_empty_agent_or_change_ref_rejected(self):
        with self.assertRaises(ValueError):
            cil.build_record(
                agent="", change_ref="x", classification="ran",
                findings=0, top_risk="", decision="proceed",
            )
        with self.assertRaises(ValueError):
            cil.build_record(
                agent="dave", change_ref="  ", classification="ran",
                findings=0, top_risk="", decision="proceed",
            )


class AppendTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.log = Path(self._tmp.name) / "change-impact-log.jsonl"

    def tearDown(self):
        self._tmp.cleanup()

    def test_append_writes_one_json_line(self):
        rec = cil.build_record(
            agent="dave", change_ref="pr#500", classification="ran",
            findings=2, top_risk="feedback loop", decision="mitigate",
        )
        cil.append_record(rec, self.log)
        lines = self.log.read_text().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["change_ref"], "pr#500")

    def test_append_does_not_clobber_existing(self):
        a = cil.build_record(agent="dave", change_ref="one", classification="ran",
                             findings=1, top_risk="r", decision="proceed")
        b = cil.build_record(agent="dave", change_ref="two", classification="skipped-trivial",
                             findings=0, top_risk="", decision="proceed")
        cil.append_record(a, self.log)
        cil.append_record(b, self.log)
        lines = self.log.read_text().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0])["change_ref"], "one")
        self.assertEqual(json.loads(lines[1])["change_ref"], "two")

    def test_cli_valid_appends_and_exit_zero(self):
        rc = cil.main([
            "--agent", "dave", "--change-ref", "deploy-0822",
            "--classification", "ran", "--findings", "1",
            "--top-risk", "volatile instrument", "--decision", "hold",
            "--log-path", str(self.log),
        ])
        self.assertEqual(rc, 0)
        lines = self.log.read_text().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["decision"], "hold")

    def test_cli_invalid_writes_nothing_and_exit_nonzero(self):
        rc = cil.main([
            "--agent", "dave", "--change-ref", "x",
            "--classification", "bogus", "--decision", "proceed",
            "--log-path", str(self.log),
        ])
        self.assertNotEqual(rc, 0)
        self.assertFalse(self.log.exists(), "malformed row must not be written")


if __name__ == "__main__":
    unittest.main()
