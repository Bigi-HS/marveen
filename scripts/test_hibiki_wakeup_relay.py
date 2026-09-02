#!/usr/bin/env python3
"""Tests for hibiki-wakeup-relay.py -- focused on AC-1/AC-4 consumer-gate (WELL-027 40a6f261)."""
import importlib.util
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
spec = importlib.util.spec_from_file_location(
    "wakeup_relay", os.path.join(os.path.dirname(__file__), "hibiki-wakeup-relay.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ComputeCalorieGoalTests(unittest.TestCase):

    def test_upstream_suspect_returns_none_goal(self):
        """AC-1: activeKcalSuspect=True -> goal=None, suspect=True (no Boss-facing number)."""
        zepp = {"activity": {"activeKcal": 350, "activeKcalSuspect": True}}
        goal, floor, suspect = mod.compute_calorie_goal(zepp)
        self.assertIsNone(goal)
        self.assertFalse(floor)
        self.assertTrue(suspect)

    def test_upstream_suspect_true_overrides_high_kcal(self):
        """Upstream suspect beats a plausible activeKcal -- still suppressed."""
        zepp = {"activity": {"activeKcal": 500, "activeKcalSuspect": True}, "steps": 12000}
        goal, floor, suspect = mod.compute_calorie_goal(zepp)
        self.assertIsNone(goal)
        self.assertTrue(suspect)

    def test_no_suspect_normal_kcal(self):
        """Normal case: suspect absent, valid kcal -> formula applied."""
        zepp = {"activity": {"activeKcal": 300, "activeKcalSuspect": False}}
        goal, floor, suspect = mod.compute_calorie_goal(zepp)
        self.assertEqual(goal, mod.CALORIE_BMR + 300 - mod.CALORIE_DEFICIT)
        self.assertFalse(floor)
        self.assertFalse(suspect)

    def test_no_suspect_field_defaults_to_false(self):
        """Missing activeKcalSuspect -> treated as False."""
        zepp = {"activity": {"activeKcal": 200}}
        goal, floor, suspect = mod.compute_calorie_goal(zepp)
        self.assertIsNotNone(goal)
        self.assertFalse(suspect)

    def test_local_sanity_floor_not_suspect(self):
        """Low kcal + high steps -> floor used, but NOT upstream suspect."""
        zepp = {
            "activity": {"activeKcal": 10, "activeKcalSuspect": False},
            "steps": 10000,
        }
        goal, floor, suspect = mod.compute_calorie_goal(zepp)
        self.assertTrue(floor)
        self.assertFalse(suspect)
        self.assertIsNotNone(goal)

    def test_null_kcal_no_steps(self):
        """Null activeKcal, no steps -> goal=BMR - deficit (zero bonus)."""
        zepp = {"activity": {"activeKcal": None, "activeKcalSuspect": False}}
        goal, floor, suspect = mod.compute_calorie_goal(zepp)
        self.assertEqual(goal, mod.CALORIE_BMR - mod.CALORIE_DEFICIT)
        self.assertFalse(suspect)


class FormatReadinessMessageTests(unittest.TestCase):

    def _minimal_readiness(self):
        return {
            "date": "2026-09-02",
            "sleep_min": 420,
            "stress": {"level": "GREEN", "combined": 1, "hrv_today": 45.0, "hrv_delta": 0.5, "rhr_today": 55, "rhr_delta": -1},
            "sleep_quality": {"level": "GREEN", "score": 4, "deep_pct": 20, "rem_pct": 22},
            "load_adjustment_pct": 0,
            "ctl": 30.0,
            "atl": 28.0,
            "tsb": 2.0,
            "recovery": {"next_session_readiness": "GREEN", "estimated_recovery_hours": 16},
        }

    def test_suspect_shows_warning_not_number(self):
        """AC-4: calorie_suspect=True -> warning line, NO kcal number in output."""
        r = self._minimal_readiness()
        msg = mod.format_readiness_message(r, None, "", calorie_goal=None, calorie_suspect=True)
        self.assertIn("gyanús", msg)
        self.assertNotIn("kcal", msg.split("gyanús")[0] + msg.split("gyanús")[-1].split("\n")[0])

    def test_normal_goal_shown_as_number(self):
        """Normal case: calorie_goal present -> kcal number shown."""
        r = self._minimal_readiness()
        msg = mod.format_readiness_message(r, None, "", calorie_goal=2100, calorie_floor_used=False, calorie_suspect=False)
        self.assertIn("2100 kcal", msg)

    def test_floor_goal_shows_floor_tag(self):
        """Floor estimate: shows [floor-becslés] tag."""
        r = self._minimal_readiness()
        msg = mod.format_readiness_message(r, None, "", calorie_goal=2050, calorie_floor_used=True, calorie_suspect=False)
        self.assertIn("floor-becslés", msg)
        self.assertIn("2050 kcal", msg)

    def test_suspect_takes_precedence_over_goal_value(self):
        """If calorie_suspect=True, goal=None -> no kcal number regardless."""
        r = self._minimal_readiness()
        msg = mod.format_readiness_message(r, None, "", calorie_goal=None, calorie_floor_used=False, calorie_suspect=True)
        self.assertNotIn("kcal", msg.replace("gyanús", "").replace("kihagyva", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
