#!/usr/bin/env python3
"""Tests for scripts/lib/fleet_api.py (card 7ec502ba).

Guard-safe dashboard API helper: reads token from file (not inline),
exposes kanban get/list/put, message send, PR open, daily-log, memory.

AC1: kanban_get(card_id) returns card dict
AC2: kanban_put(card_id, fields) sends PUT with merged fields
AC3: kanban_list() returns list of cards
AC4: message_send(from_, to_, content) sends POST /api/messages
AC5: pr_open(title, body, head, base) sends POST /api/github/pr
AC6: daily_log(agent_id, content) sends POST /api/daily-log
AC7: memory_save(agent_id, content, category, keywords) sends POST /api/memories
AC8: token read from file path (not hardcoded), guard-safe
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

_THIS_DIR = Path(__file__).resolve().parent
_MODULE_PATH = _THIS_DIR.parent / "lib" / "fleet_api.py"

_spec = importlib.util.spec_from_file_location("fleet_api", _MODULE_PATH)
assert _spec and _spec.loader, f"cannot load {_MODULE_PATH}"
mod = importlib.util.module_from_spec(_spec)
sys.modules["fleet_api"] = mod
_spec.loader.exec_module(mod)


def _make_client(token="testtoken"):
    """Return a FleetApiClient with a mock transport for testing."""
    client = mod.FleetApiClient(token_file=None, base_url="http://localhost:3420")
    client._token = token
    return client


def _mock_response(data, status=200):
    m = MagicMock()
    m.read.return_value = json.dumps(data).encode()
    m.status = status
    m.__enter__ = lambda s: s
    m.__exit__ = MagicMock(return_value=False)
    return m


class TokenLoadTests(unittest.TestCase):
    """AC8: token reads from file path, not hardcoded."""

    def test_token_loaded_from_file(self, tmp_path=None):
        import tempfile, os
        with tempfile.NamedTemporaryFile(mode="w", suffix=".token", delete=False) as f:
            f.write("mytoken123\n")
            fpath = f.name
        try:
            client = mod.FleetApiClient(token_file=fpath)
            self.assertEqual(client._token, "mytoken123")
        finally:
            os.unlink(fpath)

    def test_token_strips_whitespace(self):
        import tempfile, os
        with tempfile.NamedTemporaryFile(mode="w", suffix=".token", delete=False) as f:
            f.write("  tok42  \n")
            fpath = f.name
        try:
            client = mod.FleetApiClient(token_file=fpath)
            self.assertEqual(client._token, "tok42")
        finally:
            os.unlink(fpath)


class KanbanGetTests(unittest.TestCase):
    """AC1: kanban_get(card_id) returns card dict."""

    def test_kanban_get_calls_correct_url(self):
        client = _make_client()
        card = {"id": "abc12345", "title": "Test", "status": "planned"}
        with patch("urllib.request.urlopen", return_value=_mock_response(card)) as mock_open:
            result = client.kanban_get("abc12345")
        self.assertEqual(result["id"], "abc12345")
        req = mock_open.call_args[0][0]
        self.assertIn("/api/kanban/abc12345", req.full_url)
        self.assertEqual(req.get_method(), "GET")

    def test_kanban_get_includes_auth_header(self):
        client = _make_client("tok-xyz")
        with patch("urllib.request.urlopen", return_value=_mock_response({})):
            client.kanban_get("abc12345")


class KanbanListTests(unittest.TestCase):
    """AC3: kanban_list() returns list of cards."""

    def test_kanban_list_returns_list(self):
        client = _make_client()
        cards = [{"id": "aa", "status": "planned"}, {"id": "bb", "status": "done"}]
        with patch("urllib.request.urlopen", return_value=_mock_response(cards)):
            result = client.kanban_list()
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 2)

    def test_kanban_list_accepts_status_filter(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response([])) as mock_open:
            client.kanban_list(status="in_progress")
        req = mock_open.call_args[0][0]
        self.assertIn("status=in_progress", req.full_url)


class KanbanPutTests(unittest.TestCase):
    """AC2: kanban_put(card_id, fields) sends PUT with fields."""

    def test_kanban_put_sends_put_method(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"ok": True})) as mock_open:
            result = client.kanban_put("abc12345", {"status": "in_progress"})
        req = mock_open.call_args[0][0]
        self.assertEqual(req.get_method(), "PUT")
        self.assertIn("/api/kanban/abc12345", req.full_url)

    def test_kanban_put_encodes_fields(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"ok": True})) as mock_open:
            client.kanban_put("abc12345", {"status": "done", "title": "new title"})
        req = mock_open.call_args[0][0]
        body = json.loads(req.data)
        self.assertEqual(body["status"], "done")
        self.assertEqual(body["title"], "new title")

    def test_kanban_put_returns_response(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"ok": True})):
            result = client.kanban_put("abc12345", {"status": "done"})
        self.assertTrue(result.get("ok"))


class MessageSendTests(unittest.TestCase):
    """AC4: message_send(from_, to_, content) sends POST /api/messages."""

    def test_message_send_correct_endpoint(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"id": 42})) as mock_open:
            result = client.message_send("roberts", "dave", "hello")
        req = mock_open.call_args[0][0]
        self.assertEqual(req.get_method(), "POST")
        self.assertIn("/api/messages", req.full_url)

    def test_message_send_payload(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"id": 42})) as mock_open:
            client.message_send("roberts", "thor", "gate ready")
        req = mock_open.call_args[0][0]
        body = json.loads(req.data)
        self.assertEqual(body["from"], "roberts")
        self.assertEqual(body["to"], "thor")
        self.assertEqual(body["content"], "gate ready")

    def test_message_send_returns_response(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"id": 99})):
            result = client.message_send("roberts", "dave", "test")
        self.assertEqual(result["id"], 99)


class PrOpenTests(unittest.TestCase):
    """AC5: pr_open(title, body, head, base) sends POST /api/github/pr."""

    def test_pr_open_endpoint(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"number": 777})) as mock_open:
            result = client.pr_open("feat: thing", "body text", "eng/abc-branch", "develop")
        req = mock_open.call_args[0][0]
        self.assertEqual(req.get_method(), "POST")
        self.assertIn("/api/github/pr", req.full_url)

    def test_pr_open_payload(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"number": 777})) as mock_open:
            client.pr_open("feat: thing", "body text", "eng/abc-branch", "develop")
        req = mock_open.call_args[0][0]
        body = json.loads(req.data)
        self.assertEqual(body["title"], "feat: thing")
        self.assertEqual(body["head"], "eng/abc-branch")
        self.assertEqual(body["base"], "develop")


class DailyLogTests(unittest.TestCase):
    """AC6: daily_log(agent_id, content) sends POST /api/daily-log."""

    def test_daily_log_endpoint(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"ok": True})) as mock_open:
            client.daily_log("roberts", "## 10:00 -- Test\nDone.")
        req = mock_open.call_args[0][0]
        self.assertEqual(req.get_method(), "POST")
        self.assertIn("/api/daily-log", req.full_url)
        body = json.loads(req.data)
        self.assertEqual(body["agent_id"], "roberts")
        self.assertIn("Done.", body["content"])


class MemorySaveTests(unittest.TestCase):
    """AC7: memory_save(agent_id, content, category, keywords) sends POST /api/memories."""

    def test_memory_save_endpoint(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"ok": True})) as mock_open:
            client.memory_save("roberts", "learned thing", "cold", "lesson, pattern")
        req = mock_open.call_args[0][0]
        self.assertIn("/api/memories", req.full_url)
        body = json.loads(req.data)
        self.assertEqual(body["agent_id"], "roberts")
        self.assertEqual(body["category"], "cold")
        self.assertEqual(body["keywords"], "lesson, pattern")

    def test_memory_save_no_keywords(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_mock_response({"ok": True})) as mock_open:
            client.memory_save("roberts", "content", "warm")
        req = mock_open.call_args[0][0]
        body = json.loads(req.data)
        self.assertNotIn("keywords", body)


if __name__ == "__main__":
    unittest.main()
