#!/usr/bin/env python3
"""Unit tests for scripts/forge-health-check.py.

Pure: no real network, no real tmux, no disk I/O. Each probe function is
tested in isolation via mocking. Run:
  python3 -m pytest scripts/test_forge_health_check.py
  python3 scripts/test_forge_health_check.py
"""
import importlib.util
import os
import sys
import unittest
from unittest.mock import MagicMock, mock_open, patch

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, "forge-health-check.py")
_spec = importlib.util.spec_from_file_location("forge_health_check", _MOD_PATH)
fhc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fhc)


# ── F1: server ────────────────────────────────────────────────────────────────

class TestF1Server(unittest.TestCase):
    def _mock_resp(self, status=200, body=b'[{"name":"forge"}]'):
        r = MagicMock()
        r.status = status
        r.read.return_value = body
        return r

    def test_pass_200_valid_json(self):
        with patch("urllib.request.urlopen", return_value=self._mock_resp()):
            ok, detail = fhc.check_f1_server("tok")
        self.assertTrue(ok)
        self.assertEqual(detail, "ok")

    def test_fail_connection_refused(self):
        with patch("urllib.request.urlopen", side_effect=Exception("Connection refused")):
            ok, detail = fhc.check_f1_server("tok")
        self.assertFalse(ok)
        self.assertIn("Connection refused", detail)

    def test_fail_non_200(self):
        with patch("urllib.request.urlopen", return_value=self._mock_resp(status=503)):
            ok, detail = fhc.check_f1_server("tok")
        self.assertFalse(ok)
        self.assertIn("503", detail)

    def test_fail_invalid_json(self):
        with patch("urllib.request.urlopen", return_value=self._mock_resp(body=b"not-json")):
            ok, detail = fhc.check_f1_server("tok")
        self.assertFalse(ok)


# ── F2: sessions + watchdogs ──────────────────────────────────────────────────

class TestF2Sessions(unittest.TestCase):
    def _run(self, tmux_rc, pgrep_rc):
        side = [MagicMock(returncode=tmux_rc), MagicMock(returncode=pgrep_rc)]
        with patch("subprocess.run", side_effect=side):
            return fhc.check_f2_sessions()

    def test_pass_both_alive(self):
        ok, _ = self._run(0, 0)
        self.assertTrue(ok)

    def test_fail_session_missing(self):
        ok, detail = self._run(1, 0)
        self.assertFalse(ok)
        self.assertIn("session", detail.lower())

    def test_fail_watchdog_not_running(self):
        ok, detail = self._run(0, 1)
        self.assertFalse(ok)
        self.assertIn("watchdog", detail.lower())

    def test_fail_both_down(self):
        ok, _ = self._run(1, 1)
        self.assertFalse(ok)


# ── F3: channel state ─────────────────────────────────────────────────────────

class TestF3Channel(unittest.TestCase):
    def _agents(self, state):
        return [{"name": "forge", "channel_state": state}]

    def test_pass_enabled(self):
        ok, detail = fhc.check_f3_channel("tok", self._agents("enabled"))
        self.assertTrue(ok)
        self.assertIn("enabled", detail)

    def test_pass_disabled(self):
        ok, detail = fhc.check_f3_channel("tok", self._agents("disabled"))
        self.assertTrue(ok)
        self.assertIn("disabled", detail)

    def test_fail_configured_but_disabled(self):
        ok, detail = fhc.check_f3_channel("tok", self._agents("configured_but_disabled"))
        self.assertFalse(ok)
        self.assertIn("configured_but_disabled", detail)

    def test_fail_unknown_state(self):
        ok, _ = fhc.check_f3_channel("tok", self._agents("broken_state"))
        self.assertFalse(ok)

    def test_fail_agent_not_found(self):
        ok, detail = fhc.check_f3_channel("tok", [{"name": "other", "channel_state": "enabled"}])
        self.assertFalse(ok)
        self.assertIn("not found", detail)

    def test_fail_empty_agents_list(self):
        ok, detail = fhc.check_f3_channel("tok", [])
        self.assertFalse(ok)
        self.assertIn("not found", detail)


# ── F4: token vault ───────────────────────────────────────────────────────────

class TestF4Token(unittest.TestCase):
    def test_pass_non_empty(self):
        with patch("builtins.open", mock_open(read_data="sometoken\n")):
            ok, detail = fhc.check_f4_token()
        self.assertTrue(ok)

    def test_fail_file_missing(self):
        with patch("builtins.open", side_effect=OSError("No such file")):
            ok, detail = fhc.check_f4_token()
        self.assertFalse(ok)
        self.assertIn("No such file", detail)

    def test_fail_empty_string(self):
        with patch("builtins.open", mock_open(read_data="   ")):
            ok, detail = fhc.check_f4_token()
        self.assertFalse(ok)
        self.assertIn("empty", detail)

    def test_fail_newline_only(self):
        with patch("builtins.open", mock_open(read_data="\n")):
            ok, detail = fhc.check_f4_token()
        self.assertFalse(ok)


# ── send_alert ────────────────────────────────────────────────────────────────

class TestSendAlert(unittest.TestCase):
    def test_calls_both_endpoints(self):
        mock_resp = MagicMock()
        with patch("urllib.request.urlopen", return_value=mock_resp) as mu:
            fhc.send_alert("tok", [(1, "server down"), (3, "bad channel state")])
        self.assertEqual(mu.call_count, 2)

    def test_message_contains_failed_checks(self):
        captured = []

        def fake_urlopen(req, timeout=None):
            captured.append(req.data.decode())
            return MagicMock()

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            fhc.send_alert("tok", [(2, "session missing")])

        self.assertTrue(any("F2" in d for d in captured))
        self.assertTrue(any("session missing" in d for d in captured))

    def test_graceful_on_network_failure(self):
        with patch("urllib.request.urlopen", side_effect=Exception("network error")):
            fhc.send_alert("tok", [(4, "token missing")])


# ── read_token ────────────────────────────────────────────────────────────────

class TestReadToken(unittest.TestCase):
    def test_returns_token(self):
        with patch("builtins.open", mock_open(read_data="mytoken\n")):
            self.assertEqual(fhc.read_token(), "mytoken")

    def test_returns_none_on_oserror(self):
        with patch("builtins.open", side_effect=OSError):
            self.assertIsNone(fhc.read_token())

    def test_returns_none_on_empty(self):
        with patch("builtins.open", mock_open(read_data="   ")):
            self.assertIsNone(fhc.read_token())


if __name__ == "__main__":
    unittest.main()
