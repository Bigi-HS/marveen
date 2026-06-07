#!/usr/bin/env python3
"""Unit + integration tests for hibiki-daily-push (stdlib unittest only).

Run: python3 scripts/test_hibiki_daily_push.py
"""

import importlib.util
import json
import os
import tempfile
import unittest
from datetime import date, datetime

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "hibiki_daily_push", os.path.join(_HERE, "hibiki-daily-push.py")
)
push = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(push)


SIG = "TESZT-SZIGNATURA"


def _strength_session(day="monday"):
    return {
        "day": day,
        "session_type": "strength",
        "scheduled_time": "07:00",
        "duration_min": 60,
        "deload": False,
        "exercises": [
            {"name": "Guggolas", "sets": 4, "reps_or_duration": 6, "load_scheme": "RPE 8", "notes": "terd kifele"},
            {"name": "Fekvenyomas", "sets": 3, "reps_or_duration": 8, "load_scheme": "RIR 2"},
        ],
        "form_cues": ["guggolas: mellkas fel"],
    }


def _plan(sessions, nutrition=None):
    return {
        "plan_id": "2026-W24",
        "generated_at": "2026-06-08T00:00:00",
        "goals": {"primary": "fat loss", "secondary": "muscle retention", "tertiary": "flexibility"},
        "weekly_sessions": sessions,
        "nutrition_targets": nutrition or {"calories": 2300, "protein_g": 170, "updated_at": "2026-06-08"},
        "week_notes": "accumulation",
    }


class PureLogicTests(unittest.TestCase):
    def test_iso_week_key(self):
        self.assertEqual(push.iso_week_key(date(2026, 6, 8)), "2026-W24")
        self.assertEqual(push.iso_week_key(date(2026, 1, 1)), "2026-W01")

    def test_weekday_name(self):
        self.assertEqual(push.weekday_name(date(2026, 6, 8)), "monday")  # Monday
        self.assertEqual(push.weekday_name(date(2026, 6, 14)), "sunday")

    def test_minutes_of_day(self):
        self.assertEqual(push.minutes_of_day("06:30"), 390)
        self.assertEqual(push.minutes_of_day("00:00"), 0)
        with self.assertRaises(ValueError):
            push.minutes_of_day("25:00")

    def test_find_today_session(self):
        plan = _plan([_strength_session("monday"), _strength_session("wednesday")])
        self.assertIsNotNone(push.find_today_session(plan, date(2026, 6, 8)))   # mon
        self.assertIsNone(push.find_today_session(plan, date(2026, 6, 9)))      # tue

    def test_supplement_due_today_daily_and_listed(self):
        daily = {"name": "Kreatin", "intake_schedule": [{"time": "08:00", "days": "daily"}]}
        listed = {"name": "Magnezium", "intake_schedule": [{"time": "22:00", "days": ["mon", "wed"]}]}
        self.assertEqual(push.supplement_due_today(daily, date(2026, 6, 8)), ["08:00"])
        self.assertEqual(push.supplement_due_today(listed, date(2026, 6, 8)), ["22:00"])  # monday
        self.assertEqual(push.supplement_due_today(listed, date(2026, 6, 9)), [])         # tuesday

    def test_session_message_has_no_dosage_and_signature(self):
        msg = push.build_session_message(_strength_session(), {"calories": 2300, "protein_g": 170}, [("Kreatin", "08:00")], SIG)
        self.assertIn("Guggolas", msg)
        self.assertIn("4x6", msg)
        self.assertIn("2300 kcal", msg)
        self.assertIn("Kreatin (08:00)", msg)
        self.assertTrue(msg.rstrip().endswith(SIG))

    def test_rest_message_has_no_exercise_list(self):
        msg = push.build_rest_message({"day": "sunday"}, [], SIG)
        self.assertRegex(msg.lower(), r"pihen|regener")
        self.assertNotIn("Guggolas", msg)
        self.assertTrue(msg.rstrip().endswith(SIG))

    def test_reminder_message_name_only_no_dosage(self):
        msg = push.build_reminder_message("Kreatin", SIG)
        self.assertIn("Kreatin", msg)
        # no digits -> no dosage leaked
        self.assertFalse(any(ch.isdigit() for ch in msg.replace(SIG, "")))
        self.assertTrue(msg.rstrip().endswith(SIG))

    def test_signature_placeholder_detection(self):
        self.assertTrue(push.signature_is_placeholder(""))
        self.assertTrue(push.signature_is_placeholder("[PLACEHOLDER -- confirm]"))
        self.assertFalse(push.signature_is_placeholder("Edzes nem alku targya."))


