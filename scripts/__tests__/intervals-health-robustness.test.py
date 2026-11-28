#!/usr/bin/env python3
"""Hermetic tests for the intervals.icu health auto-fetch robustness work
(card eng/health-autofetch-robustness).

Two units under test, both exercised against a SYNTHETIC temp SQLite DB -- the
live store/noa.db is NEVER touched and NO network call is made:

  1. scripts/intervals_health_fetcher.py :: _row_is_complete
     The re-fetch decision. A row is COMPLETE only when every core field
     (resting_hr, sleep_hours, hrv, steps) is non-NULL. Missing row -> None
     (fetch), partial row -> False (re-fetch), complete row -> True (skip).
     This is the logic that replaced "skip if a row exists", so a day that
     landed with HRV NULL now gets re-fetched to fill HRV later.

  2. scripts/intervals-health-completeness-watchdog.py :: _stuck_days
     The alert decision. A day is STUCK only when resting_hr AND sleep_hours are
     BOTH NULL *and* the day is older than the ~36h finalization window. We assert
     the DANGEROUS direction too: a still-filling recent day is NOT flagged, and an
     HRV-only gap is NOT flagged (HRV finalizes late; the fetcher handles it).

Run:
    python3 scripts/__tests__/intervals-health-robustness.test.py
    pytest scripts/__tests__/intervals-health-robustness.test.py
"""
from __future__ import annotations

import importlib.util
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SCRIPTS = _HERE.parent

_FETCHER = _SCRIPTS / "intervals_health_fetcher.py"
_WATCHDOG = _SCRIPTS / "intervals-health-completeness-watchdog.py"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fetcher = _load("intervals_health_fetcher", _FETCHER)
watchdog = _load("intervals_health_completeness_watchdog", _WATCHDOG)


# --- fixture -----------------------------------------------------------------
_COLS = ("date", "steps", "resting_hr", "hrv", "sleep_hours")


def _make_db(tmp: Path, rows: list[dict]) -> Path:
    """Minimal health_data table with just the columns these units read."""
    db = tmp / "noa.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE health_data ("
        " date TEXT PRIMARY KEY, steps INTEGER, resting_hr INTEGER,"
        " hrv INTEGER, sleep_hours REAL)"
    )
    for r in rows:
        conn.execute(
            "INSERT INTO health_data (date, steps, resting_hr, hrv, sleep_hours) "
            "VALUES (?,?,?,?,?)",
            (r.get("date"), r.get("steps"), r.get("resting_hr"),
             r.get("hrv"), r.get("sleep_hours")),
        )
    conn.commit()
    conn.close()
    return db


# --- 1. fetcher completeness decision ----------------------------------------
class RowIsCompleteTest(unittest.TestCase):
    def _cur(self, rows):
        self._tmpdir = tempfile.TemporaryDirectory()
        db = _make_db(Path(self._tmpdir.name), rows)
        self._conn = sqlite3.connect(db)
        self.addCleanup(self._conn.close)
        self.addCleanup(self._tmpdir.cleanup)
        return self._conn.cursor()

    def test_missing_row_returns_none(self):
        cur = self._cur([])
        self.assertIsNone(fetcher._row_is_complete(cur, "2026-11-20"))

    def test_complete_row_returns_true(self):
        cur = self._cur([dict(date="2026-11-20", steps=5000,
                              resting_hr=50, hrv=60, sleep_hours=7.5)])
        self.assertIs(fetcher._row_is_complete(cur, "2026-11-20"), True)

    def test_hrv_null_is_incomplete(self):
        # The exact case from today: steps/HR/sleep landed, HRV still NULL upstream.
        cur = self._cur([dict(date="2026-11-28", steps=29,
                              resting_hr=50, hrv=None, sleep_hours=8.5)])
        self.assertIs(fetcher._row_is_complete(cur, "2026-11-28"), False)

    def test_any_core_field_null_is_incomplete(self):
        cur = self._cur([
            dict(date="2026-11-21", steps=None, resting_hr=50, hrv=60, sleep_hours=7.5),
            dict(date="2026-11-22", steps=100, resting_hr=None, hrv=60, sleep_hours=7.5),
            dict(date="2026-11-23", steps=100, resting_hr=50, hrv=60, sleep_hours=None),
        ])
        for d in ("2026-11-21", "2026-11-22", "2026-11-23"):
            self.assertIs(fetcher._row_is_complete(cur, d), False, d)

    def test_core_fields_constant_shape(self):
        # Guard against a silent drift of which fields gate completeness.
        self.assertEqual(
            set(fetcher.CORE_FIELDS),
            {"resting_hr", "sleep_hours", "hrv", "steps"},
        )

    def test_lookback_is_a_constant(self):
        self.assertIsInstance(fetcher.LOOKBACK_DAYS, int)
        self.assertGreaterEqual(fetcher.LOOKBACK_DAYS, 1)


