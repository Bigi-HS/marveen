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


class TestParkedAgentSkip(unittest.TestCase):
    """card 041c7dac: parked agents (watchdog chmod -x) must be skipped."""

    def _make_env(self, d: str):
        store = os.path.join(d, "store")
        scripts = os.path.join(d, "scripts")
        os.makedirs(store)
        os.makedirs(scripts)
        state = os.path.join(d, "state.json")
        tok = os.path.join(d, "token")
        Path(tok).write_text("fake-token")
        return store, scripts, state, tok

    def test_parked_agent_not_stale_alerted(self):
        """Stale gauge for parked agent (watchdog chmod -x) -> skip, no alert."""
        with tempfile.TemporaryDirectory() as d:
            store, scripts, state, tok = self._make_env(d)
            # Create stale state for bigben
            write_state(store, "bigben", consecutive_dead=3,
                        last_healthy_ms=NOW_MS - STALE_MS - 1_000)
            # Mark bigben watchdog as parked (not executable)
            wd = os.path.join(scripts, "bigben-watchdog.sh")
            Path(wd).write_text("#!/bin/bash\n")
            os.chmod(wd, 0o644)  # not executable

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("parked", r.stdout)
            self.assertNotIn("DRY-RUN would alert", r.stdout)
            self.assertNotIn("STALE", r.stdout)

    def test_executable_watchdog_not_skipped(self):
        """Stale gauge with executable watchdog -> still reported STALE."""
        with tempfile.TemporaryDirectory() as d:
            store, scripts, state, tok = self._make_env(d)
            write_state(store, "bigben", consecutive_dead=3,
                        last_healthy_ms=NOW_MS - STALE_MS - 1_000)
            # Watchdog IS executable
            wd = os.path.join(scripts, "bigben-watchdog.sh")
            Path(wd).write_text("#!/bin/bash\n")
            os.chmod(wd, 0o755)

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertIn("bigben", r.stdout)

    def test_no_watchdog_script_not_skipped(self):
        """Agent with no dedicated watchdog script (generic path) -> not parked."""
        with tempfile.TemporaryDirectory() as d:
            store, scripts, state, tok = self._make_env(d)
            write_state(store, "gauge", consecutive_dead=2)
            # No gauge-watchdog.sh in scripts/ -> not parked

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertIn("gauge", r.stdout)

    def test_healthy_parked_agent_silent(self):
        """Healthy gauge + parked -> still silent (no spurious ok line noise)."""
        with tempfile.TemporaryDirectory() as d:
            store, scripts, state, tok = self._make_env(d)
            write_state(store, "bigben")  # fresh/healthy
            wd = os.path.join(scripts, "bigben-watchdog.sh")
            Path(wd).write_text("#!/bin/bash\n")
            os.chmod(wd, 0o644)  # parked

            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("parked", r.stdout)
            self.assertNotIn("DRY-RUN would alert", r.stdout)


def write_fake_probe(d: str) -> str:
    """A fake per-agent-pipe-probe CLI: argv = [mode, agent].
    mode in {healthy,dead,inconclusive} -> prints verdict=<mode>, exit 0.
    mode == error -> exit 1 (probe failure).
    mode == timeout -> sleeps long (drives the caller's probe timeout).
    """
    path = os.path.join(d, "fake_probe.py")
    Path(path).write_text(
        "import sys, time\n"
        "mode = sys.argv[1] if len(sys.argv) > 1 else 'healthy'\n"
        "if mode == 'error':\n"
        "    sys.stderr.write('boom\\n'); sys.exit(1)\n"
        "if mode == 'timeout':\n"
        "    time.sleep(30)\n"
        "print('verdict=' + mode)\n"
    )
    return path


