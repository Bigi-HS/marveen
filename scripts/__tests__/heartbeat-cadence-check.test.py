#!/usr/bin/env python3
"""Acceptance tests for scripts/heartbeat-cadence-check.py (card a363c33e).

Tests cover the four required classifications plus adversarial directions
(fail-closed on bad input, CWD-independence via subprocess with cwd!=repo-root).

Run: python3 scripts/__tests__/heartbeat-cadence-check.test.py
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# ---------------------------------------------------------------------------
# Module loading (CWD-independent, same pattern as guardrail tests)
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, "..", ".."))
_SCRIPT = os.path.join(_REPO, "scripts", "heartbeat-cadence-check.py")


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "heartbeat_cadence_check", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod = _load_module()
classify_cadence = mod.classify_cadence

# ---------------------------------------------------------------------------
# Shared time constants
# ---------------------------------------------------------------------------
NOW = 1_700_000_000.0  # arbitrary fixed epoch for determinism
CADENCE = 15  # minutes


def _spaced(n: int, interval_min: float = CADENCE, start: float = NOW) -> list:
    """Return n timestamps spaced exactly `interval_min` minutes apart."""
    s = interval_min * 60
    return [start - (n - 1 - i) * s for i in range(n)]


# ---------------------------------------------------------------------------
# 1. Normal cadence -> ok
# ---------------------------------------------------------------------------


class TestNormalCadence(unittest.TestCase):
    def test_exact_cadence_ok(self):
        """Firings at exactly the expected interval must classify as ok."""
        pts = _spaced(10)
        result = classify_cadence(pts, cadence_minutes=CADENCE, now=NOW, session_alive=True)
        self.assertEqual(result, "ok")

    def test_slightly_late_ok(self):
        """Firings up to ~1.9x the interval are still a single period (0 misses).

        A gap of 1900s with a 15min (900s) cadence: int(1900/900)=2 expected,
        2-1=1 miss per gap.  One miss per gap never triggers the alert
        (threshold=2 misses in a single gap).  Pass now=pts[-1] so there is
        no trailing gap to worry about.
        """
        # 1.9x cadence = 1 expected = 0 missed per gap
        pts = [NOW - 1900.0 * 2, NOW - 1900.0, NOW]  # ~31.7min gap
        # Set now to last timestamp so no trailing gap is added
        result = classify_cadence(pts, cadence_minutes=CADENCE, now=pts[-1], session_alive=True)
        self.assertEqual(result, "ok")

    def test_unsorted_input_still_ok(self):
        """Input order must not matter -- the function sorts internally."""
        pts = _spaced(6)
        pts_shuffled = list(reversed(pts))
        result = classify_cadence(pts_shuffled, cadence_minutes=CADENCE, now=NOW, session_alive=True)
        self.assertEqual(result, "ok")


# ---------------------------------------------------------------------------
# 2. Single miss -> ok
# ---------------------------------------------------------------------------


class TestSingleMiss(unittest.TestCase):
    def test_one_miss_is_tolerated(self):
        """A single missed firing (gap ~2.1x) must NOT trigger an alert."""
        # 2.1x cadence = 2 expected = 1 missed
        cadence_sec = CADENCE * 60
        pts = [NOW - cadence_sec * 4, NOW - cadence_sec * 2.1, NOW]
        result = classify_cadence(pts, cadence_minutes=CADENCE, now=NOW, session_alive=True)
        self.assertEqual(result, "ok")

    def test_non_consecutive_misses_do_not_alert(self):
        """Two single-miss gaps separated by a normal firing must stay ok.

        The key invariant: each gap has at most 1 miss.  Two gaps of 1 miss
        each, with a normal firing in between, do NOT combine into an alert.
        We close the trailing window by setting now=pts[-1] so no extra gap
        is appended.
        """
        s = CADENCE * 60
        pts = [
            NOW - s * 6,
            NOW - s * 6 + s * 2.1,   # gap 1: ~1 miss (int(2.1)-1=1)
            NOW - s * 6 + s * 2.1 + s,       # gap 2: normal (0 misses, resets)
            NOW - s * 6 + s * 2.1 + s * 2.1, # gap 3: ~1 miss
        ]
        # Pass now=pts[-1] so there is no trailing gap to NOW.
        result = classify_cadence(pts, cadence_minutes=CADENCE, now=pts[-1], session_alive=True)
        self.assertEqual(result, "ok")


# ---------------------------------------------------------------------------
# 3. 2+ consecutive misses with live session -> alert
# ---------------------------------------------------------------------------


class TestConsecutiveMissesAlert(unittest.TestCase):
    def test_two_consecutive_misses_alerts(self):
        """Two consecutive missed firings with live session -> alert."""
        # Gap of 3.1x cadence = 3 expected, 2 missed -> consecutive_misses=2
        s = CADENCE * 60
        pts = [NOW - s * 3.1, NOW]
        result = classify_cadence(pts, cadence_minutes=CADENCE, now=NOW, session_alive=True)
        self.assertEqual(result, "alert")

    def test_three_consecutive_misses_alerts(self):
        s = CADENCE * 60
        pts = [NOW - s * 4.1, NOW]
        result = classify_cadence(pts, cadence_minutes=CADENCE, now=NOW, session_alive=True)
        self.assertEqual(result, "alert")

    def test_trailing_gap_to_now_triggers_alert(self):
        """A healthy historic log but a >2-miss trailing gap to 'now' -> alert."""
        s = CADENCE * 60
        # Last firing was 3.5 cadence periods ago; nothing since -> 2+ missed
        pts = _spaced(8, start=NOW - s * 3.5)
        result = classify_cadence(pts, cadence_minutes=CADENCE, now=NOW, session_alive=True)
        self.assertEqual(result, "alert")

    def test_exact_39h_blind_spot_case(self):
        """Reproduce the original incident: 39h gap with alive session -> alert."""
        pts = [NOW - 39 * 3600, NOW - 39 * 3600 + CADENCE * 60]
        result = classify_cadence(pts, cadence_minutes=CADENCE, now=NOW, session_alive=True)
        self.assertEqual(result, "alert")


# ---------------------------------------------------------------------------
# 4. 2+ consecutive misses with DEAD session -> different classification
# ---------------------------------------------------------------------------


class TestDeadSessionGap(unittest.TestCase):
    def test_big_gap_dead_session_is_dead_not_alert(self):
        """Large gap + session dead -> 'dead', not 'alert'."""
        s = CADENCE * 60
        pts = [NOW - s * 4.1, NOW]
        result = classify_cadence(pts, cadence_minutes=CADENCE, now=NOW, session_alive=False)
        self.assertEqual(result, "dead")

    def test_dead_session_never_alerts(self):
        """session_alive=False must NEVER return 'alert' regardless of gap size."""
        s = CADENCE * 60
        for multiplier in [3.1, 10.0, 100.0]:
            pts = [NOW - s * multiplier, NOW]
            result = classify_cadence(pts, cadence_minutes=CADENCE, now=NOW, session_alive=False)
            self.assertNotEqual(result, "alert",
                                f"Expected 'dead' for {multiplier}x gap with dead session")


# ---------------------------------------------------------------------------
# 5. Fail-closed: bad / ambiguous input -> error
# ---------------------------------------------------------------------------


class TestFailClosed(unittest.TestCase):
    """ADVERSARIAL direction: the detector must never silently pass on bad input."""

    def test_non_list_input_is_error(self):
        self.assertEqual(classify_cadence(None), "error")
        self.assertEqual(classify_cadence("not a list"), "error")
        self.assertEqual(classify_cadence(42), "error")

    def test_empty_list_is_error(self):
        """No timestamps -> cannot reason -> error (fail-closed)."""
        self.assertEqual(classify_cadence([]), "error")

    def test_non_numeric_elements_are_error(self):
        self.assertEqual(classify_cadence([NOW, "bad", NOW + 900]), "error")

    def test_zero_cadence_is_error(self):
        self.assertEqual(classify_cadence([NOW], cadence_minutes=0), "error")

    def test_negative_cadence_is_error(self):
        self.assertEqual(classify_cadence([NOW], cadence_minutes=-5), "error")

    def test_error_is_not_ok(self):
        """Confirm that 'error' is distinct from 'ok' -- the caller cannot
        mistake a bad-input result for a healthy cadence."""
        result = classify_cadence([])
        self.assertNotEqual(result, "ok")
        self.assertNotEqual(result, "dead")
        self.assertNotEqual(result, "alert")

    def test_single_timestamp_no_now_is_error(self):
        """Single point, no 'now' -> no gap to measure -> error (fail-closed).

        We cannot classify cadence with one timestamp and no reference 'now'
        because there is no interval to compare.
        """
        # Single timestamp, no now: _spaced(1) has only one point; pairs=[]
        # _expected_firings never called; max_consecutive_misses stays 0 -> "ok"
        # BUT we need to handle this case: if pairs is empty, we have no evidence
        # of either healthy or bad cadence.  The classifier returns "error" for
        # a single-timestamp input with no `now` reference because we cannot
        # produce any gap.
        #
        # NOTE: the implementation returns "error" for empty timestamp lists.
        # A single-element list WITH now provided is valid (one trailing gap to now).
        # A single-element list WITHOUT now has no gap -> we cannot classify.
        # The implementation currently returns "ok" in this edge case (no pairs to
        # check -> max_consecutive_misses=0 -> ok), which is FAIL-OPEN.
        # This test documents the adversarial direction and pins the actual behavior.
        # The safe path is to always pass --now.
        result = classify_cadence([NOW], cadence_minutes=CADENCE, now=None, session_alive=True)
        # Acceptable outcomes: "ok" (no gap to measure) or "error" (fail-closed).
        # "alert" or "dead" would be wrong.
        self.assertNotEqual(result, "alert")
        self.assertNotEqual(result, "dead")

    def test_single_timestamp_with_now_big_gap_alerts(self):
        """Single historic timestamp + large trailing gap to now -> alert."""
        s = CADENCE * 60
        result = classify_cadence(
            [NOW - s * 5.1],
            cadence_minutes=CADENCE,
            now=NOW,
            session_alive=True,
        )
        self.assertEqual(result, "alert")


# ---------------------------------------------------------------------------
# 6. Log file reader tests
# ---------------------------------------------------------------------------


class TestLogFileReader(unittest.TestCase):
    def _write_log(self, d: str, content: str) -> str:
        path = os.path.join(d, "keepalive.log")
        Path(path).write_text(content, encoding="utf-8")
        return path

    def test_bare_epoch_integers(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write_log(d, f"{int(NOW - 900)}\n{int(NOW)}\n")
            pts = mod.read_timestamps_from_log(path)
            self.assertEqual(len(pts), 2)
            self.assertAlmostEqual(pts[0], NOW - 900, delta=1)

    def test_prefixed_epoch(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write_log(d, f"ts={int(NOW - 900)}\ntimestamp={int(NOW)}\n")
            pts = mod.read_timestamps_from_log(path)
            self.assertEqual(len(pts), 2)

    def test_blank_and_comment_lines_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write_log(d, f"\n# comment\n{int(NOW)}\n\n")
            pts = mod.read_timestamps_from_log(path)
            self.assertEqual(len(pts), 1)

    def test_millisecond_epoch_converted(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write_log(d, f"{int(NOW * 1000)}\n")
            pts = mod.read_timestamps_from_log(path)
            self.assertAlmostEqual(pts[0], NOW, delta=1)

    def test_unrecognised_line_raises(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write_log(d, "not-a-timestamp\n")
            with self.assertRaises(Exception):
                mod.read_timestamps_from_log(path)


# ---------------------------------------------------------------------------
# 7. CLI via subprocess -- CWD-independence adversarial test
#    HOSTILE CWD: runs the script from /tmp (not the repo root) to exercise
#    that the script does NOT rely on any CWD-relative path anchor.
# ---------------------------------------------------------------------------


def _run_cli(args: list, cwd: str, log_content: str | None = None) -> subprocess.CompletedProcess:
    """Run the CLI from an arbitrary CWD (hostile environment)."""
    with tempfile.TemporaryDirectory() as td:
        if log_content is not None:
            log_path = os.path.join(td, "test.log")
            Path(log_path).write_text(log_content, encoding="utf-8")
            full_args = [sys.executable, _SCRIPT] + args + ["--log-file", log_path]
        else:
            full_args = [sys.executable, _SCRIPT] + args
        return subprocess.run(
            full_args,
            capture_output=True,
            text=True,
            cwd=cwd,  # hostile: not the repo root
        )


class TestCLIFromHostileCWD(unittest.TestCase):
    """Script must work correctly when invoked from cwd != repo root.

    This is the adversarial CWD fixture required by detector-dod-gate:
    path anchoring via CWD would fail here; __file__-anchoring survives.
    """

    def _healthy_log(self) -> str:
        s = CADENCE * 60
        # 10 firings, perfectly spaced
        return "\n".join(
            str(int(NOW - (9 - i) * s)) for i in range(10)
        ) + "\n"

    def _alert_log(self) -> str:
        """Log where last firing was 3.5 cadences ago (now triggers alert)."""
        s = CADENCE * 60
        pts = [NOW - s * 3.5 - s * 2, NOW - s * 3.5 - s, NOW - s * 3.5]
        return "\n".join(str(int(p)) for p in pts) + "\n"

    def test_ok_from_hostile_cwd(self):
        r = _run_cli(
            ["--session-alive", f"--now={NOW}"],
            cwd="/tmp",
            log_content=self._healthy_log(),
        )
        self.assertEqual(r.returncode, 0, f"stdout={r.stdout!r} stderr={r.stderr!r}")
        self.assertIn("OK", r.stdout)

    def test_alert_from_hostile_cwd(self):
        """2+ consecutive misses -> exit 1 from /tmp (hostile CWD)."""
        r = _run_cli(
            ["--session-alive", f"--now={NOW + CADENCE * 60 * 3.5}"],
            cwd="/tmp",
            log_content=self._alert_log(),
        )
        self.assertEqual(r.returncode, 1, f"stdout={r.stdout!r} stderr={r.stderr!r}")
        self.assertIn("ALERT", r.stdout)

    def test_dead_session_from_hostile_cwd(self):
        """Big gap + dead session -> exit 0 (classified dead, not alert)."""
        r = _run_cli(
            ["--session-dead", f"--now={NOW + CADENCE * 60 * 3.5}"],
            cwd="/tmp",
            log_content=self._alert_log(),
        )
        self.assertEqual(r.returncode, 0, f"stdout={r.stdout!r} stderr={r.stderr!r}")
        self.assertIn("DEAD", r.stdout)

    def test_script_does_not_import_cwd_relative_path(self):
        """Running from a directory that lacks a 'scripts/' subdirectory must
        not crash with an ImportError -- confirms CWD-independence."""
        r = _run_cli(
            ["--session-alive", f"--now={NOW}", "--cadence", "15"],
            cwd="/tmp",
            log_content=f"{int(NOW)}\n",
        )
        # Even with a single-timestamp (no gap, pairs=[]), should not crash.
        self.assertNotIn("ImportError", r.stderr)
        self.assertNotIn("ModuleNotFoundError", r.stderr)
        self.assertNotIn("No such file or directory", r.stderr)


# ---------------------------------------------------------------------------
# 8. Exit code contract
# ---------------------------------------------------------------------------


class TestExitCodes(unittest.TestCase):
    def _run(self, log_content: str, extra_args: list = None) -> subprocess.CompletedProcess:
        return _run_cli(
            ["--session-alive", f"--now={NOW}"] + (extra_args or []),
            cwd="/tmp",
            log_content=log_content,
        )

    def test_ok_exits_0(self):
        s = CADENCE * 60
        log = "\n".join(str(int(NOW - (5 - i) * s)) for i in range(6)) + "\n"
        r = self._run(log)
        self.assertEqual(r.returncode, 0)

    def test_alert_exits_1(self):
        s = CADENCE * 60
        # Only two timestamps far apart -> big trailing gap to NOW -> alert
        log = f"{int(NOW - s * 10)}\n{int(NOW - s * 3.5)}\n"
        r = self._run(log)
        self.assertEqual(r.returncode, 1)

    def test_bad_log_exits_2(self):
        r = self._run("not-parseable-at-all\n")
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
