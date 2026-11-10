#!/usr/bin/env python3
"""SEC-AC1 range-guard tests for the weight and workout subcommands added
to scripts/hibiki-health-write.py (card f3966f59).

Tests:
  - Valid/invalid weight_kg values via validate_ranges
  - write_weight: accepts valid kg, rejects outliers, rejects bad source
  - Workout duration_min guards
  - _validate_exercises: load_kg, reps, sets per-field bounds
  - write_workout: end-to-end round-trip with valid + invalid inputs
  - hibiki_ranges.py RANGE_CHECKS updated to 20-350 for weight_kg
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_MODULE_PATH = _THIS_DIR / "hibiki-health-write.py"

_spec = importlib.util.spec_from_file_location("hibiki_health_write", _MODULE_PATH)
assert _spec and _spec.loader, f"cannot load module at {_MODULE_PATH}"
hw = importlib.util.module_from_spec(_spec)
sys.modules["hibiki_health_write"] = hw
_spec.loader.exec_module(hw)

PROGRESS_TEMPLATE = {
    "weight_log": [],
    "dexa_results": [],
    "workout_log": [],
    "form_feedback": [],
    "plan_change_log": [],
}


def _make_store(tmp_dir: str) -> str:
    """Write a minimal hibiki-progress.json to tmp_dir and return the dir path."""
    path = os.path.join(tmp_dir, "hibiki-progress.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(PROGRESS_TEMPLATE, f)
    return tmp_dir


class WeightRangeValidationTests(unittest.TestCase):
    """validate_ranges for weight_kg (SEC-AC1)."""

    def test_weight_range_updated_to_20_350(self):
        lo, hi = hw.RANGE_CHECKS["weight_kg"]
        self.assertEqual(lo, 20)
        self.assertEqual(hi, 350)

    def test_valid_weights_pass(self):
        for kg in (20, 50, 82.5, 150, 200, 350):
            errors = hw.validate_ranges({"weight_kg": kg})
            self.assertEqual(errors, [], f"expected {kg} kg to pass, got {errors}")

    def test_low_outliers_rejected(self):
        for kg in (0, 1, 10, 19.9):
            errors = hw.validate_ranges({"weight_kg": kg})
            self.assertTrue(errors, f"expected {kg} kg to be rejected")
            self.assertIn("weight_kg", errors[0])

    def test_high_outliers_rejected(self):
        for kg in (350.1, 500, 1000):
            errors = hw.validate_ranges({"weight_kg": kg})
            self.assertTrue(errors, f"expected {kg} kg to be rejected")
            self.assertIn("weight_kg", errors[0])


class WriteWeightTests(unittest.TestCase):
    """write_weight: file-level integration (SEC-AC1, WRK-AC1)."""

    def test_valid_weight_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_weight(store, "2026-11-10", 82.5, "manual")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(len(data["weight_log"]), 1)
            entry = data["weight_log"][0]
            self.assertEqual(entry["date"], "2026-11-10")
            self.assertEqual(entry["kg"], 82.5)
            self.assertEqual(entry["source"], "manual")

    def test_low_weight_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            with self.assertRaises(SystemExit) as ctx:
                hw.write_weight(store, "2026-11-10", 5.0, "manual")
            self.assertEqual(ctx.exception.code, 1)

    def test_high_weight_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            with self.assertRaises(SystemExit) as ctx:
                hw.write_weight(store, "2026-11-10", 400.0, "manual")
            self.assertEqual(ctx.exception.code, 1)

    def test_invalid_source_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            with self.assertRaises(SystemExit) as ctx:
                hw.write_weight(store, "2026-11-10", 80.0, "unknown-source")
            self.assertEqual(ctx.exception.code, 1)

    def test_upsert_same_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_weight(store, "2026-11-10", 82.0, "manual")
            hw.write_weight(store, "2026-11-10", 82.5, "manual")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(len(data["weight_log"]), 1)
            self.assertEqual(data["weight_log"][0]["kg"], 82.5)

    def test_notes_stored(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_weight(store, "2026-11-10", 82.5, "manual", notes="reggel")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(data["weight_log"][0]["notes"], "reggel")

    def test_vision_confirmed_source_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_weight(store, "2026-11-10", 90.0, "vision-confirmed")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(data["weight_log"][0]["source"], "vision-confirmed")

    def test_boundary_low_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_weight(store, "2026-11-10", 20.0, "manual")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(data["weight_log"][0]["kg"], 20.0)

    def test_boundary_high_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_weight(store, "2026-11-10", 350.0, "manual")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(data["weight_log"][0]["kg"], 350.0)


class WorkoutDurationRangeTests(unittest.TestCase):
    """validate_ranges for duration_min (SEC-AC1)."""

    def test_valid_durations_pass(self):
        for d in (1, 30, 65, 120, 240):
            errors = hw.validate_ranges({"duration_min": d})
            self.assertEqual(errors, [], f"expected {d}min to pass")

    def test_zero_duration_rejected(self):
        errors = hw.validate_ranges({"duration_min": 0})
        self.assertTrue(errors)
        self.assertIn("duration_min", errors[0])

    def test_excessive_duration_rejected(self):
        errors = hw.validate_ranges({"duration_min": 241})
        self.assertTrue(errors)
        self.assertIn("duration_min", errors[0])


class ValidateExercisesTests(unittest.TestCase):
    """_validate_exercises: per-field bounds for sets/reps/load_kg."""

    def _ok(self, exercises):
        errors = hw._validate_exercises(exercises)
        self.assertEqual(errors, [], f"expected no errors, got {errors}")

    def _err(self, exercises, field_hint):
        errors = hw._validate_exercises(exercises)
        self.assertTrue(errors, "expected errors but got none")
        combined = " ".join(errors)
        self.assertIn(field_hint, combined, f"expected '{field_hint}' in errors: {errors}")

    def test_valid_strength_session(self):
        self._ok([
            {"name": "Squat", "sets": [{"reps": 5, "load_kg": 100}]},
            {"name": "Pull-up", "sets": [{"reps": 8}]},
        ])

    def test_bodyweight_zero_load_valid(self):
        self._ok([{"name": "Push-up", "sets": [{"reps": 20, "load_kg": 0}]}])

    def test_load_outlier_rejected(self):
        self._err(
            [{"name": "Squat", "sets": [{"reps": 5, "load_kg": 700}]}],
            "load_kg",
        )

    def test_reps_zero_rejected(self):
        self._err(
            [{"name": "Curl", "sets": [{"reps": 0, "load_kg": 20}]}],
            "reps",
        )

    def test_reps_too_many_rejected(self):
        self._err(
            [{"name": "Curl", "sets": [{"reps": 201, "load_kg": 5}]}],
            "reps",
        )

    def test_too_many_sets_rejected(self):
        # 21 sets exceeds the range (1..20)
        excess_sets = [{"reps": 10, "load_kg": 50}] * 21
        self._err([{"name": "Press", "sets": excess_sets}], "sets")

    def test_non_list_exercises_rejected(self):
        errors = hw._validate_exercises("not a list")
        self.assertTrue(errors)

    def test_load_not_a_number_rejected(self):
        self._err(
            [{"name": "Deadlift", "sets": [{"reps": 3, "load_kg": "heavy"}]}],
            "load_kg",
        )

    def test_fractional_reps_string_valid(self):
        # "12/10/8" ladder notation: first token parsed
        self._ok([{"name": "Curl", "sets": [{"reps": "12/10/8", "load_kg": 15}]}])

    def test_empty_exercises_list_valid(self):
        self._ok([])


class WriteWorkoutTests(unittest.TestCase):
    """write_workout: file-level integration (SEC-AC1, WRK-AC2)."""

    def test_valid_workout_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_workout(store, "2026-11-10", "strength", 65.0, "manual")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(len(data["workout_log"]), 1)
            w = data["workout_log"][0]
            self.assertEqual(w["date"], "2026-11-10")
            self.assertEqual(w["type"], "strength")
            self.assertEqual(w["duration_min"], 65.0)
            self.assertEqual(w["source"], "manual")

    def test_invalid_duration_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            with self.assertRaises(SystemExit) as ctx:
                hw.write_workout(store, "2026-11-10", "cardio", 0.0, "manual")
            self.assertEqual(ctx.exception.code, 1)

    def test_duration_exceeding_max_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            with self.assertRaises(SystemExit) as ctx:
                hw.write_workout(store, "2026-11-10", "cardio", 300.0, "manual")
            self.assertEqual(ctx.exception.code, 1)

    def test_invalid_source_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            with self.assertRaises(SystemExit) as ctx:
                hw.write_workout(store, "2026-11-10", "strength", 60.0, "robot")
            self.assertEqual(ctx.exception.code, 1)

    def test_exercises_with_bad_load_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            bad_ex = [{"name": "Deadlift", "sets": [{"reps": 3, "load_kg": 9999}]}]
            with self.assertRaises(SystemExit) as ctx:
                hw.write_workout(store, "2026-11-10", "strength", 60.0, "manual",
                                 exercises=bad_ex)
            self.assertEqual(ctx.exception.code, 1)

    def test_exercises_stored(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            exs = [{"name": "Squat", "sets": [{"reps": 5, "load_kg": 100}]}]
            hw.write_workout(store, "2026-11-10", "strength", 60.0, "manual",
                             exercises=exs)
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            w = data["workout_log"][0]
            self.assertEqual(w["exercises"], exs)

    def test_upsert_same_date_type(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_workout(store, "2026-11-10", "strength", 60.0, "manual")
            hw.write_workout(store, "2026-11-10", "strength", 75.0, "manual")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(len(data["workout_log"]), 1)
            self.assertEqual(data["workout_log"][0]["duration_min"], 75.0)

    def test_different_types_same_date_both_stored(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_workout(store, "2026-11-10", "strength", 60.0, "manual")
            hw.write_workout(store, "2026-11-10", "cardio", 30.0, "manual")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(len(data["workout_log"]), 2)

    def test_notes_stored(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_workout(store, "2026-11-10", "strength", 60.0, "manual",
                             notes="new PR on squat")
            with open(os.path.join(tmp, "hibiki-progress.json")) as f:
                data = json.load(f)
            self.assertEqual(data["workout_log"][0]["notes"], "new PR on squat")

    def test_file_permissions_0600(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            hw.write_workout(store, "2026-11-10", "hiit", 20.0, "manual")
            path = os.path.join(tmp, "hibiki-progress.json")
            mode = os.stat(path).st_mode & 0o777
            self.assertEqual(mode, 0o600, f"expected 0600, got {oct(mode)}")


if __name__ == "__main__":
    unittest.main()
