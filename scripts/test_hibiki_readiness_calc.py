#!/usr/bin/env python3
"""Tests for hibiki-readiness-calc.py (ENG-148, card cddfd1ce).

Contract locked with Hibiki (formula authority) 2026-10-01:
- stress.combined: HRV/RHR point model (cap 4); level 0=GREEN, 1-2=YELLOW, 3-4=RED.
- sleep_quality.score: derived 0-5 (zepp_score // 20, capped); level >=4 GREEN, ==3 YELLOW, <=2 RED.
- deep/REM pct + avg = 0.0 (Zepp schema lacks them).
- 7-day MA = last up-to-7 AVAILABLE dailies before target (skip gaps); 0 history -> delta 0.0, GREEN.
- Guards: missing today's Zepp -> exit(1) + stderr; CTL/ATL state-write ONLY on exit(0).

The script has a hyphenated filename, so load it via importlib (fleet convention,
mirrors test_hibiki_dexa.py / test_hibiki_wakeup_relay.py).
"""
import importlib.util
import io
import json
import math
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_MODULE_PATH = _THIS_DIR / "hibiki-readiness-calc.py"
_spec = importlib.util.spec_from_file_location("hibiki_readiness_calc", _MODULE_PATH)
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)


def _zepp(hrv, rhr, dur, score, load=None):
    d = {"vitals": {"hrv": hrv, "restingHr": rhr}, "sleep": {"durationMin": dur, "score": score}}
    if load is not None:
        d["training"] = {"load": load}
    return d


def _write_daily(zepp_dir, date_str, hrv, rhr, dur, score, load=None):
    p = Path(zepp_dir) / f"daily-{date_str}.json"
    body = _zepp(hrv, rhr, dur, score, load)
    body["date"] = date_str
    p.write_text(json.dumps(body))
    return p


class HrvPointsTests(unittest.TestCase):
    def test_bands(self):
        self.assertEqual(rc.hrv_points(-5), 0)
        self.assertEqual(rc.hrv_points(-10), 0)   # >= -10 is 0pt
        self.assertEqual(rc.hrv_points(-15), 1)
        self.assertEqual(rc.hrv_points(-20), 1)   # -20 not < -20 -> still 1pt band
        self.assertEqual(rc.hrv_points(-25), 2)
        self.assertEqual(rc.hrv_points(10), 0)
        self.assertEqual(rc.hrv_points(15), 0)    # > +15 strict
        self.assertEqual(rc.hrv_points(20), 1)


class RhrPointsTests(unittest.TestCase):
    def test_bands(self):
        self.assertEqual(rc.rhr_points(3), 0)
        self.assertEqual(rc.rhr_points(5), 0)     # <= +5 is 0pt
        self.assertEqual(rc.rhr_points(6), 1)
        self.assertEqual(rc.rhr_points(8), 1)     # +5..+8 inclusive upper
        self.assertEqual(rc.rhr_points(9), 2)


class CombinedAndStressLevelTests(unittest.TestCase):
    def test_combined_caps_at_4(self):
        self.assertEqual(rc.combined_stress(2, 2), 4)
        self.assertEqual(rc.combined_stress(2, 1), 3)
        self.assertEqual(rc.combined_stress(0, 0), 0)

    def test_stress_level(self):
        self.assertEqual(rc.stress_level(0), "GREEN")
        self.assertEqual(rc.stress_level(1), "YELLOW")
        self.assertEqual(rc.stress_level(2), "YELLOW")
        self.assertEqual(rc.stress_level(3), "RED")
        self.assertEqual(rc.stress_level(4), "RED")


class SleepScoreTests(unittest.TestCase):
    def test_score_5(self):
        self.assertEqual(rc.sleep_score_5(76), 3)
        self.assertEqual(rc.sleep_score_5(85), 4)
        self.assertEqual(rc.sleep_score_5(100), 5)
        self.assertEqual(rc.sleep_score_5(120), 5)   # cap 5
        self.assertEqual(rc.sleep_score_5(59), 2)
        self.assertEqual(rc.sleep_score_5(0), 0)

    def test_sleep_level(self):
        self.assertEqual(rc.sleep_level(5), "GREEN")
        self.assertEqual(rc.sleep_level(4), "GREEN")
        self.assertEqual(rc.sleep_level(3), "YELLOW")
        self.assertEqual(rc.sleep_level(2), "RED")
        self.assertEqual(rc.sleep_level(0), "RED")


class CtlAtlTests(unittest.TestCase):
    def test_from_zero(self):
        ctl, atl, tsb = rc.update_ctl_atl(0.0, 0.0, 100)
        self.assertAlmostEqual(ctl, 100 * (1 - math.exp(-1 / 42)), places=4)
        self.assertAlmostEqual(atl, 100 * (1 - math.exp(-1 / 7)), places=4)
        self.assertAlmostEqual(tsb, ctl - atl, places=6)

    def test_decay_with_zero_load(self):
        ctl, atl, tsb = rc.update_ctl_atl(50.0, 30.0, 0)
        self.assertAlmostEqual(ctl, 50.0 * math.exp(-1 / 42), places=4)
        self.assertAlmostEqual(atl, 30.0 * math.exp(-1 / 7), places=4)


