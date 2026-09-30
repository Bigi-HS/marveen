#!/usr/bin/env python3
"""Unit tests for coverage-trend.py (card 1d4b38c3 ENG-045 follow-up).

Tests:
  - select_new_low_files: new-file selection logic
  - header-overlap regression: new-section Y does not collide with top-losers header
    when top_losers is empty

Run: python3 scripts/test_coverage_trend.py
"""

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "coverage_trend", os.path.join(_HERE, "coverage-trend.py")
)
ct = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ct)


# ---------------------------------------------------------------------------
# select_new_low_files
# ---------------------------------------------------------------------------

class SelectNewLowFiles(unittest.TestCase):
    def test_new_file_below_threshold_included(self):
        first = {"a.ts": 90.0}
        last  = {"a.ts": 90.0, "b.ts": 50.0}
        result = ct.select_new_low_files(first, last)
        fps = [fp for _, fp in result]
        self.assertIn("b.ts", fps)

    def test_existing_file_below_threshold_excluded(self):
        first = {"old.ts": 40.0}
        last  = {"old.ts": 30.0}
        result = ct.select_new_low_files(first, last)
        self.assertEqual(result, [])

    def test_new_file_at_or_above_threshold_excluded(self):
        first = {}
        last  = {"good.ts": 80.0, "great.ts": 95.0}
        result = ct.select_new_low_files(first, last)
        self.assertEqual(result, [])

    def test_sorted_ascending_by_pct(self):
        first = {}
        last  = {"c.ts": 70.0, "a.ts": 50.0, "b.ts": 60.0}
        result = ct.select_new_low_files(first, last)
        pcts = [p for p, _ in result]
        self.assertEqual(pcts, sorted(pcts))

    def test_limit_to_three(self):
        first = {}
        last  = {f"f{i}.ts": float(10 + i) for i in range(6)}
        result = ct.select_new_low_files(first, last)
        self.assertLessEqual(len(result), 3)

    def test_custom_threshold(self):
        first = {}
        last  = {"x.ts": 55.0}
        self.assertEqual(ct.select_new_low_files(first, last, threshold=50.0), [])
        self.assertEqual(len(ct.select_new_low_files(first, last, threshold=60.0)), 1)

    def test_empty_inputs(self):
        self.assertEqual(ct.select_new_low_files({}, {}), [])


# ---------------------------------------------------------------------------
# header-overlap regression
# ---------------------------------------------------------------------------

class HeaderOverlapRegression(unittest.TestCase):
    """When top_losers is empty and new_low is non-empty, the SVG must not
    render the 'Top losers' header AND the 'New files' header at the same Y."""

    def _make_db_with_two_snapshots(self, tmpdir, first_files, last_files):
        db_path = os.path.join(tmpdir, "cov.db")
        conn = ct.open_db(db_path)

        for files in [first_files, last_files]:
            cur = conn.execute(
                "INSERT INTO coverage_snapshots (pr_number, branch, sha, recorded_at, total_pct) "
                "VALUES (?,?,?,?,?)",
                (None, "test", None, len(conn.execute("SELECT id FROM coverage_snapshots").fetchall()), 85.0)
            )
            snap_id = cur.lastrowid
            for fp, pct in files.items():
                conn.execute(
                    "INSERT INTO coverage_files (snapshot_id, file_path, lines_pct) VALUES (?,?,?)",
                    (snap_id, fp, pct)
                )
        conn.commit()
        conn.close()
        return db_path

    def test_no_overlap_when_no_losers_but_new_low_present(self):
        """Top losers = [] (no regressions), new_low present → headers must not share Y."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # first snapshot: one file; last snapshot: same file + new low file
            first_files = {"existing.ts": 90.0}
            last_files  = {"existing.ts": 91.0, "new-bad.ts": 30.0}
            db_path = self._make_db_with_two_snapshots(tmpdir, first_files, last_files)

            out_svg = os.path.join(tmpdir, "trend.svg")
            import argparse
            args = argparse.Namespace(db=db_path, out=out_svg, last=20)
            ct.cmd_chart(args)

            svg = open(out_svg).read()

            # Find y= values of the two legend headers
            import re
            top_losers_matches = re.findall(
                r'y="([0-9.]+)"[^>]*>Top losers', svg
            )
            new_files_matches = re.findall(
                r'y="([0-9.]+)"[^>]*>New files', svg
            )

            # "Top losers" header must NOT appear when there are no losers
            self.assertEqual(
                top_losers_matches, [],
                "Top losers header rendered even with no losers — header present in SVG"
            )

            # "New files" header must appear
            self.assertTrue(
                len(new_files_matches) > 0,
                "New files header not rendered in SVG"
            )

    def test_both_headers_distinct_y_when_both_present(self):
        """When both losers and new_low exist, their headers must be at different Y positions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            first_files = {"regressed.ts": 80.0}
            last_files  = {"regressed.ts": 60.0, "new-bad.ts": 20.0}
            db_path = self._make_db_with_two_snapshots(tmpdir, first_files, last_files)

            out_svg = os.path.join(tmpdir, "trend.svg")
            import argparse
            args = argparse.Namespace(db=db_path, out=out_svg, last=20)
            ct.cmd_chart(args)

            svg = open(out_svg).read()

            import re
            top_losers_y = re.findall(r'y="([0-9.]+)"[^>]*>Top losers', svg)
            new_files_y  = re.findall(r'y="([0-9.]+)"[^>]*>New files', svg)

            self.assertTrue(len(top_losers_y) > 0, "Top losers header missing")
            self.assertTrue(len(new_files_y) > 0, "New files header missing")
            self.assertNotEqual(
                float(top_losers_y[0]), float(new_files_y[0]),
                f"Headers at same Y ({top_losers_y[0]}) — overlap!"
            )


if __name__ == "__main__":
    unittest.main()
