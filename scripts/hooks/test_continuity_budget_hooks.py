#!/usr/bin/env python3
"""Tests for the cross-source continuity-budget _claim_budget() helper as
wired into checkpoint-replay.py, ledger-replay.py, and memory-replay.py
(memory-continuity Phase 1, S3 hardening -- card 7126a3df).

Verifies:
  - _claim_budget returns True (allowed) when the endpoint responds allowed=true
  - _claim_budget returns False when the endpoint responds allowed=false
  - _claim_budget returns True (fail-open) when the endpoint raises an exception

We use a mock HTTP server so the test does NOT require a live dashboard.
Run: python3 scripts/hooks/test_continuity_budget_hooks.py
"""
import importlib.util
import json
import os
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    # Patch imports that would fail in this test context.
    sys.modules.setdefault("ledger_lib", type(sys)("ledger_lib"))
    sys.modules.setdefault("memory_rank", type(sys)("memory_rank"))
    spec.loader.exec_module(mod)
    return mod


checkpoint_mod = _load(os.path.join(_HERE, "checkpoint-replay.py"), "checkpoint_replay")
ledger_mod = _load(os.path.join(_HERE, "ledger-replay.py"), "ledger_replay")
memory_mod = _load(os.path.join(_HERE, "memory-replay.py"), "memory_replay")


class _MockHandler(BaseHTTPRequestHandler):
    """Minimal HTTP server that returns a canned JSON response."""
    allowed = True

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        body = json.dumps({"allowed": self.allowed, "remaining": 1000, "budget": 8000})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *_):  # suppress request logging
        pass


class _MockServer:
    def __init__(self, allowed=True):
        self._allowed = allowed
        self._server = None
        self._thread = None
        self.port = None

    def __enter__(self):
        handler = type("H", (_MockHandler,), {"allowed": self._allowed})
        self._server = HTTPServer(("127.0.0.1", 0), handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.handle_request, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_):
        try:
            self._server.server_close()
        except Exception:
            pass


def _patch_api(mod, port):
    """Point mod's API constant at our mock server."""
    mod.API = "http://127.0.0.1:%d/api" % port


class CheckpointClaimBudgetTest(unittest.TestCase):
    def test_allowed_true_when_server_says_allowed(self):
        with _MockServer(allowed=True) as srv:
            _patch_api(checkpoint_mod, srv.port)
            result = checkpoint_mod._claim_budget("test-agent", 500, "tok")
        self.assertTrue(result)

    def test_allowed_false_when_server_says_not_allowed(self):
        with _MockServer(allowed=False) as srv:
            _patch_api(checkpoint_mod, srv.port)
            result = checkpoint_mod._claim_budget("test-agent", 500, "tok")
        self.assertFalse(result)

    def test_fail_open_on_connection_error(self):
        # Port 1 is never listening -- connection refused.
        checkpoint_mod.API = "http://127.0.0.1:1/api"
        result = checkpoint_mod._claim_budget("test-agent", 500, "tok")
        self.assertTrue(result)  # fail-open

    def test_fail_open_with_no_token(self):
        # Empty token -> returns True immediately (fail-open, no request made).
        result = checkpoint_mod._claim_budget("test-agent", 500, "")
        self.assertTrue(result)


class LedgerClaimBudgetTest(unittest.TestCase):
    def test_allowed_true_when_server_says_allowed(self):
        with _MockServer(allowed=True) as srv:
            # ledger_mod._token is called inside; monkey-patch it to return a fake token.
            orig = ledger_mod._token
            ledger_mod._token = lambda: "tok"
            try:
                orig_api = ledger_mod.API
                ledger_mod.API = "http://127.0.0.1:%d/api" % srv.port
                result = ledger_mod._claim_budget("test-agent", 500)
            finally:
                ledger_mod._token = orig
                ledger_mod.API = orig_api
        self.assertTrue(result)

    def test_allowed_false_when_server_says_not_allowed(self):
        with _MockServer(allowed=False) as srv:
            orig = ledger_mod._token
            ledger_mod._token = lambda: "tok"
            try:
                orig_api = ledger_mod.API
                ledger_mod.API = "http://127.0.0.1:%d/api" % srv.port
                result = ledger_mod._claim_budget("test-agent", 500)
            finally:
                ledger_mod._token = orig
                ledger_mod.API = orig_api
        self.assertFalse(result)

    def test_fail_open_with_no_token(self):
        orig = ledger_mod._token
        ledger_mod._token = lambda: ""
        try:
            result = ledger_mod._claim_budget("test-agent", 500)
        finally:
            ledger_mod._token = orig
        self.assertTrue(result)  # fail-open: no token -> proceed


class MemoryClaimBudgetTest(unittest.TestCase):
    def test_allowed_true_when_server_says_allowed(self):
        with _MockServer(allowed=True) as srv:
            orig = memory_mod._token
            memory_mod._token = lambda: "tok"
            try:
                orig_api = memory_mod.API
                memory_mod.API = "http://127.0.0.1:%d/api" % srv.port
                result = memory_mod._claim_budget("test-agent", 500)
            finally:
                memory_mod._token = orig
                memory_mod.API = orig_api
        self.assertTrue(result)

    def test_allowed_false_when_server_says_not_allowed(self):
        with _MockServer(allowed=False) as srv:
            orig = memory_mod._token
            memory_mod._token = lambda: "tok"
            try:
                orig_api = memory_mod.API
                memory_mod.API = "http://127.0.0.1:%d/api" % srv.port
                result = memory_mod._claim_budget("test-agent", 500)
            finally:
                memory_mod._token = orig
                memory_mod.API = orig_api
        self.assertFalse(result)

    def test_fail_open_with_no_token(self):
        orig = memory_mod._token
        memory_mod._token = lambda: ""
        try:
            result = memory_mod._claim_budget("test-agent", 500)
        finally:
            memory_mod._token = orig
        self.assertTrue(result)  # fail-open


if __name__ == "__main__":
    unittest.main(verbosity=2)