class LoadAdjustmentTests(unittest.TestCase):
    def test_stress_driven(self):
        self.assertEqual(rc.load_adjustment("GREEN", "GREEN"), 0)
        self.assertEqual(rc.load_adjustment("YELLOW", "GREEN"), -10)
        self.assertEqual(rc.load_adjustment("RED", "GREEN"), -20)

    def test_bad_sleep_and_stress_forces_minus20(self):
        self.assertEqual(rc.load_adjustment("YELLOW", "YELLOW"), -20)
        self.assertEqual(rc.load_adjustment("YELLOW", "RED"), -20)
        self.assertEqual(rc.load_adjustment("RED", "RED"), -20)

    def test_green_stress_no_cut_even_if_bad_sleep(self):
        # spec step 8 gives no sleep-only adjustment; combined rule needs stress present
        self.assertEqual(rc.load_adjustment("GREEN", "RED"), 0)


class NextSessionReadinessTests(unittest.TestCase):
    def test_green(self):
        self.assertEqual(rc.next_session_readiness(6, "GREEN"), "GREEN")

    def test_red_via_tsb_or_stress(self):
        self.assertEqual(rc.next_session_readiness(-11, "GREEN"), "RED")
        self.assertEqual(rc.next_session_readiness(0, "RED"), "RED")
        self.assertEqual(rc.next_session_readiness(6, "RED"), "RED")

    def test_yellow_default(self):
        self.assertEqual(rc.next_session_readiness(0, "YELLOW"), "YELLOW")
        self.assertEqual(rc.next_session_readiness(6, "YELLOW"), "YELLOW")


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.zepp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_moving_average_empty_is_zero(self):
        self.assertEqual(rc.moving_average([]), 0.0)

    def test_collect_history_skips_gaps_and_caps_7(self):
        # 9 dailies before target, gappy; expect most-recent 7, target excluded
        for day in range(1, 10):
            _write_daily(self.zepp, f"2026-09-{day:02d}", 50, 55, 400, 80)
        _write_daily(self.zepp, "2026-09-15", 50, 55, 400, 80)  # target day present too
        hist = rc.collect_history("2026-09-15", self.zepp, max_n=7)
        self.assertEqual(len(hist), 7)
        # target's own file must never be in history
        for h in hist:
            self.assertNotEqual(h.get("date"), "2026-09-15")

    def test_collect_history_zero_when_none_before(self):
        _write_daily(self.zepp, "2026-09-15", 50, 55, 400, 80)
        self.assertEqual(rc.collect_history("2026-09-15", self.zepp, max_n=7), [])


class ComputeReadinessIntegrationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.zepp = os.path.join(self._tmp.name, "zepp")
        os.makedirs(self.zepp)
        self.state = os.path.join(self._tmp.name, "hibiki-ctl-atl.json")

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_today_raises_and_no_state_write(self):
        with self.assertRaises(rc.MissingZeppData):
            rc.compute_readiness("2026-09-28", self.zepp, self.state)
        self.assertFalse(os.path.exists(self.state), "state must NOT be written on missing data")

    def test_full_contract_shape(self):
        # 7-day history + today
        for day in range(21, 28):
            _write_daily(self.zepp, f"2026-09-{day:02d}", 50, 55, 420, 80, load=100)
        _write_daily(self.zepp, "2026-09-28", 32, 60, 608, 76, load=147)
        result, new_state = rc.compute_readiness("2026-09-28", self.zepp, self.state)

        # top-level keys
        for k in ("date", "ctl", "atl", "tsb", "sleep_min", "stress",
                  "sleep_quality", "load_adjustment_pct", "recovery", "max_hr_updated"):
            self.assertIn(k, result)
        self.assertEqual(result["date"], "2026-09-28")
        self.assertEqual(result["sleep_min"], 608)
        self.assertIsNone(result["max_hr_updated"])

        st = result["stress"]
        for k in ("level", "combined", "hrv_today", "hrv_delta", "rhr_today", "rhr_delta"):
            self.assertIn(k, st)
        self.assertEqual(st["hrv_today"], 32)
        self.assertEqual(st["rhr_today"], 60)
        # hrv_delta = 32 - 50 = -18 -> hrv_pts 1 ; rhr_delta = 60-55 = +5 -> rhr_pts 0 -> combined 1 -> YELLOW
        self.assertAlmostEqual(st["hrv_delta"], -18.0, places=1)
        self.assertAlmostEqual(st["rhr_delta"], 5.0, places=1)
        self.assertEqual(st["combined"], 1)
        self.assertEqual(st["level"], "YELLOW")

        sq = result["sleep_quality"]
        self.assertEqual(sq["score"], 3)          # 76 // 20
        self.assertEqual(sq["level"], "YELLOW")
        self.assertEqual(sq["deep_pct"], 0.0)
        self.assertEqual(sq["rem_pct"], 0.0)
        self.assertEqual(sq["deep_avg"], 0.0)
        self.assertEqual(sq["rem_avg"], 0.0)
        self.assertEqual(sq["history_days"], 7)
        # dur_avg = 420 min = 7.0 h
        self.assertAlmostEqual(sq["dur_avg"], 7.0, places=1)

        # YELLOW stress + YELLOW sleep -> -20
        self.assertEqual(result["load_adjustment_pct"], -20)
        self.assertIn(result["recovery"]["next_session_readiness"], ("GREEN", "YELLOW", "RED"))

        # new_state carries ctl/atl/tsb/date for write-back
        for k in ("ctl", "atl", "tsb", "date"):
            self.assertIn(k, new_state)
        self.assertEqual(new_state["date"], "2026-09-28")

    def test_zero_history_green_fallback(self):
        _write_daily(self.zepp, "2026-09-28", 32, 60, 608, 76, load=147)
        result, _ = rc.compute_readiness("2026-09-28", self.zepp, self.state)
        self.assertEqual(result["stress"]["hrv_delta"], 0.0)
        self.assertEqual(result["stress"]["rhr_delta"], 0.0)
        self.assertEqual(result["stress"]["level"], "GREEN")
        self.assertEqual(result["sleep_quality"]["history_days"], 0)


class MainCliTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.zepp = os.path.join(self._tmp.name, "zepp")
        os.makedirs(self.zepp)
        self.state = os.path.join(self._tmp.name, "hibiki-ctl-atl.json")

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_file_exit1_stderr_no_state(self):
        err = io.StringIO()
        with redirect_stderr(err):
            code = rc.main(["--json", "--date", "2026-09-28",
                            "--zepp-dir", self.zepp, "--state", self.state])
        self.assertEqual(code, 1)
        self.assertIn("Nincs mai Zepp adat: 2026-09-28", err.getvalue())
        self.assertFalse(os.path.exists(self.state))

    def test_json_stdout_and_state_written_on_success(self):
        _write_daily(self.zepp, "2026-09-28", 32, 60, 608, 76, load=147)
        out = io.StringIO()
        with redirect_stdout(out):
            code = rc.main(["--json", "--date", "2026-09-28",
                            "--zepp-dir", self.zepp, "--state", self.state])
        self.assertEqual(code, 0)
        parsed = json.loads(out.getvalue())
        self.assertEqual(parsed["date"], "2026-09-28")
        self.assertTrue(os.path.exists(self.state), "state must be written on exit(0)")
        saved = json.loads(Path(self.state).read_text())
        self.assertEqual(saved["date"], "2026-09-28")
        self.assertIn("ctl", saved)


class DateValidationTests(unittest.TestCase):
    """Thor ENG-148 hardening: --date must be a strict, real YYYY-MM-DD.

    A malformed value feeds into the daily-{date}.json path. The missing-file
    branch already safe-fails, but an explicit exit(2) on a malformed --date is
    clearer than a misleading "Nincs mai Zepp adat" and closes the path-traversal
    shape at the door. Validation applies ONLY to a user-supplied --date; the
    default (today) is always valid.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.zepp = os.path.join(self._tmp.name, "zepp")
        os.makedirs(self.zepp)
        self.state = os.path.join(self._tmp.name, "hibiki-ctl-atl.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _run_date(self, value):
        err = io.StringIO()
        with redirect_stderr(err):
            code = rc.main(["--json", "--date", value,
                            "--zepp-dir", self.zepp, "--state", self.state])
        return code, err.getvalue()

    def test_path_traversal_rejected(self):
        code, err = self._run_date("../../etc/passwd")
        self.assertEqual(code, 2)
        self.assertIn("Invalid --date", err)
        self.assertFalse(os.path.exists(self.state), "no state write on invalid date")

    def test_non_date_string_rejected(self):
        code, err = self._run_date("notadate")
        self.assertEqual(code, 2)
        self.assertIn("Invalid --date", err)

    def test_impossible_calendar_date_rejected(self):
        # regex-shaped but not a real date
        code, err = self._run_date("2026-13-45")
        self.assertEqual(code, 2)
        self.assertIn("Invalid --date", err)

    def test_non_zero_padded_rejected(self):
        # strict YYYY-MM-DD: single-digit month/day must not slip through
        code, _ = self._run_date("2026-1-5")
        self.assertEqual(code, 2)

    def test_empty_string_rejected(self):
        code, _ = self._run_date("")
        self.assertEqual(code, 2)

    def test_valid_date_passes_validation(self):
        # a well-formed date is NOT rejected: it reaches the missing-file branch (exit 1),
        # proving the validator does not block legitimate input.
        code, err = self._run_date("2026-09-28")
        self.assertEqual(code, 1)
        self.assertIn("Nincs mai Zepp adat: 2026-09-28", err)

    def test_valid_helper_direct(self):
        self.assertTrue(rc._valid_date("2026-09-28"))
        self.assertFalse(rc._valid_date("2026-9-28"))
        self.assertFalse(rc._valid_date("2026-02-30"))
        self.assertFalse(rc._valid_date("../2026-09-28"))
        self.assertFalse(rc._valid_date("2026-09-28\n"))


if __name__ == "__main__":
    unittest.main()
