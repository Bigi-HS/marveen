#!/usr/bin/env python3
"""Unit + integration tests for hibiki-daily-push (stdlib unittest only).

Run: python3 scripts/test_hibiki_daily_push.py
"""

import importlib.util
import json
import os
import stat
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

    def test_try_minutes_of_day_returns_none_on_bad_input(self):
        # The defensive wrapper (card 9bf34f76): never raises -- returns None for
        # anything that is not a valid HH:MM, so a single bad/symbolic intake time
        # can be skipped instead of crashing the whole daily push.
        self.assertEqual(push.try_minutes_of_day("06:30"), 390)
        self.assertEqual(push.try_minutes_of_day("00:00"), 0)
        self.assertIsNone(push.try_minutes_of_day("morning"))     # symbolic phase
        self.assertIsNone(push.try_minutes_of_day("pre_workout"))
        self.assertIsNone(push.try_minutes_of_day(""))
        self.assertIsNone(push.try_minutes_of_day("25:00"))        # out of range
        self.assertIsNone(push.try_minutes_of_day("8"))            # no colon
        self.assertIsNone(push.try_minutes_of_day(None))           # type: ignore[arg-type]

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
        msg = push.build_reminder_message(["Kreatin"], SIG)
        self.assertIn("Kreatin", msg)
        # no digits -> no dosage leaked
        self.assertFalse(any(ch.isdigit() for ch in msg.replace(SIG, "")))
        self.assertTrue(msg.rstrip().endswith(SIG))

    def test_reminder_message_lists_multiple_names(self):
        # Collision bucketing (card 4db2faed): supplements resolving to the same time
        # are listed together in one reminder; the caller passes a sorted list.
        msg = push.build_reminder_message(["Asztaxantin", "Kreatin"], SIG)
        self.assertIn("Asztaxantin", msg)
        self.assertIn("Kreatin", msg)
        self.assertLess(msg.index("Asztaxantin"), msg.index("Kreatin"))

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
        # Reminders bucket by RESOLVED time now -> key is "supp:HH:MM" (name-free).
        plan = _plan([_strength_session("monday")])
        now = datetime(2026, 6, 8, 8, 3)  # within 5 min of 08:00
        acts = push.due_actions(now, plan, self.supps, self.config, {"session"})
        self.assertIn("supp:08:00", {a["key"] for a in acts})
        self.assertNotIn("supp:22:00", {a["key"] for a in acts})
        # outside tolerance
        now2 = datetime(2026, 6, 8, 8, 20)
        acts2 = push.due_actions(now2, plan, self.supps, self.config, {"session"})
        self.assertNotIn("supp:08:00", {a["key"] for a in acts2})

    def test_missing_plan_yields_error_action(self):
        now = datetime(2026, 6, 8, 6, 35)
        acts = push.due_actions(now, None, self.supps, self.config, set())
        # kind distinguishes the alert; key is "session" so it dedupes once/day.
        err = next(a for a in acts if a["kind"] == "plan-error")
        self.assertEqual(err["key"], "session")
        # and once the daily delivery is marked sent, it does not re-queue.
        acts2 = push.due_actions(now, None, self.supps, self.config, {"session"})
        self.assertFalse(any(a["kind"] == "plan-error" for a in acts2))

    def test_rest_day_when_no_session_for_today(self):
        plan = _plan([_strength_session("monday")])
        now = datetime(2026, 6, 9, 6, 35)  # tuesday -> no session -> rest
        acts = push.due_actions(now, plan, self.supps, self.config, set())
        session_act = next(a for a in acts if a["key"] == "session")
        self.assertEqual(session_act["kind"], "rest")

    def test_supplement_push_disabled_suppresses_agenda_and_reminders(self):
        # Boss-requested toggle (TG1231): supplement_push_enabled=false must drop BOTH
        # supplement surfaces -- the session/rest intake agenda AND the timed intake
        # reminders -- while leaving the session/rest push itself untouched.
        config = {**self.config, "supplement_push_enabled": False}
        plan = _plan([_strength_session("monday")])
        # (a) the session still fires, but its message carries no intake agenda.
        now = datetime(2026, 6, 8, 6, 35)  # monday, after push time
        acts = push.due_actions(now, plan, self.supps, config, set())
        session_act = next(a for a in acts if a["key"] == "session")
        self.assertEqual(session_act["kind"], "session")
        self.assertNotIn("Mai bevitel-terv:", session_act["build"](SIG))
        # (b) no timed intake reminder is queued even at a resolved intake time.
        now2 = datetime(2026, 6, 8, 8, 3)  # within tolerance of the 08:00 intake
        acts2 = push.due_actions(now2, plan, self.supps, config, {"session"})
        self.assertFalse([a for a in acts2 if a["key"].startswith("supp:")])

    def test_supplement_push_defaults_enabled_when_key_absent(self):
        # Regression guard: with the flag absent the pre-toggle behavior stands --
        # the agenda is present and the timed reminder fires (default True both reads).
        self.assertNotIn("supplement_push_enabled", self.config)
        plan = _plan([_strength_session("monday")])
        now = datetime(2026, 6, 8, 6, 35)
        acts = push.due_actions(now, plan, self.supps, self.config, set())
        session_act = next(a for a in acts if a["key"] == "session")
        self.assertIn("Mai bevitel-terv:", session_act["build"](SIG))
        now2 = datetime(2026, 6, 8, 8, 3)
        acts2 = push.due_actions(now2, plan, self.supps, self.config, {"session"})
        self.assertIn("supp:08:00", {a["key"] for a in acts2})