# --- 2. watchdog stuck-vs-filling decision -----------------------------------
class StuckDaysTest(unittest.TestCase):
    def _stuck(self, rows, today, now):
        self._tmpdir = tempfile.TemporaryDirectory()
        db = _make_db(Path(self._tmpdir.name), rows)
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        self.addCleanup(conn.close)
        self.addCleanup(self._tmpdir.cleanup)
        return watchdog._stuck_days(conn, today, now)

    def test_old_day_both_early_fields_null_is_stuck(self):
        today = date(2026, 11, 28)
        now = datetime(2026, 11, 28, 12, 0)
        rows = [dict(date="2026-11-24", steps=None, resting_hr=None,
                     hrv=None, sleep_hours=None)]
        self.assertEqual(self._stuck(rows, today, now), ["2026-11-24"])

    def test_today_still_filling_is_not_flagged(self):
        # Today landed partial (both early fields NULL) -> inside the window, NOT stuck.
        today = date(2026, 11, 28)
        now = datetime(2026, 11, 28, 12, 0)
        rows = [dict(date="2026-11-28", steps=None, resting_hr=None,
                     hrv=None, sleep_hours=None)]
        self.assertEqual(self._stuck(rows, today, now), [])

    def test_yesterday_within_finalization_window_not_flagged(self):
        # Early on the day after: yesterday's data finalized <36h ago -> exempt.
        today = date(2026, 11, 28)
        now = datetime(2026, 11, 28, 6, 0)  # 06:00, yesterday finalized at 00:00 -> 6h ago
        rows = [dict(date="2026-11-27", steps=None, resting_hr=None,
                     hrv=None, sleep_hours=None)]
        self.assertEqual(self._stuck(rows, today, now), [])

    def test_hrv_only_gap_is_not_flagged(self):
        # Old day, but resting_hr + sleep_hours ARE present and only HRV is NULL.
        # HRV finalizes late and the fetcher re-fetches it -> must NOT alarm.
        today = date(2026, 11, 28)
        now = datetime(2026, 11, 28, 12, 0)
        rows = [dict(date="2026-11-24", steps=5000, resting_hr=50,
                     hrv=None, sleep_hours=7.5)]
        self.assertEqual(self._stuck(rows, today, now), [])

    def test_resting_hr_present_sleep_null_not_flagged(self):
        # Only ONE early field present still means data is flowing -> not stuck.
        today = date(2026, 11, 28)
        now = datetime(2026, 11, 28, 12, 0)
        rows = [dict(date="2026-11-24", steps=5000, resting_hr=50,
                     hrv=60, sleep_hours=None)]
        self.assertEqual(self._stuck(rows, today, now), [])

    def test_multiple_stuck_days_ordered_oldest_first(self):
        today = date(2026, 11, 28)
        now = datetime(2026, 11, 28, 12, 0)
        rows = [
            dict(date="2026-11-25", steps=None, resting_hr=None, hrv=None, sleep_hours=None),
            dict(date="2026-11-24", steps=None, resting_hr=None, hrv=None, sleep_hours=None),
        ]
        self.assertEqual(self._stuck(rows, today, now), ["2026-11-24", "2026-11-25"])

    def test_healthy_window_is_silent(self):
        today = date(2026, 11, 28)
        now = datetime(2026, 11, 28, 12, 0)
        rows = [dict(date="2026-11-24", steps=5000, resting_hr=50,
                     hrv=60, sleep_hours=7.5)]
        self.assertEqual(self._stuck(rows, today, now), [])


if __name__ == "__main__":
    unittest.main()
