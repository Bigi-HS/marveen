#!/usr/bin/env python3
"""Unit tests for hibiki-countdown (stdlib unittest only).

Run: python3 scripts/test_hibiki_countdown.py
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "hibiki_countdown", os.path.join(_HERE, "hibiki-countdown.py")
)
cd = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(cd)

SIG = "TESZT-SZIGNATURA"


class BuildRoundPhases(unittest.TestCase):
    def test_no_rest_gives_one_phase_per_round(self):
        phases = cd.build_round_phases(4, 60, 0, "Kor", "Pihi")
        self.assertEqual(len(phases), 4)
        self.assertTrue(all(p["kind"] == "work" for p in phases))
        self.assertTrue(all(p["seconds"] == 60 for p in phases))
        self.assertEqual(phases[0]["label"], "Kor 1/4")
        self.assertEqual(phases[3]["label"], "Kor 4/4")

    def test_rest_inserted_between_not_after_last(self):
        phases = cd.build_round_phases(3, 40, 20, "Munka", "Pihi")
        # work, rest, work, rest, work  -> 5 phases, no trailing rest
        self.assertEqual([p["kind"] for p in phases],
                         ["work", "rest", "work", "rest", "work"])
        self.assertEqual(phases[-1]["kind"], "work")

    def test_rejects_zero_rounds(self):
        with self.assertRaises(ValueError):
            cd.build_round_phases(0, 60, 0, "Kor", "Pihi")


class ParseExplicit(unittest.TestCase):
    def test_parses_labels_and_seconds(self):
        phases = cd.parse_explicit_phases("Bemelegites:120,Munka:60,Pihi:30")
        self.assertEqual(len(phases), 3)
        self.assertEqual(phases[0], {"label": "Bemelegites", "seconds": 120, "kind": "custom"})
        self.assertEqual(phases[2]["seconds"], 30)

    def test_blank_label_defaults(self):
        phases = cd.parse_explicit_phases(":45")
        self.assertEqual(phases[0]["label"], "Fazis")

    def test_missing_colon_raises(self):
        with self.assertRaises(ValueError):
            cd.parse_explicit_phases("Munka60")

    def test_empty_raises(self):
        with self.assertRaises(ValueError):
            cd.parse_explicit_phases(" , , ")


class Validate(unittest.TestCase):
    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            cd.validate_phases([])

    def test_rejects_too_many(self):
        too_many = [{"label": "x", "seconds": 1, "kind": "work"}] * (cd.MAX_PHASES + 1)
        with self.assertRaises(ValueError):
            cd.validate_phases(too_many)

    def test_rejects_nonpositive_seconds(self):
        with self.assertRaises(ValueError):
            cd.validate_phases([{"label": "x", "seconds": 0, "kind": "work"}])

    def test_rejects_oversized_seconds(self):
        with self.assertRaises(ValueError):
            cd.validate_phases([{"label": "x", "seconds": cd.MAX_SECONDS_PER_PHASE + 1, "kind": "work"}])


class Messages(unittest.TestCase):
    def test_phase_message_has_label_and_seconds(self):
        msg = cd.phase_message({"label": "Kor 1/4", "seconds": 60, "kind": "work"})
        self.assertIn("Kor 1/4", msg)
        self.assertIn("60 mp", msg)

    def test_final_message_signed_and_counts_work_rounds(self):
        phases = cd.build_round_phases(4, 60, 0, "Kor", "Pihi")
        msg = cd.final_message(phases, SIG)
        self.assertIn("4 kor", msg)
        self.assertTrue(msg.rstrip().endswith(SIG))

    def test_final_message_counts_phases_when_no_work_kind(self):
        phases = cd.parse_explicit_phases("A:10,B:10")
        msg = cd.final_message(phases, SIG)
        self.assertIn("2 fazis", msg)

    def test_opening_message_totals_seconds(self):
        phases = cd.build_round_phases(2, 30, 0, "Kor", "Pihi")
        msg = cd.opening_message("Teszt", phases)
        self.assertIn("60 mp", msg)  # 2 * 30
        self.assertIn("Teszt", msg)


class RunCountdown(unittest.TestCase):
    def _capture(self, phases, **kw):
        sent = []
        slept = []
        summary = cd.run_countdown(
            phases, sender=lambda t: (sent.append(t) or True),
            signature=SIG, title="T",
            sleep_fn=lambda s: slept.append(s), **kw)
        return sent, slept, summary

    def test_sends_opening_each_phase_and_signed_close(self):
        phases = cd.build_round_phases(3, 5, 0, "Kor", "Pihi")
        sent, slept, summary = self._capture(phases)
        # opening + 3 phase messages + final close = 5
        self.assertEqual(len(sent), 5)
        self.assertTrue(sent[0].startswith("⏱️"))
        self.assertTrue(sent[-1].rstrip().endswith(SIG))
        # one real sleep per phase, in order
        self.assertEqual(slept, [5, 5, 5])
        self.assertEqual(summary["sent"], 5)

    def test_no_opening_flag(self):
        phases = cd.build_round_phases(2, 5, 0, "Kor", "Pihi")
        sent, _slept, _summary = self._capture(phases, send_opening=False)
        # 2 phase messages + final = 3, no opening
        self.assertEqual(len(sent), 3)
        self.assertFalse(sent[0].startswith("⏱️"))

    def test_dry_run_sends_nothing_and_sleeps_nothing(self):
        phases = cd.build_round_phases(4, 60, 0, "Kor", "Pihi")
        sent = []
        slept = []
        summary = cd.run_countdown(
            phases, sender=lambda t: (sent.append(t) or True),
            signature=SIG, title="T",
            sleep_fn=lambda s: slept.append(s), dry_run=True)
        self.assertEqual(sent, [])
        self.assertEqual(slept, [])
        self.assertEqual(summary["sent"], 0)
        self.assertEqual(len(summary["messages"]), 6)  # opening + 4 + final

    def test_send_failure_does_not_stop_timer(self):
        phases = cd.build_round_phases(2, 5, 0, "Kor", "Pihi")
        slept = []
        summary = cd.run_countdown(
            phases, sender=lambda t: False,  # every send fails
            signature=SIG, title="T",
            sleep_fn=lambda s: slept.append(s))
        self.assertEqual(summary["sent"], 0)
        self.assertEqual(slept, [5, 5])  # still counted through all phases


if __name__ == "__main__":
    unittest.main()