class UnparseableTimeGuardTests(unittest.TestCase):
    """Card 9bf34f76: real hibiki-supplements.json uses SYMBOLIC intake phases
    (morning / pre_workout / post_workout / evening ...), not 'HH:MM'. A single
    unparseable time used to crash today_supplement_overview -> due_actions -> the
    entire push, every tick (1468 failures). The guard must SKIP unparseable times,
    never raise, so the session/nutrition push still goes out and the valid timed
    reminders still fire.
    """

    # Known phases now RESOLVE (see ResolverTests); the guard still protects against a
    # genuinely UNKNOWN phase value (a typo / future vocab the resolver does not know).

    def test_overview_skips_unknown_phase_without_crashing(self):
        supps = [
            {"name": "A", "intake_schedule": [{"time": "banana", "days": "daily"}]},
            {"name": "B", "intake_schedule": [{"time": "whenever", "days": "daily"}]},
        ]
        # Unknown phases -> empty overview, NO exception.
        self.assertEqual(push.today_supplement_overview(supps, date(2026, 6, 8)), [])

    def test_overview_keeps_valid_drops_unknown_sorted(self):
        supps = [
            {"name": "Late", "intake_schedule": [{"time": "22:00", "days": "daily"}]},
            {"name": "Bad", "intake_schedule": [{"time": "banana", "days": "daily"}]},
            {"name": "Early", "intake_schedule": [{"time": "08:00", "days": "daily"}]},
        ]
        out = push.today_supplement_overview(supps, date(2026, 6, 8))
        # only the two HH:MM entries survive, sorted by time; the unknown one dropped.
        self.assertEqual(out, [("Early", "08:00"), ("Late", "22:00")])

    def test_due_actions_survives_unknown_phase_session_still_fires(self):
        config = {"session_push_time": "06:30", "reminder_tolerance_min": 5}
        supps = [{"name": "Junk", "intake_schedule": [{"time": "banana", "days": "daily"}]}]
        plan = _plan([_strength_session("monday")])
        now = datetime(2026, 6, 8, 6, 35)
        acts = push.due_actions(now, plan, supps, config, set())   # must not raise
        self.assertIn("session", {a["key"] for a in acts})

    def test_unknown_phase_skip_is_logged_not_silent(self):
        # DA-HIGH: a slot that IS due today but cannot be placed on the clock must be
        # logged (reason-tagged, count only), never a silent nothing.
        supps = [{"name": "Junk", "intake_schedule": [{"time": "banana", "days": "daily"}]}]
        with self.assertLogs("hibiki-push", level="WARNING") as cm:
            push.resolved_supplement_intakes(supps, date(2026, 6, 8), None)
        blob = "\n".join(cm.output)
        self.assertIn("unknown_phase", blob)
        self.assertNotIn("Junk", blob)  # privacy: no name in the log


