#!/usr/bin/env python3
"""Unit tests for scripts/hooks/tool-log-relay.py _post() egress guard (SEC/8293dd11).

The hook reads DASHBOARD_URL from env and POSTs bearer token + payload to that URL.
If DASHBOARD_URL is compromised the token and payload are exfiltrated. The guard
ensures _post() silently returns when the resolved base is not a loopback origin.

Allowlist: http://127.0.0.1, http://localhost, http://[::1]  (literal prefix match).
"""
import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

_HOOKS_DIR = Path(__file__).resolve().parent / "hooks"
_MODULE_PATH = _HOOKS_DIR / "tool-log-relay.py"

_spec = importlib.util.spec_from_file_location("tool_log_relay", _MODULE_PATH)
assert _spec and _spec.loader, f"cannot load module at {_MODULE_PATH}"
relay = importlib.util.module_from_spec(_spec)
sys.modules["tool_log_relay"] = relay
_spec.loader.exec_module(relay)

VALID_PAYLOAD = {"session_id": "s1", "tool_name": "Bash", "success": True}


class EgressGuardTests(unittest.TestCase):
    """_post() must not call urlopen when DASHBOARD_URL is not a loopback origin."""

    def _call_post(self, dashboard_url: str) -> bool:
        """Run _post(VALID_PAYLOAD) with DASHBOARD_URL set; return True if urlopen was called."""
        env = {"DASHBOARD_URL": dashboard_url}
        with patch.dict(os.environ, env, clear=False):
            with patch("urllib.request.urlopen") as mock_open:
                with patch.object(relay, "_read_token", return_value="test-token"):
                    relay._post(VALID_PAYLOAD)
                    return mock_open.called

    # --- Red: non-loopback must NOT call urlopen ---

    def test_rejects_http_evil_example(self):
        called = self._call_post("http://evil.example")
        self.assertFalse(called, "urlopen must NOT be called for http://evil.example")

    def test_rejects_https_localhost_lookalike(self):
        called = self._call_post("http://localhost.evil.com")
        self.assertFalse(called, "urlopen must NOT be called for a localhost-lookalike domain")

    def test_rejects_routable_ip(self):
        called = self._call_post("http://10.0.0.1:3420")
        self.assertFalse(called, "urlopen must NOT be called for a routable IP")

    # --- Pin: loopback origins must be allowed ---

    def test_allows_127_0_0_1(self):
        called = self._call_post("http://127.0.0.1:3420")
        self.assertTrue(called, "urlopen MUST be called for http://127.0.0.1:3420")

    def test_allows_localhost(self):
        called = self._call_post("http://localhost:3420")
        self.assertTrue(called, "urlopen MUST be called for http://localhost:3420")

    def test_allows_ipv6_loopback(self):
        called = self._call_post("http://[::1]:3420")
        self.assertTrue(called, "urlopen MUST be called for http://[::1]:3420")

    def test_allows_default_url(self):
        """When DASHBOARD_URL is absent the default http://localhost:3420 must be allowed."""
        env_without = {k: v for k, v in os.environ.items() if k != "DASHBOARD_URL"}
        with patch.dict(os.environ, env_without, clear=True):
            with patch("urllib.request.urlopen") as mock_open:
                with patch.object(relay, "_read_token", return_value="test-token"):
                    relay._post(VALID_PAYLOAD)
                    self.assertTrue(mock_open.called, "default URL must be allowed")


if __name__ == "__main__":
    unittest.main()