class TestLiveReprobe(unittest.TestCase):
    """card acd7fa13: an AGE-ONLY stale gauge (consecutiveDead<2, aged
    lastHealthyTs) is re-probed live; alerted only if the probe confirms dead.
    consecutiveDead>=2 bypasses (already live-confirmed). Probe error/timeout
    fails OPEN. Every suppression is logged (no silent suppression)."""

    def _env(self, d: str):
        store = os.path.join(d, "store")
        os.makedirs(store)
        state = os.path.join(d, "state.json")
        tok = os.path.join(d, "token")
        Path(tok).write_text("fake-token")
        return store, state, tok

    def _probe_cmd(self, d: str, mode: str) -> str:
        fake = write_fake_probe(d)
        return f"{sys.executable} {fake} {mode}"

    def test_age_stale_probe_healthy_suppressed(self):
        """The repro: age-only STALE but a live probe says healthy -> NOT alerted."""
        with tempfile.TemporaryDirectory() as d:
            store, state, tok = self._env(d)
            write_state(store, "bond", consecutive_dead=0,
                        last_healthy_ms=NOW_MS - STALE_MS - 1_000)
            r = run(store, state, tok,
                    ["--dry-run", "--probe-command", self._probe_cmd(d, "healthy")])
            self.assertEqual(r.returncode, 0)
            self.assertIn("false-STALE SUPPRESSED", r.stdout)  # logged, not silent
            self.assertNotIn("DRY-RUN would alert", r.stdout)

    def test_age_stale_probe_dead_alerts(self):
        """Age-only STALE and the live probe confirms dead -> alert."""
        with tempfile.TemporaryDirectory() as d:
            store, state, tok = self._env(d)
            write_state(store, "bond", consecutive_dead=0,
                        last_healthy_ms=NOW_MS - STALE_MS - 1_000)
            r = run(store, state, tok,
                    ["--dry-run", "--probe-command", self._probe_cmd(d, "dead")])
            self.assertEqual(r.returncode, 0)
            self.assertIn("re-probe=dead -> confirmed", r.stdout)
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertIn("bond", r.stdout)

    def test_age_stale_probe_inconclusive_suppressed(self):
        """A clean 'inconclusive' verdict is not a confirmed outage -> suppress + log."""
        with tempfile.TemporaryDirectory() as d:
            store, state, tok = self._env(d)
            write_state(store, "bond", consecutive_dead=0,
                        last_healthy_ms=NOW_MS - STALE_MS - 1_000)
            r = run(store, state, tok,
                    ["--dry-run", "--probe-command", self._probe_cmd(d, "inconclusive")])
            self.assertEqual(r.returncode, 0)
            self.assertIn("false-STALE SUPPRESSED", r.stdout)
            self.assertNotIn("DRY-RUN would alert", r.stdout)

    def test_sustained_dead_bypasses_probe(self):
        """consecutiveDead>=2 must alert WITHOUT calling the probe (bypass)."""
        with tempfile.TemporaryDirectory() as d:
            store, state, tok = self._env(d)
            write_state(store, "scout", consecutive_dead=2)
            # probe set to 'healthy': if it were consulted, scout would be suppressed.
            r = run(store, state, tok,
                    ["--dry-run", "--probe-command", self._probe_cmd(d, "healthy")])
            self.assertEqual(r.returncode, 0)
            self.assertIn("probe bypassed", r.stdout)
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertIn("scout", r.stdout)

    def test_probe_error_fails_open(self):
        """Probe failure (non-zero exit) must FAIL OPEN -> still alert."""
        with tempfile.TemporaryDirectory() as d:
            store, state, tok = self._env(d)
            write_state(store, "bond", consecutive_dead=0,
                        last_healthy_ms=NOW_MS - STALE_MS - 1_000)
            r = run(store, state, tok,
                    ["--dry-run", "--probe-command", self._probe_cmd(d, "error")])
            self.assertEqual(r.returncode, 0)
            self.assertIn("FAIL-OPEN", r.stdout)
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertIn("probe-inconclusive", r.stdout)

    def test_probe_timeout_fails_open(self):
        """Probe timeout must FAIL OPEN -> still alert."""
        with tempfile.TemporaryDirectory() as d:
            store, state, tok = self._env(d)
            write_state(store, "bond", consecutive_dead=0,
                        last_healthy_ms=NOW_MS - STALE_MS - 1_000)
            r = run(store, state, tok,
                    ["--dry-run", "--probe-timeout", "1",
                     "--probe-command", self._probe_cmd(d, "timeout")])
            self.assertEqual(r.returncode, 0)
            self.assertIn("FAIL-OPEN", r.stdout)
            self.assertIn("DRY-RUN would alert", r.stdout)

    def test_dry_run_default_skips_probe(self):
        """Without an explicit --probe-command, dry-run must NOT shell out
        (n8n dry path stays side-effect-free) -> legacy keep-and-report."""
        with tempfile.TemporaryDirectory() as d:
            store, state, tok = self._env(d)
            write_state(store, "bond", consecutive_dead=0,
                        last_healthy_ms=NOW_MS - STALE_MS - 1_000)
            r = run(store, state, tok, ["--dry-run"])
            self.assertEqual(r.returncode, 0)
            self.assertIn("would re-probe (skipped: dry-run default)", r.stdout)
            self.assertIn("DRY-RUN would alert", r.stdout)

    def test_no_probe_flag_keeps_legacy_behavior(self):
        """--no-probe disables the re-probe entirely (safe escape) -> alert as before."""
        with tempfile.TemporaryDirectory() as d:
            store, state, tok = self._env(d)
            write_state(store, "bond", consecutive_dead=0,
                        last_healthy_ms=NOW_MS - STALE_MS - 1_000)
            r = run(store, state, tok,
                    ["--dry-run", "--no-probe",
                     "--probe-command", self._probe_cmd(d, "healthy")])
            self.assertEqual(r.returncode, 0)
            # --no-probe wins even with a healthy probe available: legacy alert stands.
            self.assertIn("DRY-RUN would alert", r.stdout)
            self.assertNotIn("false-STALE SUPPRESSED", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