class DueActionsTests(unittest.TestCase):
    def setUp(self):
        self.config = {"session_push_time": "06:30", "reminder_tolerance_min": 5}
        self.supps = [
            {"name": "Kreatin", "intake_schedule": [{"time": "08:00", "days": "daily"}]},
            {"name": "Magnezium", "intake_schedule": [{"time": "22:00", "days": "daily"}]},
        ]

    def test_session_fires_after_push_time_once(self):
        plan = _plan([_strength_session("monday")])
        now = datetime(2026, 6, 8, 6, 35)  # monday, after 06:30
        acts = push.due_actions(now, plan, self.supps, self.config, set())
        keys = {a["key"] for a in acts}
        self.assertIn("session", keys)
        # already-sent session is not re-queued
        acts2 = push.due_actions(now, plan, self.supps, self.config, {"session"})
        self.assertNotIn("session", {a["key"] for a in acts2})

    def test_session_not_before_push_time(self):
        plan = _plan([_strength_session("monday")])
        now = datetime(2026, 6, 8, 6, 0)  # before 06:30
        acts = push.due_actions(now, plan, self.supps, self.config, set())
        self.assertNotIn("session", {a["key"] for a in acts})

    def test_reminder_within_tolerance_only(self):
        plan = _plan([_strength_session("monday")])
        now = datetime(2026, 6, 8, 8, 3)  # within 5 min of 08:00
        acts = push.due_actions(now, plan, self.supps, self.config, {"session"})
        self.assertIn("supp:Kreatin:08:00", {a["key"] for a in acts})
        self.assertNotIn("supp:Magnezium:22:00", {a["key"] for a in acts})
        # outside tolerance
        now2 = datetime(2026, 6, 8, 8, 20)
        acts2 = push.due_actions(now2, plan, self.supps, self.config, {"session"})
        self.assertNotIn("supp:Kreatin:08:00", {a["key"] for a in acts2})

    def test_missing_plan_yields_error_action(self):
        now = datetime(2026, 6, 8, 6, 35)
        acts = push.due_actions(now, None, self.supps, self.config, set())
        self.assertIn("plan-error", {a["key"] for a in acts})

    def test_rest_day_when_no_session_for_today(self):
        plan = _plan([_strength_session("monday")])
        now = datetime(2026, 6, 9, 6, 35)  # tuesday -> no session -> rest
        acts = push.due_actions(now, plan, self.supps, self.config, set())
        session_act = next(a for a in acts if a["key"] == "session")
        self.assertEqual(session_act["kind"], "rest")


class RunIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hibiki-store-")
        os.makedirs(os.path.join(self.tmp, "plans"), exist_ok=True)
        self._write("signature.txt", SIG)
        self._write("push-config.json", json.dumps({"session_push_time": "06:30", "reminder_tolerance_min": 5, "chat_id": 123}))
        self._write("hibiki-supplements.json", json.dumps([
            {"name": "Kreatin", "source_vendor": "x", "procurement_date": "2026-06-01",
             "intake_schedule": [{"time": "08:00", "days": "daily", "notes": ""}]},
        ]))
        self._write(os.path.join("plans", "hibiki-plan-2026-W24.json"),
                    json.dumps(_plan([_strength_session("monday")])))

    def _write(self, rel, content):
        with open(os.path.join(self.tmp, rel), "w", encoding="utf-8") as fh:
            fh.write(content)

    def _collect_sender(self):
        sent = []
        def _s(text):
            sent.append(text)
            return True
        return sent, _s

    def test_session_push_sends_and_dedupes_across_ticks(self):
        sent, sender = self._collect_sender()
        now = datetime(2026, 6, 8, 6, 35)
        s1 = push.run(now, self.tmp, sender)
        self.assertEqual(s1["sent"], 1)
        self.assertIn("session", s1["kinds"])
        # second tick a minute later: state file dedupes, nothing re-sent
        s2 = push.run(datetime(2026, 6, 8, 6, 36), self.tmp, sender)
        self.assertEqual(s2["sent"], 0)
        self.assertEqual(len(sent), 1)

    def test_reminder_fires_at_time(self):
        sent, sender = self._collect_sender()
        push.run(datetime(2026, 6, 8, 6, 35), self.tmp, sender)   # session
        push.run(datetime(2026, 6, 8, 8, 1), self.tmp, sender)    # reminder
        self.assertTrue(any("Kreatin" in t for t in sent))

    def test_placeholder_signature_suppresses_live_push(self):
        self._write("signature.txt", "[PLACEHOLDER -- Genesis to confirm]")
        sent, sender = self._collect_sender()
        summary = push.run(datetime(2026, 6, 8, 6, 35), self.tmp, sender, dry_run=False)
        self.assertEqual(summary.get("suppressed"), "signature-placeholder")
        self.assertEqual(len(sent), 0)

    def test_dry_run_bypasses_placeholder_and_does_not_send(self):
        self._write("signature.txt", "[PLACEHOLDER]")
        sent, sender = self._collect_sender()
        summary = push.run(datetime(2026, 6, 8, 6, 35), self.tmp, sender, dry_run=True)
        self.assertNotIn("suppressed", summary)
        self.assertEqual(len(sent), 0)  # dry-run never calls the sender

    def test_corrupt_plan_sends_error_alert(self):
        self._write(os.path.join("plans", "hibiki-plan-2026-W24.json"), "{ not json")
        sent, sender = self._collect_sender()
        summary = push.run(datetime(2026, 6, 8, 6, 35), self.tmp, sender)
        self.assertEqual(summary["sent"], 1)
        self.assertIn("plan-error", summary["kinds"])
        self.assertTrue(any("nem elerheto" in t for t in sent))

    def test_summary_carries_no_supplement_names(self):
        sent, sender = self._collect_sender()
        summary = push.run(datetime(2026, 6, 8, 8, 1), self.tmp, sender)
        # the loggable summary must not leak health data
        blob = json.dumps(summary)
        self.assertNotIn("Kreatin", blob)


if __name__ == "__main__":
    unittest.main(verbosity=2)
