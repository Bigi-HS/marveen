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
            ok, detail, _ = fhc.check_f1_server("tok")
        self.assertTrue(ok)
        self.assertEqual(detail, "ok")

    def test_fail_connection_refused(self):
        with patch("urllib.request.urlopen", side_effect=Exception("Connection refused")):
            ok, detail, _ = fhc.check_f1_server("tok")
        self.assertFalse(ok)
        self.assertIn("Connection refused", detail)

    def test_fail_non_200(self):
        with patch("urllib.request.urlopen", return_value=self._mock_resp(status=503)):
            ok, detail, _ = fhc.check_f1_server("tok")
        self.assertFalse(ok)
        self.assertIn("503", detail)

    def test_fail_invalid_json(self):
        with patch("urllib.request.urlopen", return_value=self._mock_resp(body=b"not-json")):
            ok, detail, _ = fhc.check_f1_server("tok")
        self.assertFalse(ok)

    def test_retry_succeeds_on_second_attempt(self):
        """Transient failure on first attempt; second attempt OK -> pass."""
        ok_resp = self._mock_resp()
        with patch("urllib.request.urlopen", side_effect=[Exception("timeout"), ok_resp]):
            with patch("time.sleep") as mock_sleep:
                ok, detail, _ = fhc.check_f1_server("tok")
        self.assertTrue(ok)
        mock_sleep.assert_called_once_with(2)

    def test_retry_fails_on_both_attempts(self):
        """Both attempts fail -> fail with detail from second attempt."""
        with patch("urllib.request.urlopen", side_effect=[Exception("first"), Exception("second")]):
            with patch("time.sleep"):
                ok, detail, _ = fhc.check_f1_server("tok")
        self.assertFalse(ok)
        self.assertIn("second", detail)

    def test_no_retry_on_success(self):
        """Successful first attempt: urlopen called exactly once, no sleep."""
        with patch("urllib.request.urlopen", return_value=self._mock_resp()) as mu:
            with patch("time.sleep") as mock_sleep:
                ok, _, __ = fhc.check_f1_server("tok")
        self.assertTrue(ok)
        self.assertEqual(mu.call_count, 1)
        mock_sleep.assert_not_called()

    def test_retry_detail_contains_retry_label(self):
        """Successful retry includes 'retry' in detail string."""
        ok_resp = self._mock_resp()
        with patch("urllib.request.urlopen", side_effect=[Exception("blip"), ok_resp]):
            with patch("time.sleep"):
                ok, detail, _ = fhc.check_f1_server("tok")
        self.assertTrue(ok)
        self.assertIn("retry", detail)

    def test_returns_agents_on_success(self):
        """check_f1_server returns parsed agents list as third element on success."""
        body = b'[{"name":"forge","channelHealthy":true}]'
        with patch("urllib.request.urlopen", return_value=self._mock_resp(body=body)):
            ok, detail, agents = fhc.check_f1_server("tok")
        self.assertTrue(ok)
        self.assertEqual(len(agents), 1)
        self.assertEqual(agents[0]["name"], "forge")

    def test_returns_empty_agents_on_failure(self):
        """check_f1_server returns empty agents list when both attempts fail."""
        with patch("urllib.request.urlopen", side_effect=[Exception("t1"), Exception("t2")]):
            with patch("time.sleep"):
                ok, detail, agents = fhc.check_f1_server("tok")
        self.assertFalse(ok)
        self.assertEqual(agents, [])

    def test_returns_agents_from_retry(self):
        """Successful retry returns agents parsed from the retry response."""
        body = b'[{"name":"forge","channelHealthy":true}]'
        ok_resp = self._mock_resp(body=body)
        with patch("urllib.request.urlopen", side_effect=[Exception("blip"), ok_resp]):
            with patch("time.sleep"):
                ok, detail, agents = fhc.check_f1_server("tok")
        self.assertTrue(ok)
        self.assertEqual(agents[0]["name"], "forge")


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


