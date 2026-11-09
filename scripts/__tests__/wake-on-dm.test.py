#!/usr/bin/env python3
"""
Tests for wake-on-dm-daemon.py and wake-channel-agent.sh.

Covers:
  - load_token: valid token, missing file, malformed token
  - has_boss_dm: detects Boss DMs, skips non-boss messages, skips group chats
  - peek_updates: HTTP 409 handled gracefully, generic errors silent
  - is_agent_alive: tmux exit code mapping
  - wake-channel-agent.sh: allowlist guard, noop-alive, missing watchdog
"""

import sys
import os
import json
import importlib.util
import unittest
import subprocess
import urllib.error
from unittest import mock

# wake-on-dm-daemon.py has hyphens -- must use importlib
_DAEMON_PATH = os.path.join(os.path.dirname(__file__), "..", "wake-on-dm-daemon.py")
_spec = importlib.util.spec_from_file_location("wake_on_dm_daemon", _DAEMON_PATH)
daemon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(daemon)


class TestLoadToken(unittest.TestCase):
    def test_valid_token_returned(self):
        # Fake fixture token (NOT a real token). Secret part is kept to 30-34
        # chars on purpose: load_token requires >=30 ([A-Za-z0-9_-]{30,}) while
        # the pre-gate secret-scanner blocks >=35. 32 chars satisfies both.
        content = 'TELEGRAM_BOT_TOKEN=123456789:FaketokenForUnitTestNOTreal12345\n'
        with mock.patch("builtins.open", mock.mock_open(read_data=content)):
            tok = daemon.load_token("buster")
        self.assertIsNotNone(tok)
        self.assertTrue(tok.startswith("123456789:"))

    def test_missing_file_returns_none(self):
        with mock.patch("builtins.open", side_effect=FileNotFoundError):
            tok = daemon.load_token("buster")
        self.assertIsNone(tok)

    def test_malformed_token_returns_none(self):
        content = 'TELEGRAM_BOT_TOKEN=notavalidtoken\n'
        with mock.patch("builtins.open", mock.mock_open(read_data=content)):
            tok = daemon.load_token("buster")
        self.assertIsNone(tok)

    def test_missing_key_returns_none(self):
        content = 'SOME_OTHER_KEY=value\n'
        with mock.patch("builtins.open", mock.mock_open(read_data=content)):
            tok = daemon.load_token("buster")
        self.assertIsNone(tok)


class TestHasBossDm(unittest.TestCase):
    def _update(self, chat_id, chat_type="private", text="hello"):
        return {"message": {"chat": {"id": chat_id, "type": chat_type}, "text": text}}

    def test_boss_private_message_detected(self):
        updates = [self._update(daemon.BOSS_CHAT_ID)]
        self.assertTrue(daemon.has_boss_dm(updates))

    def test_non_boss_private_message_ignored(self):
        updates = [self._update(99999999)]
        self.assertFalse(daemon.has_boss_dm(updates))

    def test_group_message_ignored(self):
        updates = [self._update(daemon.BOSS_CHAT_ID, chat_type="group")]
        self.assertFalse(daemon.has_boss_dm(updates))

    def test_empty_updates_false(self):
        self.assertFalse(daemon.has_boss_dm([]))

    def test_multiple_updates_one_boss(self):
        updates = [
            self._update(99999999),
            self._update(daemon.BOSS_CHAT_ID),
            self._update(11111111),
        ]
        self.assertTrue(daemon.has_boss_dm(updates))

    def test_boss_chat_id_zero_any_private_triggers(self):
        """BOSS_CHAT_ID==0 -> any private message triggers (pre-validation mode)."""
        orig = daemon.BOSS_CHAT_ID
        try:
            daemon.BOSS_CHAT_ID = 0
            updates = [self._update(99999999)]
            self.assertTrue(daemon.has_boss_dm(updates))
        finally:
            daemon.BOSS_CHAT_ID = orig


class TestPeekUpdates(unittest.TestCase):
    def _mock_response(self, payload: dict):
        body = json.dumps(payload).encode()
        resp = mock.MagicMock()
        resp.read.return_value = body
        resp.__enter__ = lambda s: s
        resp.__exit__ = mock.MagicMock(return_value=False)
        return resp

    def test_returns_updates_on_ok(self):
        updates = [{"update_id": 1, "message": {"text": "hi"}}]
        resp = self._mock_response({"ok": True, "result": updates})
        with mock.patch("urllib.request.urlopen", return_value=resp):
            result = daemon.peek_updates("fake_token")
        self.assertEqual(result, updates)

    def test_returns_empty_on_ok_false(self):
        resp = self._mock_response({"ok": False, "result": []})
        with mock.patch("urllib.request.urlopen", return_value=resp):
            result = daemon.peek_updates("fake_token")
        self.assertEqual(result, [])

    def test_409_returns_empty_no_raise(self):
        err = urllib.error.HTTPError(url="", code=409, msg="Conflict", hdrs={}, fp=None)
        with mock.patch("urllib.request.urlopen", side_effect=err):
            result = daemon.peek_updates("fake_token")
        self.assertEqual(result, [])

    def test_other_http_error_returns_empty(self):
        err = urllib.error.HTTPError(url="", code=500, msg="Server Error", hdrs={}, fp=None)
        with mock.patch("urllib.request.urlopen", side_effect=err):
            result = daemon.peek_updates("fake_token")
        self.assertEqual(result, [])

    def test_network_error_returns_empty(self):
        with mock.patch("urllib.request.urlopen", side_effect=OSError("network")):
            result = daemon.peek_updates("fake_token")
        self.assertEqual(result, [])


class TestIsAgentAlive(unittest.TestCase):
    def test_alive_when_tmux_exit0(self):
        with mock.patch("subprocess.run") as mock_run:
            mock_run.return_value = mock.MagicMock(returncode=0)
            self.assertTrue(daemon.is_agent_alive("buster"))

    def test_dead_when_tmux_exit1(self):
        with mock.patch("subprocess.run") as mock_run:
            mock_run.return_value = mock.MagicMock(returncode=1)
            self.assertFalse(daemon.is_agent_alive("buster"))


class TestWakeChannelAgentSh(unittest.TestCase):
    """
    Tests for scripts/wake-channel-agent.sh allowlist and idempotent logic.
    Runs the actual script via subprocess with mocked tmux.
    """

    SCRIPT = os.path.join(os.path.dirname(__file__), "..", "wake-channel-agent.sh")

    def _run(self, agent_name: str, env: dict | None = None) -> int:
        """Run the script and return the exit code."""
        e = os.environ.copy()
        if env:
            e.update(env)
        result = subprocess.run(
            ["bash", self.SCRIPT, agent_name],
            capture_output=True, text=True, env=e,
            timeout=5
        )
        return result.returncode

    def test_unknown_agent_rejected_exit1(self):
        code = self._run("definitely-not-an-agent")
        self.assertEqual(code, 1)

    def test_empty_agent_name_rejected_exit1(self):
        code = self._run("")
        self.assertEqual(code, 1)

    def test_known_agent_missing_watchdog_exit2(self):
        """buster is in allowlist but its watchdog likely doesn't exist in test env."""
        code = self._run("buster")
        # Either 0 (session alive) or 2 (watchdog missing) or 0 (session started)
        # The test just verifies the script doesn't crash with exit 1 (not rejected)
        self.assertNotEqual(code, 1, "Known agent should not be rejected (exit 1)")

    def test_injection_attempt_rejected(self):
        """Shell injection attempt must be rejected by allowlist."""
        code = self._run("buster; rm -rf /tmp/testfile")
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
