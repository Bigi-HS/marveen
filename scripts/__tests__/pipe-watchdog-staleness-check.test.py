#!/usr/bin/env python3
"""Tests for scripts/pipe-watchdog-staleness-check.py (card cd2bd7b9).

Hermetic: no real HTTP calls, no real store/ reads. All inputs injected via
--store (tmpdir), --state (tmpdir), --token-file (tmpdir), --now-ms, --dry-run.

Run: python3 scripts/__tests__/pipe-watchdog-staleness-check.test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(REPO, "scripts", "pipe-watchdog-staleness-check.py")

NOW_MS = 1_000_000_000_000  # arbitrary fixed epoch for determinism
NOW_S = NOW_MS // 1000
STALE_MINUTES = 90
STALE_MS = STALE_MINUTES * 60 * 1000
CHECKED_WINDOW_MS = 2 * 60 * 60 * 1000  # 2h


def run(store_dir: str, state_file: str, token_file: str,
        extra: list[str] | None = None) -> subprocess.CompletedProcess:
    cmd = [
        sys.executable, SCRIPT,
        "--store", store_dir,
        "--state", state_file,
        "--token-file", token_file,
        "--now-ms", str(NOW_MS),
        "--stale-minutes", str(STALE_MINUTES),
    ] + (extra or [])
    return subprocess.run(cmd, capture_output=True, text=True)


def write_state(store_dir: str, agent: str, consecutive_dead: int = 0,
                last_healthy_ms: int | None = None,
                last_checked_ms: int | None = None) -> None:
    if last_healthy_ms is None:
        last_healthy_ms = NOW_MS - 1_000  # 1s ago = fresh
    if last_checked_ms is None:
        last_checked_ms = NOW_MS - 1_000  # recently checked
    name = ("telegram-pipe-watchdog.state.json" if agent == "telegram"
            else f"pipe-watchdog.{agent}.state.json")
    path = Path(store_dir) / name
    path.write_text(json.dumps({
        "consecutiveDead": consecutive_dead,
        "lastHealthyTs": last_healthy_ms,
        "lastCheckedTs": last_checked_ms,
    }))


class TestAllHealthy(unittest.TestCase):
    def test_silent_when_all_ok(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            write_state(store, "forge", consecutive_dead=0)
            write_state(store, "hibiki", consecutive_dead=0)
            write_state(store, "telegram", consecutive_dead=0)

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("healthy", r.stdout)
            self.assertNotIn("STALE", r.stdout)
            self.assertNotIn("DRY-RUN would alert", r.stdout)


class TestConsecutiveDeadThreshold(unittest.TestCase):
    def test_consecutive_dead_1_is_silent(self):
        """Single dead probe (transient) must NOT alert."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            write_state(store, "forge", consecutive_dead=1)

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertNotIn("DRY-RUN would alert", r.stdout)

    def test_consecutive_dead_2_alerts(self):
        """Two consecutive dead probes = sustained drop -> alert."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            write_state(store, "forge", consecutive_dead=2)

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertIn("forge", r.stdout)

    def test_consecutive_dead_5_alerts(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            write_state(store, "hibiki", consecutive_dead=5)

            r = run(store, state, tok, ["--dry-run"])
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertIn("hibiki", r.stdout)


class TestAgeThreshold(unittest.TestCase):
    def test_age_over_threshold_alerts(self):
        """lastHealthyTs older than stale_threshold -> alert."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            stale_last_healthy = NOW_MS - STALE_MS - 1_000  # just over threshold
            write_state(store, "bond", consecutive_dead=0,
                        last_healthy_ms=stale_last_healthy)

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertIn("bond", r.stdout)

    def test_age_under_threshold_silent(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            fresh_last_healthy = NOW_MS - STALE_MS + 60_000  # 1min under threshold
            write_state(store, "bond", consecutive_dead=0,
                        last_healthy_ms=fresh_last_healthy)

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertNotIn("DRY-RUN would alert", r.stdout)


class TestWatchdogStaleSkip(unittest.TestCase):
    def test_watchdog_itself_stale_skips_agent(self):
        """If lastCheckedTs is older than 2h, the watchdog is stale -> skip."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            old_checked = NOW_MS - CHECKED_WINDOW_MS - 1_000  # watchdog hasn't run in >2h
            stale_last_healthy = NOW_MS - STALE_MS - 60_000   # would normally alert
            write_state(store, "scout", consecutive_dead=3,
                        last_healthy_ms=stale_last_healthy,
                        last_checked_ms=old_checked)

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("skip", r.stdout)
            self.assertNotIn("DRY-RUN would alert", r.stdout)


class TestSuppressionWindow(unittest.TestCase):
    def test_suppressed_within_23h(self):
        """If alert was sent recently (<23h), do not re-alert."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            # Write suppression state: dave was alerted 1h ago
            suppress = {"dave": NOW_S - 3600}
            Path(state).write_text(json.dumps(suppress))

            # dave is stale (consecutive_dead=2)
            write_state(store, "dave", consecutive_dead=2)

            r = run(store, state, tok)  # NOT dry-run, so suppression state is read
            self.assertEqual(r.returncode, 0)
            self.assertIn("suppressed", r.stdout)
            self.assertNotIn("Alert sent", r.stdout)

    def test_alert_after_23h_window_expires(self):
        """Alert fires again once 23h suppression window has passed."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            # dave was alerted 25h ago (outside 23h window)
            suppress = {"dave": NOW_S - 25 * 3600}
            Path(state).write_text(json.dumps(suppress))

            write_state(store, "dave", consecutive_dead=2)

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertIn("dave", r.stdout)


class TestDryRun(unittest.TestCase):
    def test_dry_run_no_state_write(self):
        """--dry-run must not write the suppression state file."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            write_state(store, "thor", consecutive_dead=2)

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("DRY-RUN", r.stdout)
            self.assertFalse(Path(state).exists(),
                             "state file must NOT be written in dry-run mode")

    def test_dry_run_no_http_call(self):
        """--dry-run must not attempt any HTTP call (no token needed at all)."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "nonexistent-token")  # file does not exist

            write_state(store, "thor", consecutive_dead=2)

            # If dry-run tried to read the token file, it would fail
            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("DRY-RUN", r.stdout)


class TestTelegramAgent(unittest.TestCase):
    def test_telegram_agent_name_resolved(self):
        """telegram-pipe-watchdog.state.json must resolve to agent name 'telegram'."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "store")
            os.makedirs(store)
            state = os.path.join(d, "state.json")
            tok = os.path.join(d, "token")
            Path(tok).write_text("fake-token")

            write_state(store, "telegram", consecutive_dead=2)

            r = run(store, state, tok, ["--dry-run"])
            self.assertIn("telegram", r.stdout)
            self.assertIn("DRY-RUN would alert", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
