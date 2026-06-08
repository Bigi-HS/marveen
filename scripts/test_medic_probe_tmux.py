#!/usr/bin/env python3
"""Tests for Medic's tmux-liveness probe (read-only, executor-injected).

Run: python3 scripts/test_medic_probe_tmux.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import probe_tmux  # noqa: E402
from medic.dispatch import AGENTS  # noqa: E402
from medic.types import ExecResult  # noqa: E402


class FakeExecutor:
    """Minimal Executor that returns a canned `tmux ls` result and records the
    argv it was asked to run. Never touches the real system."""

    def __init__(self, code=0, out="", err=""):
        self._result = ExecResult(code, out, err)
        self.calls = []

    def run(self, argv, timeout=30.0):
        self.calls.append(list(argv))
        return self._result

    def read_text(self, path):
        return None

    def write_text(self, path, content, mode=0o600):
        raise AssertionError("read-only probe must never write")

    def path_mtime(self, path):
        return None

    def query(self, sql, params=()):
        return []

    def now(self):
        return 1780916754.0


def _full_tmux_ls() -> str:
    """A realistic `tmux ls` body with every expected session alive."""
    lines = [f"agent-{a}: 1 windows (created ...)" for a in AGENTS]
    lines.append("marveen: 2 windows (created ...) (attached)")
    lines.append("marveen-channels: 1 windows (created ...)")
    return "\n".join(lines) + "\n"


class ContractTests(unittest.TestCase):
    def test_returns_sessions_dict_only(self):
        ex = FakeExecutor(0, _full_tmux_ls())
        out = probe_tmux.collect(ex)
        self.assertIsInstance(out, dict)
        self.assertEqual(set(out.keys()), {"sessions"})
        self.assertIsInstance(out["sessions"], dict)

    def test_uses_argv_not_shell(self):
        ex = FakeExecutor(0, _full_tmux_ls())
        probe_tmux.collect(ex)
        self.assertEqual(len(ex.calls), 1)
        argv = ex.calls[0]
        self.assertIsInstance(argv, list)
        self.assertEqual(argv[0], "tmux")
        # No shell string ever -- argv is a list of bare tokens.
        for tok in argv:
            self.assertNotIn(";", tok)
            self.assertNotIn("|", tok)
            self.assertNotIn("&", tok)

    def test_expected_keys_are_complete(self):
        ex = FakeExecutor(0, _full_tmux_ls())
        sessions = probe_tmux.collect(ex)["sessions"]
        # 14 agents + 2 orchestrator sessions.
        self.assertEqual(len(sessions), len(AGENTS) + 2)
        for a in AGENTS:
            self.assertIn(f"agent-{a}", sessions)
        self.assertIn("marveen", sessions)
        self.assertIn("marveen-channels", sessions)


class LivenessTests(unittest.TestCase):
    def test_all_alive(self):
        ex = FakeExecutor(0, _full_tmux_ls())
        sessions = probe_tmux.collect(ex)["sessions"]
        self.assertTrue(all(sessions.values()))

    def test_missing_session_is_false(self):
        # Drop agent-dave and marveen-channels from the listing.
        body = "\n".join(
            line for line in _full_tmux_ls().splitlines()
            if not line.startswith("agent-dave:")
            and not line.startswith("marveen-channels:")
        )
        ex = FakeExecutor(0, body)
        sessions = probe_tmux.collect(ex)["sessions"]
        self.assertFalse(sessions["agent-dave"])
        self.assertFalse(sessions["marveen-channels"])
        self.assertTrue(sessions["agent-thor"])
        self.assertTrue(sessions["marveen"])

    def test_no_server_all_dead(self):
        # `tmux ls` with no server exits non-zero with an error on stderr.
        ex = FakeExecutor(1, "", "no server running on /tmp/tmux-1000/default")
        sessions = probe_tmux.collect(ex)["sessions"]
        self.assertEqual(len(sessions), len(AGENTS) + 2)
        self.assertFalse(any(sessions.values()))

    def test_empty_output_all_dead(self):
        ex = FakeExecutor(0, "")
        sessions = probe_tmux.collect(ex)["sessions"]
        self.assertFalse(any(sessions.values()))

    def test_unexpected_sessions_are_ignored(self):
        # A stray session that is not in the expected set must not appear.
        body = _full_tmux_ls() + "some-other-session: 1 windows\n"
        ex = FakeExecutor(0, body)
        sessions = probe_tmux.collect(ex)["sessions"]
        self.assertNotIn("some-other-session", sessions)
        self.assertEqual(len(sessions), len(AGENTS) + 2)

    def test_marveen_channels_not_confused_with_marveen(self):
        # Only "marveen-channels" present, bare "marveen" absent.
        body = "\n".join(
            line for line in _full_tmux_ls().splitlines()
            if not line.startswith("marveen:")
        )
        ex = FakeExecutor(0, body)
        sessions = probe_tmux.collect(ex)["sessions"]
        self.assertFalse(sessions["marveen"])
        self.assertTrue(sessions["marveen-channels"])


class ReadOnlyTests(unittest.TestCase):
    def test_only_lists_never_mutates(self):
        ex = FakeExecutor(0, _full_tmux_ls())
        probe_tmux.collect(ex)
        for argv in ex.calls:
            # tmux verbs that mutate state must never appear.
            for verb in ("kill-session", "kill-server", "new-session",
                         "new", "send-keys", "respawn-pane", "respawn-window"):
                self.assertNotIn(verb, argv)


if __name__ == "__main__":
    unittest.main(verbosity=2)
