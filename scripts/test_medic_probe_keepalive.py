#!/usr/bin/env python3
"""Tests for Medic's keep-alive / watchdog-freshness probe.

Read-only probe: keepalive_age_sec from the supervisor's freshest marker mtime,
watchdogs from pgrep liveness. Fully driven by a fake Executor -- never touches
the real system.

Run: python3 scripts/test_medic_probe_keepalive.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import probe_keepalive  # noqa: E402
from medic.types import ExecResult  # noqa: E402


NOW = 1780916754.0


class FakeExecutor:
    """Minimal Executor. `mtimes` maps path -> epoch sec (or None). `alive` is
    the set of pgrep patterns that should report a live process (rc==0). Records
    every run() argv so we can assert no shell string / no kill ever happens."""

    def __init__(self, mtimes=None, alive=(), now=NOW):
        self._mtimes = mtimes or {}
        self._alive = set(alive)
        self._now = now
        self.calls = []

    def run(self, argv, timeout=30.0):
        self.calls.append(list(argv))
        # Mirror pgrep semantics: rc 0 if a match exists, else rc 1.
        if len(argv) >= 3 and argv[0] == "pgrep" and argv[1] == "-f":
            return ExecResult(0 if argv[2] in self._alive else 1, "", "")
        return ExecResult(1, "", "")

    def read_text(self, path):
        return None

    def write_text(self, path, content, mode=0o600):
        raise AssertionError("read-only probe must never write")

    def path_mtime(self, path):
        return self._mtimes.get(path)

    def query(self, sql, params=()):
        return []

    def now(self):
        return self._now


def _marker(name):
    return probe_keepalive.STATE_DIR + "/" + name


class KeepaliveAgeTests(unittest.TestCase):
    def test_none_when_no_markers_exist(self):
        ex = FakeExecutor(mtimes={})
        self.assertIsNone(probe_keepalive.collect(ex)["keepalive_age_sec"])

    def test_age_from_single_marker(self):
        ex = FakeExecutor(mtimes={_marker("channels.launched"): NOW - 30.0})
        self.assertEqual(probe_keepalive.collect(ex)["keepalive_age_sec"], 30.0)

    def test_picks_freshest_of_several_markers(self):
        ex = FakeExecutor(mtimes={
            _marker("channels.launched"): NOW - 300.0,  # stale
            _marker("channels.next"): NOW - 12.0,       # freshest
            _marker("hibiki-push.next"): NOW - 90.0,
        })
        # Freshest mtime wins -> smallest age.
        self.assertEqual(probe_keepalive.collect(ex)["keepalive_age_sec"], 12.0)

    def test_ignores_unknown_marker_files(self):
        ex = FakeExecutor(mtimes={_marker("something-else.tmp"): NOW - 1.0})
        self.assertIsNone(probe_keepalive.collect(ex)["keepalive_age_sec"])

    def test_future_mtime_clamped_to_zero(self):
        ex = FakeExecutor(mtimes={_marker("channels.launched"): NOW + 5.0})
        self.assertEqual(probe_keepalive.collect(ex)["keepalive_age_sec"], 0.0)

    def test_large_age_for_a_dead_supervisor(self):
        ex = FakeExecutor(mtimes={_marker("channels.launched"): NOW - 3600.0})
        self.assertEqual(probe_keepalive.collect(ex)["keepalive_age_sec"], 3600.0)


class WatchdogLivenessTests(unittest.TestCase):
    def test_all_watchdogs_reported(self):
        ex = FakeExecutor()
        wd = probe_keepalive.collect(ex)["watchdogs"]
        # Every configured watchdog appears as a key.
        self.assertEqual(set(wd.keys()), set(probe_keepalive.WATCHDOGS.keys()))

    def test_dead_watchdogs_are_false(self):
        ex = FakeExecutor(alive=())  # nothing matches
        wd = probe_keepalive.collect(ex)["watchdogs"]
        self.assertTrue(all(v is False for v in wd.values()))

    def test_alive_watchdog_is_true(self):
        ex = FakeExecutor(alive={"scripts/token-outage-watch.sh"})
        wd = probe_keepalive.collect(ex)["watchdogs"]
        self.assertTrue(wd["token-outage-watch"])
        self.assertFalse(wd["telegram-pipe-watchdog"])
        self.assertFalse(wd["fleet-supervisor"])

    def test_mixed_liveness(self):
        ex = FakeExecutor(alive={
            "scripts/fleet-supervisor.sh",
            "scripts/telegram-pipe-watchdog.sh",
        })
        wd = probe_keepalive.collect(ex)["watchdogs"]
        self.assertTrue(wd["fleet-supervisor"])
        self.assertTrue(wd["telegram-pipe-watchdog"])
        self.assertFalse(wd["token-outage-watch"])


class SafetyTests(unittest.TestCase):
    """The probe is read-only and must only shell out via argv pgrep -- never a
    shell string, never a destructive verb."""

    def test_only_pgrep_argv_lists_are_run(self):
        ex = FakeExecutor()
        probe_keepalive.collect(ex)
        self.assertTrue(ex.calls)
        for argv in ex.calls:
            self.assertIsInstance(argv, list)               # argv list, not a shell string
            self.assertEqual(argv[0], "pgrep")              # only ever pgrep
            self.assertNotIn("-f ", "".join(argv))          # no embedded shell string
            for tok in argv:
                self.assertNotRegex(tok, r"[;&|`$()<>'\"\\]")  # no shell metacharacters
                self.assertNotIn("kill", tok)
                self.assertNotIn("pkill", tok)

    def test_probe_never_writes(self):
        # FakeExecutor.write_text asserts if called; collect must not trigger it.
        ex = FakeExecutor(mtimes={_marker("channels.launched"): NOW - 1.0},
                          alive={"scripts/fleet-supervisor.sh"})
        probe_keepalive.collect(ex)  # would raise if a write was attempted

    def test_return_shape_matches_contract(self):
        ex = FakeExecutor()
        out = probe_keepalive.collect(ex)
        self.assertEqual(set(out.keys()), {"keepalive_age_sec", "watchdogs"})
        self.assertIsInstance(out["watchdogs"], dict)


if __name__ == "__main__":
    unittest.main(verbosity=2)
