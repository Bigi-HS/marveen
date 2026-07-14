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
  - parse_cli: positional sample_N + --paraphrase/-p opt-in + --json/--threshold
  - _clean_paraphrase: <think>-strip, quote/punct trim, meta-echo + over-long drop
  - _META_RE (PR#389 nit): whole-word meta filtering ('terminal' kept, 'term' dropped)
  - _assert_loopback: SSRF guard rejects non-loopback OLLAMA_URL
  - ollama_available: graceful False on daemon down / model absent (injected opener)
  - paraphrase_query: graceful '' on transport failure (never crashes the run)
  - make_query: baseline lexical-anchor is untouched (regression signal intact)
  - build_summary: regression-gate shape + hybrid recall@1 pass-criteria + exit gate
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
    # parse_cli now returns (sample, paraphrase, as_json, threshold).
    def test_default_is_lexical_anchor(self):
        self.assertEqual(mre.parse_cli([]), (40, False, False, mre.DEFAULT_THRESHOLD))

    def test_positional_sample_preserved(self):
        self.assertEqual(mre.parse_cli(["12"]), (12, False, False, mre.DEFAULT_THRESHOLD))

    def test_paraphrase_long_flag(self):
        self.assertEqual(mre.parse_cli(["5", "--paraphrase"]),
                         (5, True, False, mre.DEFAULT_THRESHOLD))

    def test_paraphrase_short_flag(self):
        self.assertEqual(mre.parse_cli(["-p", "8"]),
                         (8, True, False, mre.DEFAULT_THRESHOLD))

    def test_explicit_lexical_overrides(self):
        self.assertEqual(mre.parse_cli(["--paraphrase", "--lexical", "3"]),
                         (3, False, False, mre.DEFAULT_THRESHOLD))

    def test_json_flag(self):
        self.assertEqual(mre.parse_cli(["12", "--json"]),
                         (12, False, True, mre.DEFAULT_THRESHOLD))

    def test_threshold_space_form(self):
        self.assertEqual(mre.parse_cli(["--threshold", "0.5"]),
                         (40, False, False, 0.5))

    def test_threshold_equals_form(self):
        self.assertEqual(mre.parse_cli(["--threshold=1.01", "12", "--json"]),
                         (12, False, True, 1.01))


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

    # --- PR#389 nit 1: whole-word meta-token matching (no substring over-drop) ---
    def test_query_word_containing_metatoken_is_kept(self):
        # 'terminal' CONTAINS 'term' -- a substring test wrongly dropped it. A
        # legitimate query must survive whole-word filtering.
        self.assertEqual(mre._clean_paraphrase("terminal pane detector crash"),
                         "terminal pane detector crash")

    def test_determine_containing_term_is_kept(self):
        self.assertEqual(mre._clean_paraphrase("how to determine backup status"),
                         "how to determine backup status")

    def test_standalone_metatoken_still_dropped(self):
        # the actual meta-token 'term' as a whole word IS filtered.
        self.assertEqual(mre._clean_paraphrase("use a different term for this"), "")

    def test_multiword_metatoken_still_dropped(self):
        self.assertEqual(mre._clean_paraphrase("write the search query here"), "")

    def test_paraphrase_metatoken_wholeword_dropped(self):
        self.assertEqual(mre._clean_paraphrase("paraphrase the topic somehow"), "")


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


def _raw(hybrid_r1_hits, evaluated=10, fts_r1_hits=3):
    """Build a run_eval()-shaped tally with `hybrid_r1_hits`/`evaluated` at r@1."""
    def stat(hits):
        return {"r@1": hits, "r@5": hits, "r@10": hits,
                "mrr": float(hits), "found": hits}
    return {
        "sample_size": evaluated, "evaluated": evaluated, "skipped": 0,
        "retrievable_total": evaluated,
        "stats": {"hybrid": stat(hybrid_r1_hits), "fts": stat(fts_r1_hits)},
        "misses": {"hybrid": [], "fts": []}, "errors": [],
    }


class BuildSummaryTests(unittest.TestCase):
    def test_shape_has_regression_fields(self):
        s = mre.build_summary(_raw(10), "lexical-anchor", 0.90)
        self.assertEqual(s["mode"], "lexical-anchor")
        self.assertEqual(s["experiment_id"], "memory-retrieval-eval")
        for key in ("sample_size", "evaluated", "skipped", "metrics", "pass_criteria"):
            self.assertIn(key, s)
        self.assertIn("hybrid", s["metrics"])
        self.assertIn("fts", s["metrics"])
        for m in ("hybrid", "fts"):
            for k in ("recall@1", "recall@5", "recall@10", "mrr", "found"):
                self.assertIn(k, s["metrics"][m])

    def test_pass_criteria_met_on_high_recall(self):
        s = mre.build_summary(_raw(10, evaluated=10), "lexical-anchor", 0.90)
        self.assertEqual(s["metrics"]["hybrid"]["recall@1"], 1.0)
        self.assertTrue(s["pass_criteria"]["met"])
        self.assertEqual(s["pass_criteria"]["metric"], "hybrid recall@1")

    def test_pass_criteria_not_met_on_low_recall(self):
        s = mre.build_summary(_raw(5, evaluated=10), "lexical-anchor", 0.90)
        self.assertEqual(s["metrics"]["hybrid"]["recall@1"], 0.5)
        self.assertFalse(s["pass_criteria"]["met"])

    def test_impossible_threshold_never_met(self):
        # exit-code-1 path: --threshold 1.01 is unreachable even at perfect recall.
        s = mre.build_summary(_raw(10, evaluated=10), "lexical-anchor", 1.01)
        self.assertEqual(s["metrics"]["hybrid"]["recall@1"], 1.0)
        self.assertFalse(s["pass_criteria"]["met"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