class ResolverTests(unittest.TestCase):
    """Card 4db2faed: symbolic intake phase -> concrete Europe/Budapest wall-clock time(s)."""

    def test_passthrough_explicit_hhmm(self):
        self.assertEqual(push.resolve_intake_times("08:00", None, None), ["08:00"])

    def test_morning_default_and_timing_overrides(self):
        self.assertEqual(push.resolve_intake_times("morning", "before_first_meal", None), ["07:30"])
        self.assertEqual(push.resolve_intake_times("morning", None, None), ["07:30"])
        self.assertEqual(push.resolve_intake_times("morning", "15-30min_before_meal", None), ["07:30"])
        self.assertEqual(push.resolve_intake_times("morning", "with_meal", None), ["08:00"])
        self.assertEqual(push.resolve_intake_times("morning", "max_13:00", None), ["08:00"])

    def test_evening_fixed(self):
        self.assertEqual(push.resolve_intake_times("evening", "45-60min_before_sleep", None), ["21:30"])

    def test_pre_meal_expands_to_three(self):
        self.assertEqual(push.resolve_intake_times("pre_meal", "30min_before_each_main_meal", None),
                         ["07:30", "12:30", "18:30"])

    def test_workout_phases_anchor_to_session_time(self):
        session = {"session_type": "strength", "scheduled_time": "18:00", "duration_min": 75}
        self.assertEqual(push.resolve_intake_times("pre_workout", None, session), ["17:30"])
        self.assertEqual(push.resolve_intake_times("intra_workout", None, session), ["18:00"])
        self.assertEqual(push.resolve_intake_times("post_workout", None, session), ["19:15"])

    def test_workout_phase_skips_without_session(self):  # DA #2
        for phase in ("pre_workout", "intra_workout", "post_workout"):
            self.assertEqual(push.resolve_intake_times(phase, None, None), [])

    def test_workout_phase_skips_on_null_scheduled_time(self):  # DA #1/#2: null_time -> clean skip
        session = {"session_type": "strength", "scheduled_time": None, "duration_min": 60}
        for phase in ("pre_workout", "intra_workout", "post_workout"):
            self.assertEqual(push.resolve_intake_times(phase, None, session), [])

    def test_post_workout_needs_duration(self):
        session = {"session_type": "strength", "scheduled_time": "18:00"}  # no duration_min
        self.assertEqual(push.resolve_intake_times("post_workout", None, session), [])

    def test_unknown_phase_returns_empty(self):
        self.assertEqual(push.resolve_intake_times("banana", None, None), [])
        self.assertEqual(push.resolve_intake_times(None, None, None), [])

    def test_with_meal_is_fixed_never_anchor_crash(self):  # DA #3
        # with_meal maps to a FIXED 08:00 -> never depends on a meal anchor, never NaN.
        self.assertEqual(push.resolve_intake_times("morning", "with_meal", None), ["08:00"])
        self.assertEqual(
            push.resolve_intake_times("morning", "with_meal", {"session_type": "rest", "scheduled_time": None}),
            ["08:00"])

    def test_is_training_day(self):
        self.assertTrue(push.is_training_day({"session_type": "strength"}))
        self.assertFalse(push.is_training_day({"session_type": "rest"}))
        self.assertFalse(push.is_training_day(None))

    def test_slot_due_today_day_gate(self):
        d = date(2026, 6, 8)  # monday
        training = {"session_type": "strength", "scheduled_time": "18:00"}
        self.assertTrue(push.slot_due_today({"days": "daily"}, d, None))
        self.assertTrue(push.slot_due_today({"days": "training_days_only"}, d, training))
        self.assertFalse(push.slot_due_today({"days": "training_days_only"}, d, {"session_type": "rest"}))
        self.assertFalse(push.slot_due_today({"days": "training_days_only"}, d, None))
        self.assertTrue(push.slot_due_today({"days": ["mon", "wed"]}, d, None))
        self.assertFalse(push.slot_due_today({"days": ["tue"]}, d, None))

    def test_resolved_intakes_training_gate_and_bucket(self):
        supps = [
            {"name": "C", "intake_schedule": [{"time": "morning", "timing": "before_first_meal", "days": "daily"}]},
            {"name": "D", "intake_schedule": [{"time": "morning", "timing": "before_first_meal", "days": "daily"}]},
            {"name": "Carn", "intake_schedule": [{"time": "morning", "timing": "max_13:00", "days": "training_days_only"}]},
        ]
        d = date(2026, 6, 8)
        rest = push.resolved_supplement_intakes(supps, d, {"session_type": "rest"})
        self.assertEqual(sorted(rest), [("C", "07:30"), ("D", "07:30")])      # Carn skipped on rest
        train = push.resolved_supplement_intakes(supps, d, {"session_type": "strength", "scheduled_time": "18:00"})
        self.assertIn(("Carn", "08:00"), train)                               # fires on training day

    def test_due_actions_collision_one_bucket_sorted(self):  # DA #4 determinism
        config = {"session_push_time": "06:30", "reminder_tolerance_min": 5}
        supps = [
            {"name": "Zeta", "intake_schedule": [{"time": "morning", "timing": "before_first_meal", "days": "daily"}]},
            {"name": "Alpha", "intake_schedule": [{"time": "morning", "timing": "before_first_meal", "days": "daily"}]},
        ]
        plan = _plan([_strength_session("monday")])
        now = datetime(2026, 6, 8, 7, 31)  # within tol of 07:30
        rem = [a for a in push.due_actions(now, plan, supps, config, {"session"}) if a["kind"] == "reminder"]
        self.assertEqual(len(rem), 1)                      # one bucket for 07:30
        self.assertEqual(rem[0]["key"], "supp:07:30")
        msg = rem[0]["build"]("SIG")
        self.assertLess(msg.index("Alpha"), msg.index("Zeta"))   # deterministic sorted order

    def test_dst_boundary_fires_at_local_wallclock(self):  # DA #1 DST (STANDING Boss directive)
        # Hungary spring-forward 2026-03-29 + fall-back 2026-10-25: a 07:30 reminder must
        # fire at LOCAL 07:30 on both, proving wall-clock minute math (no UTC-offset drift).
        config = {"session_push_time": "06:30", "reminder_tolerance_min": 5}
        supps = [{"name": "C", "intake_schedule": [{"time": "morning", "timing": "before_first_meal", "days": "daily"}]}]
        for d in (date(2026, 3, 29), date(2026, 10, 25)):
            plan = _plan([_strength_session(push.weekday_name(d))])
            now = datetime(d.year, d.month, d.day, 7, 31)  # local wall-clock
            keys = {a["key"] for a in push.due_actions(now, plan, supps, config, {"session"})}
            self.assertIn("supp:07:30", keys, f"07:30 must fire at local 07:30 on {d}")


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

    def test_corrupt_plan_alert_fires_once_not_every_tick(self):
        # Regression (Thor BLOCK): the missing/corrupt-plan alert must dedupe like
        # the session push -- a second tick the same day must send nothing, else
        # the alert re-fires every 5 minutes and spams Telegram.
        self._write(os.path.join("plans", "hibiki-plan-2026-W24.json"), "{ not json")
        sent, sender = self._collect_sender()
        s1 = push.run(datetime(2026, 6, 8, 6, 35), self.tmp, sender)
        s2 = push.run(datetime(2026, 6, 8, 6, 40), self.tmp, sender)
        self.assertEqual(s1["sent"], 1)
        self.assertEqual(s2["sent"], 0)
        self.assertEqual(len(sent), 1)

    def test_run_survives_all_symbolic_supplement_times(self):
        # Regression for card 9bf34f76 (no crash) + 4db2faed (symbolic phases now
        # resolve). The whole push used to crash every tick; now the session push goes
        # out and run() must not raise on an all-symbolic inventory.
        self._write("hibiki-supplements.json", json.dumps([
            {"name": "A", "intake_schedule": [{"time": "morning", "timing": "before_first_meal", "days": "daily"}]},
            {"name": "C", "intake_schedule": [{"time": "evening", "timing": "45-60min_before_sleep", "days": "daily"}]},
        ]))
        sent, sender = self._collect_sender()
        summary = push.run(datetime(2026, 6, 8, 6, 35), self.tmp, sender)
        self.assertGreaterEqual(summary["sent"], 1)
        self.assertIn("session", summary["kinds"])

    def test_run_resolves_symbolic_reminder_end_to_end(self):
        # 4db2faed: a 'morning' supplement must produce a 07:30 reminder via the resolver.
        self._write("hibiki-supplements.json", json.dumps([
            {"name": "C vitamin", "intake_schedule": [{"time": "morning", "timing": "before_first_meal", "days": "daily"}]},
        ]))
        sent, sender = self._collect_sender()
        push.run(datetime(2026, 6, 8, 6, 35), self.tmp, sender)   # session push first
        push.run(datetime(2026, 6, 8, 7, 31), self.tmp, sender)   # 07:30 resolved reminder
        self.assertTrue(any("C vitamin" in t for t in sent))

    def test_state_file_is_owner_only(self):
        sent, sender = self._collect_sender()
        now = datetime(2026, 6, 8, 6, 35)
        push.run(now, self.tmp, sender)
        state = push.state_path(self.tmp, now.date())
        self.assertTrue(os.path.exists(state))
        mode = stat.S_IMODE(os.stat(state).st_mode)
        self.assertEqual(mode, 0o600)

    def test_summary_carries_no_supplement_names(self):
        sent, sender = self._collect_sender()
        summary = push.run(datetime(2026, 6, 8, 8, 1), self.tmp, sender)
        # the loggable summary must not leak health data
        blob = json.dumps(summary)
        self.assertNotIn("Kreatin", blob)


if __name__ == "__main__":
    unittest.main(verbosity=2)