# ── F3: channel healthy ───────────────────────────────────────────────────────

class TestF3Channel(unittest.TestCase):
    def _agents(self, channel_healthy):
        return [{"name": "forge", "channelHealthy": channel_healthy}]

    def test_pass_channel_healthy_true(self):
        ok, detail = fhc.check_f3_channel("tok", self._agents(True))
        self.assertTrue(ok)
        self.assertIn("channelHealthy=True", detail)

    def test_fail_channel_healthy_false(self):
        ok, detail = fhc.check_f3_channel("tok", self._agents(False))
        self.assertFalse(ok)
        self.assertIn("channelHealthy=False", detail)

    def test_fail_missing_field(self):
        ok, detail = fhc.check_f3_channel("tok", [{"name": "forge"}])
        self.assertFalse(ok)
        self.assertIn("channelHealthy", detail)

    def test_fail_agent_not_found(self):
        ok, detail = fhc.check_f3_channel("tok", [{"name": "other", "channelHealthy": True}])
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


# ── main(): F3 skip when F1 fails + no second agents fetch ───────────────────

class TestMainF3Behavior(unittest.TestCase):
    """Integration tests for main() F3 skip-when-F1-fails and single-fetch behavior."""

    def _mock_f1_ok_resp(self, agents_body=b'[{"name":"forge","channelHealthy":true}]'):
        r = MagicMock()
        r.status = 200
        r.read.return_value = agents_body
        return r

    def test_f3_skipped_when_f1_fails(self):
        """When F1 fails, F3 is not reported RED (no double-alert for server-down)."""
        with patch("urllib.request.urlopen", side_effect=Exception("connection refused")):
            with patch("time.sleep"):
                with patch.object(fhc, "check_f2_sessions", return_value=(True, "ok")):
                    with patch.object(fhc, "check_f4_token", return_value=(True, "ok")):
                        with patch.object(fhc, "read_token", return_value="tok"):
                            with patch.object(fhc, "send_alert") as mock_alert:
                                try:
                                    fhc.main()
                                except SystemExit:
                                    pass
        if mock_alert.called:
            failed_checks = mock_alert.call_args[0][1]
            check_nums = [n for n, _ in failed_checks]
            self.assertNotIn(3, check_nums, "F3 should not fire when F1 is down")
            self.assertIn(1, check_nums)

    def test_f3_fires_when_channel_unhealthy(self):
        """When F1 ok but channelHealthy=False, F3 is RED."""
        body = b'[{"name":"forge","channelHealthy":false}]'
        ok_resp = self._mock_f1_ok_resp(body)
        with patch("urllib.request.urlopen", return_value=ok_resp):
            with patch.object(fhc, "check_f2_sessions", return_value=(True, "ok")):
                with patch.object(fhc, "check_f4_token", return_value=(True, "ok")):
                    with patch.object(fhc, "read_token", return_value="tok"):
                        with patch.object(fhc, "send_alert") as mock_alert:
                            try:
                                fhc.main()
                            except SystemExit:
                                pass
        self.assertTrue(mock_alert.called)
        failed_checks = mock_alert.call_args[0][1]
        check_nums = [n for n, _ in failed_checks]
        self.assertIn(3, check_nums)

    def test_main_only_one_agents_http_call(self):
        """main() makes exactly one /api/agents HTTP call (F1 reused for F3)."""
        ok_resp = self._mock_f1_ok_resp()
        with patch("urllib.request.urlopen", return_value=ok_resp) as mu:
            with patch.object(fhc, "check_f2_sessions", return_value=(True, "ok")):
                with patch.object(fhc, "check_f4_token", return_value=(True, "ok")):
                    with patch.object(fhc, "read_token", return_value="tok"):
                        try:
                            fhc.main()
                        except SystemExit:
                            pass
        self.assertEqual(mu.call_count, 1, "Only one /api/agents call expected (F1 result reused)")


if __name__ == "__main__":
    unittest.main()
