#!/usr/bin/env python3
"""Unit tests for scripts/hibiki-dexa.py (stdlib unittest).

Covers the E-AC1 DEXA I/O contract: schema validation, store round-trip, and the
trend rules (>=2 scans for a trend, 3+ for reliable, 6-12 week cadence, lean-mass
decline flag, body-fat stall flag). All data here is sanitized example data.

The target module has a hyphen in its name (hibiki-dexa.py), so it cannot be
imported with a normal `import` statement; we load it via importlib from the path
next to this test file.
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_MODULE_PATH = _THIS_DIR / "hibiki-dexa.py"

_spec = importlib.util.spec_from_file_location("hibiki_dexa", _MODULE_PATH)
assert _spec and _spec.loader, f"cannot load module at {_MODULE_PATH}"
dexa = importlib.util.module_from_spec(_spec)
sys.modules["hibiki_dexa"] = dexa
_spec.loader.exec_module(dexa)


# Sanitized example scans (not real body-composition data).
SCAN_1 = {"date": "2026-01-05", "body_fat_pct": 24.0, "lean_mass_kg": 60.0,
          "bone_density_tscore": -0.3}
SCAN_2 = {"date": "2026-02-23", "body_fat_pct": 22.0, "lean_mass_kg": 60.5}   # +49d
SCAN_3 = {"date": "2026-04-13", "body_fat_pct": 20.0, "lean_mass_kg": 61.0}   # +49d


class SchemaValidationTests(unittest.TestCase):
    def test_valid_full_record(self):
        r = dexa.DexaResult.from_record(SCAN_1)
        self.assertEqual(r.date, "2026-01-05")
        self.assertEqual(r.body_fat_pct, 24.0)
        self.assertEqual(r.lean_mass_kg, 60.0)
        self.assertEqual(r.bone_density_tscore, -0.3)
        self.assertIsNone(r.visceral_fat)

    def test_partial_scan_optional_fields_null(self):
        r = dexa.DexaResult.from_record(SCAN_2)
        rec = r.to_record()
        self.assertIsNone(rec["bone_density"])
        self.assertIsNone(rec["visceral_fat"])

    def test_missing_required_field_rejected(self):
        for missing in ("date", "body_fat_pct", "lean_mass_kg"):
            bad = dict(SCAN_1)
            del bad[missing]
            with self.assertRaises(dexa.DexaError):
                dexa.DexaResult.from_record(bad)

    def test_bad_date_rejected(self):
        with self.assertRaises(dexa.DexaError):
            dexa.DexaResult.from_record({**SCAN_1, "date": "05-01-2026"})

    def test_body_fat_out_of_range_rejected(self):
        with self.assertRaises(dexa.DexaError):
            dexa.DexaResult.from_record({**SCAN_1, "body_fat_pct": 0})
        with self.assertRaises(dexa.DexaError):
            dexa.DexaResult.from_record({**SCAN_1, "body_fat_pct": 100})

    def test_lean_mass_must_be_positive(self):
        with self.assertRaises(dexa.DexaError):
            dexa.DexaResult.from_record({**SCAN_1, "lean_mass_kg": 0})

    def test_bool_is_not_a_number(self):
        with self.assertRaises(dexa.DexaError):
            dexa.DexaResult.from_record({**SCAN_1, "lean_mass_kg": True})

    def test_stored_key_alias_round_trips(self):
        # to_record() emits "bone_density"; from_record() must read it back.
        r1 = dexa.DexaResult.from_record(SCAN_1)
        r2 = dexa.DexaResult.from_record(r1.to_record())
        self.assertEqual(r2.bone_density_tscore, -0.3)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = Path(self._tmp.name) / "nested" / "hibiki-progress.json"

    def tearDown(self):
        self._tmp.cleanup()

    def test_load_missing_store_is_empty(self):
        self.assertEqual(dexa.load_dexa_results(self.store), [])

    def test_add_creates_store_and_parents(self):
        dexa.add_dexa_result(dexa.DexaResult.from_record(SCAN_1), self.store)
        self.assertTrue(self.store.exists())
        loaded = dexa.load_dexa_results(self.store)
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].date, "2026-01-05")

    def test_add_preserves_other_keys(self):
        self.store.parent.mkdir(parents=True)
        self.store.write_text(json.dumps({"weight_log": [{"date": "2026-01-01", "kg": 80}]}))
        dexa.add_dexa_result(dexa.DexaResult.from_record(SCAN_1), self.store)
        data = json.loads(self.store.read_text())
        self.assertIn("weight_log", data)
        self.assertEqual(len(data["dexa_results"]), 1)

    def test_add_keeps_sorted_by_date(self):
        dexa.add_dexa_result(dexa.DexaResult.from_record(SCAN_3), self.store)
        dexa.add_dexa_result(dexa.DexaResult.from_record(SCAN_1), self.store)
        dexa.add_dexa_result(dexa.DexaResult.from_record(SCAN_2), self.store)
        dates = [r.date for r in dexa.load_dexa_results(self.store)]
        self.assertEqual(dates, ["2026-01-05", "2026-02-23", "2026-04-13"])

    def test_corrupt_store_raises(self):
        self.store.parent.mkdir(parents=True)
        self.store.write_text("{not json")
        with self.assertRaises(dexa.DexaError):
            dexa.load_dexa_results(self.store)


class TrendTests(unittest.TestCase):
    def _results(self, *records):
        return [dexa.DexaResult.from_record(r) for r in records]

    def test_one_scan_insufficient(self):
        report = dexa.analyze_trend(self._results(SCAN_1))
        self.assertEqual(report.status, dexa.TrendStatus.INSUFFICIENT)
        self.assertEqual(report.scan_count, 1)
        self.assertEqual(report.flags, [])

    def test_two_scans_preliminary(self):
        report = dexa.analyze_trend(self._results(SCAN_1, SCAN_2))
        self.assertEqual(report.status, dexa.TrendStatus.PRELIMINARY)
        self.assertEqual(report.scan_count, 2)

    def test_three_scans_reliable(self):
        report = dexa.analyze_trend(self._results(SCAN_1, SCAN_2, SCAN_3))
        self.assertEqual(report.status, dexa.TrendStatus.RELIABLE)

    def test_interval_window_flagging(self):
        report = dexa.analyze_trend(self._results(SCAN_1, SCAN_2))
        self.assertEqual(report.interval_days, 49)   # within 42-84
        self.assertTrue(report.interval_in_window)

    def test_interval_too_short_noted(self):
        near = {"date": "2026-01-15", "body_fat_pct": 23.8, "lean_mass_kg": 60.0}  # +10d
        report = dexa.analyze_trend(self._results(SCAN_1, near))
        self.assertFalse(report.interval_in_window)
        self.assertTrue(any("below" in n for n in report.notes))

    def test_directions_and_deltas(self):
        report = dexa.analyze_trend(self._results(SCAN_1, SCAN_3))
        self.assertEqual(report.body_fat_direction, dexa.TrendDirection.DOWN)
        self.assertEqual(report.body_fat_delta_pct, -4.0)
        self.assertEqual(report.lean_mass_direction, dexa.TrendDirection.UP)
        self.assertEqual(report.lean_mass_delta_kg, 1.0)
        self.assertEqual(report.flags, [])  # losing fat, gaining lean = healthy

    def test_lean_mass_decline_flag_when_training(self):
        s2 = {"date": "2026-02-23", "body_fat_pct": 23.0, "lean_mass_kg": 58.5}  # lean down
        report = dexa.analyze_trend(self._results(SCAN_1, s2), in_training=True)
        codes = [f.code for f in report.flags]
        self.assertIn("lean_mass_decline", codes)

    def test_lean_mass_decline_not_flagged_when_not_training(self):
        s2 = {"date": "2026-02-23", "body_fat_pct": 23.0, "lean_mass_kg": 58.5}
        report = dexa.analyze_trend(self._results(SCAN_1, s2), in_training=False)
        codes = [f.code for f in report.flags]
        self.assertNotIn("lean_mass_decline", codes)

    def test_body_fat_stall_flag_over_six_weeks(self):
        # Three scans ~7 weeks apart, body fat flat within +/-0.5 throughout.
        a = {"date": "2026-01-05", "body_fat_pct": 22.0, "lean_mass_kg": 60.0}
        b = {"date": "2026-02-23", "body_fat_pct": 22.2, "lean_mass_kg": 60.2}  # +49d
        c = {"date": "2026-04-13", "body_fat_pct": 21.8, "lean_mass_kg": 60.4}  # +49d
        report = dexa.analyze_trend(self._results(a, b, c))
        codes = [f.code for f in report.flags]
        self.assertIn("body_fat_stall", codes)

    def test_no_stall_flag_when_fat_moving(self):
        report = dexa.analyze_trend(self._results(SCAN_1, SCAN_2, SCAN_3))
        codes = [f.code for f in report.flags]
        self.assertNotIn("body_fat_stall", codes)

    def test_report_to_dict_serializable(self):
        report = dexa.analyze_trend(self._results(SCAN_1, SCAN_3))
        d = report.to_dict()
        json.dumps(d)  # must be JSON-serializable
        self.assertEqual(d["status"], "preliminary")
        self.assertEqual(d["body_fat_direction"], "down")


class IngestEntryPointTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = Path(self._tmp.name) / "hibiki-progress.json"

    def tearDown(self):
        self._tmp.cleanup()

    def test_ingest_persists_and_reports(self):
        r1 = dexa.ingest_and_report(SCAN_1, self.store)
        self.assertEqual(r1.status, dexa.TrendStatus.INSUFFICIENT)

        s2 = {"date": "2026-02-23", "body_fat_pct": 23.5, "lean_mass_kg": 58.0}
        r2 = dexa.ingest_and_report(s2, self.store, in_training=True)
        self.assertEqual(r2.status, dexa.TrendStatus.PRELIMINARY)
        self.assertEqual(r2.scan_count, 2)
        self.assertIn("lean_mass_decline", [f.code for f in r2.flags])

        # Both scans landed in the store.
        self.assertEqual(len(dexa.load_dexa_results(self.store)), 2)

    def test_ingest_rejects_bad_input_before_persist(self):
        with self.assertRaises(dexa.DexaError):
            dexa.ingest_and_report({"date": "2026-01-05"}, self.store)
        self.assertFalse(self.store.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
