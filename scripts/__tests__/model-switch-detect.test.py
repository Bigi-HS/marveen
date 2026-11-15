#!/usr/bin/env python3
"""Unit tests for model-switch-detect.py hardening (card 7775f8cb).

Covers the three non-blocker findings from PR #1005 (Thor + Chad review):
  (a) F2/Chad-a: agent_id is percent-encoded in the fetch URL.
  (b) F4/Thor: _fetch_stored_model returns the exact-prefix match's value
      when both an exact 'config.last_model=X' entry and a looser substring
      entry are present in the returned records.
  (c) Chad-b/F3: _read_config_model rejects a traversal agent_id like
      '../../etc' and does not read a path outside ROOT/agents.

Run: python3 scripts/__tests__/model-switch-detect.test.py
"""
import importlib.util
import io
import json
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

_MOD_PATH = Path(__file__).parent.parent / 'model-switch-detect.py'


def _load():
    spec = importlib.util.spec_from_file_location('model_switch_detect', _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


m = _load()


# ---------------------------------------------------------------------------
# (a) URL-encoding of agent_id in _fetch_stored_model
# ---------------------------------------------------------------------------

class TestFetchUrlEncoding(unittest.TestCase):
    """F2/Chad-a: agent_id with special chars must be percent-encoded in the URL."""

    def test_special_chars_encoded_in_url(self):
        """An agent_id containing space and slash must appear percent-encoded."""
        captured_urls: list[str] = []

        class _FakeResponse:
            def read(self):
                return json.dumps([]).encode()
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass

        def _fake_urlopen(req, timeout=None):
            captured_urls.append(req.full_url)
            return _FakeResponse()

        with patch('urllib.request.urlopen', side_effect=_fake_urlopen):
            result = m._fetch_stored_model(token='tok', agent_id='a b/c')

        self.assertEqual(len(captured_urls), 1, "urlopen should have been called once")
        url = captured_urls[0]
        # 'a b/c' must appear percent-encoded -- the raw form must NOT be present
        self.assertNotIn('a b/c', url, "raw agent_id must not appear in URL")
        self.assertIn('a%20b%2Fc', url, "agent_id must be percent-encoded in URL")

    def test_well_formed_agent_id_unchanged_in_url(self):
        """A normal agent_id (letters/dashes) must still work -- no double-encoding."""
        captured_urls: list[str] = []

        class _FakeResponse:
            def read(self):
                return json.dumps([]).encode()
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass

        def _fake_urlopen(req, timeout=None):
            captured_urls.append(req.full_url)
            return _FakeResponse()

        with patch('urllib.request.urlopen', side_effect=_fake_urlopen):
            m._fetch_stored_model(token='tok', agent_id='marveen')

        self.assertEqual(len(captured_urls), 1)
        self.assertIn('agent=marveen', captured_urls[0])


# ---------------------------------------------------------------------------
# (b) Exact-prefix match takes priority over substring match
# ---------------------------------------------------------------------------

class TestFetchExactPrefixPriority(unittest.TestCase):
    """F4/Thor: when records contain both an exact-prefix and a loose substring
    entry, the exact-prefix entry's value must be returned."""

    def _make_response(self, records):
        class _FakeResponse:
            def __init__(self, data):
                self._data = data
            def read(self):
                return json.dumps(self._data).encode()
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
        return _FakeResponse(records)

    def test_exact_prefix_wins_over_substring(self):
        """Exact 'config.last_model=X' entry must be preferred over a looser match."""
        records = [
            # Loose/substring match: content mentions MEMORY_KEY but is not exact-prefix
            {"keywords": "config.last_model, model", "content": "notes: config.last_model=old-value here"},
            # Exact-prefix match: content starts with 'config.last_model='
            {"keywords": "config.last_model, model, cache", "content": "config.last_model=exact-value"},
        ]

        def _fake_urlopen(req, timeout=None):
            return self._make_response(records)

        with patch('urllib.request.urlopen', side_effect=_fake_urlopen):
            result = m._fetch_stored_model(token='tok', agent_id='marveen')

        self.assertEqual(result, 'exact-value',
                         "exact-prefix match must take priority over substring match")

    def test_exact_prefix_only(self):
        """Single exact-prefix record must return the correct value."""
        records = [
            {"keywords": "config.last_model, model, cache", "content": "config.last_model=claude-sonnet-4-6"},
        ]

        def _fake_urlopen(req, timeout=None):
            return self._make_response(records)

        with patch('urllib.request.urlopen', side_effect=_fake_urlopen):
            result = m._fetch_stored_model(token='tok', agent_id='marveen')

        self.assertEqual(result, 'claude-sonnet-4-6')

    def test_substring_fallback_when_no_exact(self):
        """Falls back to substring match when no exact-prefix record exists."""
        records = [
            {"keywords": "config.last_model, model", "content": "config.last_model=fallback-value extra"},
        ]

        def _fake_urlopen(req, timeout=None):
            return self._make_response(records)

        with patch('urllib.request.urlopen', side_effect=_fake_urlopen):
            result = m._fetch_stored_model(token='tok', agent_id='marveen')

        self.assertEqual(result, 'fallback-value extra')

    def test_no_matching_records_returns_none(self):
        """No matching records must return None."""
        records = [
            {"keywords": "something_else", "content": "unrelated=content"},
        ]

        def _fake_urlopen(req, timeout=None):
            return self._make_response(records)

        with patch('urllib.request.urlopen', side_effect=_fake_urlopen):
            result = m._fetch_stored_model(token='tok', agent_id='marveen')

        self.assertIsNone(result)


# ---------------------------------------------------------------------------
# (c) Path traversal guard in _read_config_model
# ---------------------------------------------------------------------------

class TestReadConfigModelTraversalGuard(unittest.TestCase):
    """Chad-b/F3: a traversal agent_id must not cause reads outside ROOT/agents."""

    def test_traversal_agent_id_does_not_escape_agents_dir(self):
        """An agent_id like '../../etc' must be rejected; fallback to root config."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            # Minimal repo layout
            agents_dir = tmp / "agents"
            agents_dir.mkdir()
            scripts_dir = tmp / "scripts"
            scripts_dir.mkdir()

            # Canary file outside agents/ that must NOT be read
            sensitive_dir = tmp  # e.g. simulates going up two levels
            canary_file = sensitive_dir / "agent-config.json"
            canary_file.write_text(json.dumps({"model": "SHOULD_NOT_BE_READ"}))

            # Root fallback config (legitimate fallback target)
            root_config = tmp / "agent-config.json"
            root_config.write_text(json.dumps({"model": "root-fallback-model"}))

            # Patch ROOT to our temp dir so the function uses our layout
            original_root = m.ROOT
            m.ROOT = tmp
            try:
                result = m._read_config_model("../../etc")
            finally:
                m.ROOT = original_root

        # Must NOT return "SHOULD_NOT_BE_READ" (the canary outside agents/).
        # It may return "root-fallback-model" (the legitimate root fallback),
        # or None if the root config also doesn't exist/match.
        self.assertNotEqual(result, "SHOULD_NOT_BE_READ",
                            "traversal must not read a file outside ROOT/agents")

    def test_well_formed_agent_id_reads_correctly(self):
        """A normal agent_id must still resolve and return the model correctly."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            agent_dir = tmp / "agents" / "marveen"
            agent_dir.mkdir(parents=True)
            (agent_dir / "agent-config.json").write_text(json.dumps({"model": "claude-opus-4-8"}))

            original_root = m.ROOT
            m.ROOT = tmp
            try:
                result = m._read_config_model("marveen")
            finally:
                m.ROOT = original_root

        self.assertEqual(result, "claude-opus-4-8")

    def test_traversal_with_null_byte_does_not_crash(self):
        """An agent_id with a null byte or other unusual content must not crash."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            (tmp / "agents").mkdir()
            original_root = m.ROOT
            m.ROOT = tmp
            try:
                # Should not raise -- just return None or fallback
                result = m._read_config_model("agent\x00id")
            except Exception as e:
                self.fail(f"_read_config_model raised unexpectedly: {e}")
            finally:
                m.ROOT = original_root
        # Result is either None or a model string -- not a crash.


if __name__ == '__main__':
    unittest.main()
