#!/usr/bin/env python3
"""Tests for the Hibiki<->Claudia scheduling protocol (stdlib unittest only).

Run: python3 scripts/test_hibiki_claudia_protocol.py
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "hibiki_claudia_protocol", os.path.join(_HERE, "hibiki-claudia-protocol.py")
)
proto = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(proto)


def _request(**over):
    msg = {
        "type": "schedule_request",
        "from": "hibiki",
        "week": "2026-W24",
        "sessions": [
            {"day": "monday", "preferred_time": "07:00", "duration_min": 60,
             "session_type": "strength", "flexibility_window": "06:00-09:00"},
        ],
    }
    msg.update(over)
    return msg


def _confirmation(**over):
    msg = {
        "type": "schedule_confirmation",
        "from": "claudia",
        "sessions": [{"day": "monday", "confirmed_time": "07:30", "calendar_event_id": "evt1"}],
        "rejected": [],
    }
    msg.update(over)
    return msg


def _plan():
    return {
        "plan_id": "2026-W24",
        "weekly_sessions": [
            # scheduled_time is null until Claudia confirms (spec data model);
            # preferred_time carries Hibiki's wish into the proposal.
            {"day": "monday", "session_type": "strength", "preferred_time": "07:00",
             "scheduled_time": None, "duration_min": 60, "flexibility_window": "06:00-09:00"},
            {"day": "wednesday", "session_type": "cardio", "preferred_time": "18:00",
             "scheduled_time": None, "duration_min": 45, "flexibility_window": "17:00-21:00"},
            {"day": "sunday", "session_type": "rest", "duration_min": 0},
        ],
    }


class TimeHelperTests(unittest.TestCase):
    def test_minutes_of_day(self):
        self.assertEqual(proto.minutes_of_day("06:30"), 390)
        with self.assertRaises(ValueError):
            proto.minutes_of_day("24:01")

    def test_parse_window(self):
        self.assertEqual(proto.parse_window("06:00-09:00"), (360, 540))
        self.assertIsNone(proto.parse_window("09:00-06:00"))  # inverted
        self.assertIsNone(proto.parse_window("bogus"))


class HealthScanTests(unittest.TestCase):
    def test_clean_request_has_no_hits(self):
        self.assertEqual(proto.scan_for_health_data(_request()), [])

    def test_detects_nested_health_keys(self):
        bad = _request()
        bad["sessions"][0]["protein_g"] = 170
        hits = proto.scan_for_health_data(bad)
        self.assertTrue(any("protein_g" in h for h in hits))

    def test_detects_supplement_and_dexa(self):
        bad = {"supplements": ["x"], "nested": {"dexa_body_fat": 18}}
        hits = proto.scan_for_health_data(bad)
        self.assertTrue(any("supplements" in h for h in hits))
        self.assertTrue(any("dexa_body_fat" in h for h in hits))


class RequestValidationTests(unittest.TestCase):
    def test_valid_request(self):
        self.assertEqual(proto.validate_schedule_request(_request()), [])

    def test_wrong_type_and_sender(self):
        errs = proto.validate_schedule_request(_request(type="x", **{"from": "claudia"}))
        self.assertTrue(any("type" in e for e in errs))
        self.assertTrue(any("from" in e for e in errs))

    def test_missing_required_slot_field(self):
        msg = _request()
        del msg["sessions"][0]["duration_min"]
        errs = proto.validate_schedule_request(msg)
        self.assertTrue(any("duration_min" in e for e in errs))

    def test_rest_session_type_rejected(self):
        msg = _request()
        msg["sessions"][0]["session_type"] = "rest"
        errs = proto.validate_schedule_request(msg)
        self.assertTrue(any("schedulable" in e for e in errs))

    def test_bad_time_and_window_and_duration(self):
        msg = _request()
        msg["sessions"][0]["preferred_time"] = "99:99"
        msg["sessions"][0]["flexibility_window"] = "06:00"
        msg["sessions"][0]["duration_min"] = -5
        errs = proto.validate_schedule_request(msg)
        self.assertTrue(any("preferred_time" in e for e in errs))
        self.assertTrue(any("flexibility_window" in e for e in errs))
        self.assertTrue(any("duration_min" in e for e in errs))

    def test_empty_sessions_is_error(self):
        errs = proto.validate_schedule_request(_request(sessions=[]))
        self.assertTrue(any("non-empty" in e for e in errs))

    def test_health_data_in_request_is_error(self):
        msg = _request()
        msg["sessions"][0]["supplement_note"] = "creatine 5g"
        errs = proto.validate_schedule_request(msg)
        self.assertTrue(any("health data not allowed" in e for e in errs))


class ConfirmationValidationTests(unittest.TestCase):
    def test_valid_confirmation(self):
        self.assertEqual(proto.validate_schedule_confirmation(_confirmation()), [])

    def test_valid_with_only_rejections(self):
        msg = _confirmation(sessions=[], rejected=[{"day": "wednesday", "reason": "conflict"}])
        self.assertEqual(proto.validate_schedule_confirmation(msg), [])

    def test_empty_confirmation_is_error(self):
        errs = proto.validate_schedule_confirmation(_confirmation(sessions=[], rejected=[]))
        self.assertTrue(any("at least one" in e for e in errs))

    def test_rejected_missing_reason(self):
        msg = _confirmation(sessions=[], rejected=[{"day": "wednesday"}])
        errs = proto.validate_schedule_confirmation(msg)
        self.assertTrue(any("reason" in e for e in errs))

    def test_bad_confirmed_time(self):
        msg = _confirmation()
        msg["sessions"][0]["confirmed_time"] = "7am"
        errs = proto.validate_schedule_confirmation(msg)
        self.assertTrue(any("confirmed_time" in e for e in errs))


class BuildRequestTests(unittest.TestCase):
    def test_build_skips_rest_and_copies_only_scheduling_fields(self):
        req = proto.build_schedule_request(_plan(), "2026-W24")
        self.assertEqual(proto.validate_schedule_request(req), [])
        days = {s["day"] for s in req["sessions"]}
        self.assertEqual(days, {"monday", "wednesday"})  # sunday rest dropped
        # no health/exercise fields leaked
        self.assertEqual(proto.scan_for_health_data(req), [])


class ApplyConfirmationTests(unittest.TestCase):
    def test_confirmed_time_written_and_not_finalized_until_all(self):
        res = proto.apply_confirmation(_plan(), _confirmation())  # only monday confirmed
        mon = next(s for s in res["plan"]["weekly_sessions"] if s["day"] == "monday")
        self.assertEqual(mon["scheduled_time"], "07:30")
        self.assertEqual(mon["calendar_event_id"], "evt1")
        self.assertFalse(res["finalized"])  # wednesday still unconfirmed
        self.assertEqual(res["confirmed_days"], ["monday"])

    def test_finalized_when_all_schedulable_confirmed(self):
        conf = _confirmation(sessions=[
            {"day": "monday", "confirmed_time": "07:30"},
            {"day": "wednesday", "confirmed_time": "18:30"},
        ])
        res = proto.apply_confirmation(_plan(), conf)
        self.assertTrue(res["finalized"])

    def test_input_plan_not_mutated(self):
        plan = _plan()
        proto.apply_confirmation(plan, _confirmation())
        mon = next(s for s in plan["weekly_sessions"] if s["day"] == "monday")
        self.assertIsNone(mon["scheduled_time"])  # original (null) untouched

    def test_rejected_passed_through(self):
        conf = _confirmation(rejected=[{"day": "wednesday", "reason": "conflict 18:00"}])
        res = proto.apply_confirmation(_plan(), conf)
        self.assertEqual(res["rejected"][0]["day"], "wednesday")


class ReconcileTests(unittest.TestCase):
    def test_alternative_found_avoids_busy_window(self):
        # wednesday cardio, window 17:00-21:00, 45 min; busy 17:00-18:00 -> 18:00 free
        plan = _plan()
        res = proto.reconcile_rejections(
            plan, [{"day": "wednesday", "reason": "conflict"}],
            {"wednesday": ["17:00-18:00"]})
        self.assertIsNotNone(res["reproposal"])
        slot = res["reproposal"]["sessions"][0]
        self.assertEqual(slot["preferred_time"], "18:00")
        self.assertEqual(res["no_slot"], [])
        # the re-proposal is itself a valid schedule_request
        self.assertEqual(proto.validate_schedule_request(res["reproposal"]), [])

    def test_no_slot_when_day_full(self):
        plan = _plan()
        res = proto.reconcile_rejections(
            plan, [{"day": "wednesday", "reason": "conflict"}],
            {"wednesday": ["17:00-21:00"]})  # whole window busy
        self.assertIsNone(res["reproposal"])
        self.assertEqual(res["no_slot"][0]["day"], "wednesday")

    def test_propose_alternative_jumps_past_conflict(self):
        session = {"day": "monday", "duration_min": 60,
                   "session_type": "strength", "flexibility_window": "06:00-09:00"}
        alt = proto.propose_alternative(session, ["06:00-07:30"])
        self.assertEqual(alt["preferred_time"], "07:30")  # first 60-min gap after 07:30


if __name__ == "__main__":
    unittest.main(verbosity=2)
