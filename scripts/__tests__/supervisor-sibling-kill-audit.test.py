#!/usr/bin/env python3
"""Tests for scripts/supervisor-sibling-kill-audit.py (card OPS-106).

Run: python3 scripts/__tests__/supervisor-sibling-kill-audit.test.py

Synthetic logs only. The counts the real log produced at the time of the fix
(401 launches / 57 absents / 47 coincident, 27-of-28 on the `down` branch and
18-of-373 on the `not responding` branch) are recorded in the script's docstring
as history, not asserted here -- pinning live numbers would make this fail every
time the log rotates.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SCRIPT = _HERE.parent / "supervisor-sibling-kill-audit.py"

_spec = importlib.util.spec_from_file_location("sibling_audit", _SCRIPT)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

INCIDENT = [
    "2026-08-04 04:56:52 [fleet-supervisor] dashboard: session up but :3420 not responding -- relaunching",
    "2026-08-04 04:56:52 [fleet-supervisor] dashboard: launched (tmux marveen -> node dist/index.js)",
    "2026-08-04 04:56:52 [fleet-supervisor] channels: session marveen-channels absent -- launching",
    "2026-08-04 04:56:52 [fleet-supervisor] channels: launched scripts/channels.sh (session marveen-channels)",
]
# An absence the supervisor did NOT cause: channels died on its own, and the
# next tick a minute later picked it up. This is the case the audit must not
# count, otherwise the number means "channels restarted" rather than "we killed it".
INNOCENT = [
    "2026-08-04 06:10:00 [fleet-supervisor] channels: session marveen-channels absent -- launching",
    "2026-08-04 06:10:00 [fleet-supervisor] channels: launched scripts/channels.sh (session marveen-channels)",
]
# A dashboard relaunch that spared the sibling, because `marveen` existed and the
# exact match won. 373 of these are why the ratio, not the raw count, is the tell.
HARMLESS = [
    "2026-07-26 09:59:37 [fleet-supervisor] dashboard: session up but :3420 not responding -- relaunching",
    "2026-07-26 09:59:37 [fleet-supervisor] dashboard: launched (tmux marveen -> node dist/index.js)",
]


class AnalyseTests(unittest.TestCase):
    def test_incident_shape_is_counted_as_a_kill(self):
        r = mod.analyse(INCIDENT)
        self.assertEqual(len(r["coincident"]), 1)
        self.assertEqual(len(r["notresp_coincident"]), 1)
        self.assertEqual(len(r["down_coincident"]), 0)

    def test_an_absence_without_a_launch_is_not_counted(self):
        r = mod.analyse(INNOCENT)
        self.assertEqual(len(r["absents"]), 1)
        self.assertEqual(len(r["coincident"]), 0)

    def test_a_launch_without_an_absence_is_not_counted(self):
        r = mod.analyse(HARMLESS)
        self.assertEqual(len(r["launches"]), 1)
        self.assertEqual(len(r["coincident"]), 0)

    def test_branches_are_attributed_separately(self):
        down = [
            "2026-07-11 01:23:19 [fleet-supervisor] dashboard: down -- launching",
            "2026-07-11 01:23:19 [fleet-supervisor] dashboard: launched (tmux marveen -> node dist/index.js)",
            "2026-07-11 01:23:19 [fleet-supervisor] channels: session marveen-channels absent -- launching",
        ]
        r = mod.analyse(INCIDENT + down + HARMLESS + INNOCENT)
        self.assertEqual(len(r["coincident"]), 2)
        self.assertEqual(len(r["down_coincident"]), 1)
        self.assertEqual(len(r["notresp_coincident"]), 1)

    def test_unparsable_lines_are_ignored(self):
        r = mod.analyse(["", "no timestamp here", "[armorer] supervisor restart"] + INCIDENT)
        self.assertEqual(len(r["coincident"]), 1)


class SinceGateTests(unittest.TestCase):
    def _run(self, lines, since):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "sup.log")
            with open(p, "w") as f:
                f.write("\n".join(lines) + "\n")
            return subprocess.run(
                [sys.executable, str(_SCRIPT), "--log", p, "--since", since],
                capture_output=True, text=True, timeout=60,
            )

    def test_a_kill_after_the_cutoff_fails(self):
        r = self._run(INCIDENT, "2026-08-01")
        self.assertEqual(r.returncode, 1)
        self.assertIn("REGRESSION", r.stdout)
        self.assertIn("2026-08-04 04:56:52", r.stdout)

    def test_the_same_kill_before_the_cutoff_passes(self):
        # History must not keep the gate red forever, or it gets switched off.
        r = self._run(INCIDENT, "2026-08-05")
        self.assertEqual(r.returncode, 0)
        self.assertIn("clean since", r.stdout)

    def test_missing_log_is_an_error_not_a_clean_result(self):
        r = subprocess.run(
            [sys.executable, str(_SCRIPT), "--log", "/nonexistent/sup.log", "--since", "2026-01-01"],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(r.returncode, 2, "a missing log must not read as 'no regressions'")


if __name__ == "__main__":
    unittest.main(verbosity=2)
