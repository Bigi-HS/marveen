#!/usr/bin/env python3
"""Unit tests for scripts/memory-retrieval-eval.py (card 570030c9, J1).

Network-free tests for the SWAPPABLE query-generation layer -- the only part the
paraphrase mode adds on top of the shared metric/reporting logic. The eval talks
to the dashboard API and (in paraphrase mode) to a local Ollama daemon over HTTP,
but every decision-making helper here is pure or dependency-injected so the logic
is tested without a live server or model.

The module is loaded by path (its filename is hyphenated, so a plain `import`
does not work) and it must import WITHOUT a live store present -- the dashboard
token is read lazily at use-time, exercised by test_import_is_side_effect_free.

Run: python3 scripts/__tests__/memory-retrieval-eval.test.py

Covers:
  - parse_cli: positional sample_N + --paraphrase/-p opt-in (default unchanged)
  - _clean_paraphrase: <think>-strip, quote/punct trim, meta-echo + over-long drop
  - _assert_loopback: SSRF guard rejects non-loopback OLLAMA_URL
  - ollama_available: graceful False on daemon down / model absent (injected opener)
  - paraphrase_query: graceful '' on transport failure (never crashes the run)
  - make_query: baseline lexical-anchor is untouched (regression signal intact)
"""
import importlib.util
import io
import json
import os
import sys
import unittest
import urllib.error

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULE_PATH = os.path.join(_HERE, "..", "memory-retrieval-eval.py")
_spec = importlib.util.spec_from_file_location("memory_retrieval_eval", _MODULE_PATH)
mre = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mre)  # must not read the token / hit the network


class ImportTests(unittest.TestCase):
    def test_import_is_side_effect_free(self):
        # DB_PATH resolves to a path string (fail-open), token stays unread.
        self.assertTrue(mre.DB_PATH.endswith(".db"))
        self.assertTrue(callable(mre._token))


class ParseCliTests(unittest.TestCase):
    def test_default_is_lexical_anchor(self):
        self.assertEqual(mre.parse_cli([]), (40, False))

    def test_positional_sample_preserved(self):
        self.assertEqual(mre.parse_cli(["12"]), (12, False))

    def test_paraphrase_long_flag(self):
        self.assertEqual(mre.parse_cli(["5", "--paraphrase"]), (5, True))

    def test_paraphrase_short_flag(self):
        self.assertEqual(mre.parse_cli(["-p", "8"]), (8, True))

    def test_explicit_lexical_overrides(self):
        self.assertEqual(mre.parse_cli(["--paraphrase", "--lexical", "3"]), (3, False))


class CleanParaphraseTests(unittest.TestCase):
    def test_strips_think_and_punct(self):
        out = mre._clean_paraphrase("<think>reasoning...</think>\nmissing backup alert disk full.")
        self.assertEqual(out, "missing backup alert disk full")

    def test_takes_last_nonempty_line(self):
        # a chatty model puts the actual answer last
        self.assertEqual(mre._clean_paraphrase("Sure!\n\novernight save ran out of space"),
                         "overnight save ran out of space")

    def test_strips_wrapping_quotes(self):
        self.assertEqual(mre._clean_paraphrase('"telegram hiba beszelgetes"'),
                         "telegram hiba beszelgetes")

    def test_meta_echo_rejected(self):
        # model echoing the instruction instead of producing a query -> unusable
        self.assertEqual(
            mre._clean_paraphrase("a natural phrase that does not use the note's terms verbatim"),
            "")

    def test_over_long_rejected(self):
        long = " ".join(f"w{i}" for i in range(20))
        self.assertEqual(mre._clean_paraphrase(long), "")

    def test_empty_input(self):
        self.assertEqual(mre._clean_paraphrase(""), "")
        self.assertEqual(mre._clean_paraphrase(None), "")


class LoopbackGuardTests(unittest.TestCase):
    def test_loopback_urls_allowed(self):
        for u in ("http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"):
            mre._assert_loopback(u)  # must not raise

    def test_remote_url_rejected(self):
        with self.assertRaises(RuntimeError):
            mre._assert_loopback("http://evil.example.com:11434")


def _fake_opener(payload=None, exc=None):
    """Build an injectable opener returning a JSON body, or raising `exc`."""
    def opener(req, timeout=None):
        if exc is not None:
            raise exc
        body = json.dumps(payload).encode("utf-8")

        class _Resp(io.BytesIO):
            def __enter__(self_):
                return self_

            def __exit__(self_, *a):
                return False
        return _Resp(body)
    return opener


class OllamaAvailableTests(unittest.TestCase):
    def test_true_when_model_served(self):
        op = _fake_opener({"models": [{"name": "qwen3:4b"}]})
        self.assertTrue(mre.ollama_available(opener=op))

    def test_family_match(self):
        op = _fake_opener({"models": [{"name": "qwen3:4b-instruct-q4_k_m"}]})
        self.assertTrue(mre.ollama_available(opener=op))

    def test_false_when_model_absent(self):
        op = _fake_opener({"models": [{"name": "llama3:8b"}]})
        self.assertFalse(mre.ollama_available(opener=op))

    def test_false_on_daemon_down(self):
        op = _fake_opener(exc=urllib.error.URLError("connection refused"))
        self.assertFalse(mre.ollama_available(opener=op))

    def test_ssrf_guard_still_fires(self):
        with self.assertRaises(RuntimeError):
            mre.ollama_available(base_url="http://evil.example.com:11434")


class ParaphraseQueryTests(unittest.TestCase):
    def _row(self, content):
        return {"id": 1, "agent_id": "marveen", "content": content, "keywords": ""}

    def test_empty_content_returns_empty(self):
        self.assertEqual(mre.paraphrase_query(self._row(""), opener=_fake_opener({})), "")

    def test_transport_failure_degrades_to_empty(self):
        op = _fake_opener(exc=urllib.error.URLError("boom"))
        self.assertEqual(mre.paraphrase_query(self._row("some note"), opener=op), "")

    def test_successful_paraphrase_cleaned(self):
        op = _fake_opener({"message": {"content": "  overnight save out of space  "}})
        self.assertEqual(mre.paraphrase_query(self._row("nightly backup failed, disk full"), opener=op),
                         "overnight save out of space")


class MakeQueryBaselineTests(unittest.TestCase):
    def test_keywords_path_unchanged(self):
        row = {"content": "x", "keywords": "telegram, channel, plugin, ENOENT, restart"}
        self.assertEqual(mre.make_query(row), "telegram channel plugin ENOENT restart")

    def test_content_fallback(self):
        row = {"content": "Buster kameleon canary sandbox agent", "keywords": ""}
        self.assertTrue(mre.make_query(row))


if __name__ == "__main__":
    unittest.main(verbosity=2)
