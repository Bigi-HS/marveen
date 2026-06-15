#!/usr/bin/env python3
"""Unit tests for store/local_worker.py (PATH B local-worker poller, card 6006f513).

Pure-function tests for the advisory memory-tiering poller. The poller talks to
Ollama over HTTP, but every decision-making function is pure and dependency-
injected so the protocol logic is tested without a live daemon.

Run: python3 scripts/__tests__/local_worker.test.py

Covers (alongside the Buster-c12 smoke in store/ollama-pathb-spec.md):
  - parse_category: think-strip + JSON parse + category validation
  - build_classify_payload: think=false / format=json / keep_alive invariants
  - assert_no_cloud_credentials: the mandatory cloud-token fuse
  - tags_have_model: pure core of the health check
  - select_pending: dedup vs already-suggested + burst-shuffle + cap (Thor GAP1)
  - make_suggestion_record: advisory record shape incl. current_category divergence
"""
import json
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import local_worker as lw  # noqa: E402


class ParseCategoryTests(unittest.TestCase):
    def test_plain_valid_json(self):
        self.assertEqual(lw.parse_category('{"category": "warm"}'), "warm")

    def test_strips_think_block(self):
        raw = '<think>let me reason about this</think>{"category": "cold"}'
        self.assertEqual(lw.parse_category(raw), "cold")

    def test_strips_multiline_think_block(self):
        raw = '<think>\nline1\nline2\n</think>\n{"category": "shared"}'
        self.assertEqual(lw.parse_category(raw), "shared")

    def test_case_insensitive_and_trimmed(self):
        self.assertEqual(lw.parse_category('{"category": "  HOT "}'), "hot")

    def test_invalid_category_value_returns_none(self):
        self.assertIsNone(lw.parse_category('{"category": "lukewarm"}'))

    def test_malformed_json_returns_none(self):
        self.assertIsNone(lw.parse_category("not json at all"))

    def test_missing_key_returns_none(self):
        self.assertIsNone(lw.parse_category('{"foo": "bar"}'))

    def test_non_string_category_returns_none(self):
        self.assertIsNone(lw.parse_category('{"category": 42}'))

    def test_empty_after_strip_returns_none(self):
        self.assertIsNone(lw.parse_category("<think>only thinking</think>"))


class BuildClassifyPayloadTests(unittest.TestCase):
    def setUp(self):
        self.entry = {"id": 7, "content": "deploy drift discovered", "keywords": "deploy, dist"}
        self.payload = lw.build_classify_payload(self.entry, model="qwen3:4b")

    def test_think_disabled(self):
        # KOTELEZO: qwen3 thinking-mode pollutes the structured output.
        self.assertIs(self.payload["options"]["think"], False)

    def test_format_json(self):
        self.assertEqual(self.payload["format"], "json")

    def test_keep_alive_present(self):
        self.assertIn("keep_alive", self.payload)

    def test_not_streaming(self):
        self.assertIs(self.payload["stream"], False)

    def test_model_passed_through(self):
        self.assertEqual(self.payload["model"], "qwen3:4b")

    def test_has_system_and_user_messages(self):
        roles = [m["role"] for m in self.payload["messages"]]
        self.assertEqual(roles, ["system", "user"])
        self.assertIn("deploy drift discovered", self.payload["messages"][1]["content"])
        self.assertIn("deploy, dist", self.payload["messages"][1]["content"])

    def test_missing_keywords_is_safe(self):
        p = lw.build_classify_payload({"id": 1, "content": "x"}, model="qwen3:4b")
        self.assertIn("x", p["messages"][1]["content"])


class CloudTokenFuseTests(unittest.TestCase):
    def test_raises_on_api_key(self):
        with self.assertRaises(RuntimeError):
            lw.assert_no_cloud_credentials({"ANTHROPIC_API_KEY": "sk-test"})

    def test_raises_on_auth_token(self):
        with self.assertRaises(RuntimeError):
            lw.assert_no_cloud_credentials({"ANTHROPIC_AUTH_TOKEN": "tok"})

    def test_empty_value_is_safe(self):
        # explicit empty override is the documented safe launch form
        lw.assert_no_cloud_credentials({"ANTHROPIC_API_KEY": ""})

    def test_absent_is_safe(self):
        lw.assert_no_cloud_credentials({"PATH": "/usr/bin"})

    def test_raises_on_oauth_token(self):
        # Chad: the launcher must scrub CLAUDE_CODE_OAUTH_TOKEN too -- it is the
        # real exfil-capable cloud credential.
        with self.assertRaises(RuntimeError):
            lw.assert_no_cloud_credentials({"CLAUDE_CODE_OAUTH_TOKEN": "oauth"})

    def test_claude_config_dir_is_safe(self):
        # CLAUDE_CONFIG_DIR is a benign path set fleet-wide -- must NOT abort.
        lw.assert_no_cloud_credentials({"CLAUDE_CONFIG_DIR": "/home/x/.claude-config"})


class AssertLocalUrlsTests(unittest.TestCase):
    """Chad FLAG (A10 SSRF): the poller reads the whole vault, so both endpoints
    MUST be loopback -- a tampered env must not exfiltrate vault content."""

    def test_localhost_and_loopback_pass(self):
        lw.assert_local_urls("http://localhost:11434", "http://127.0.0.1:3420")

    def test_ipv6_loopback_passes(self):
        lw.assert_local_urls("http://[::1]:11434", "http://localhost:3420")

    def test_external_ollama_raises(self):
        with self.assertRaises(RuntimeError):
            lw.assert_local_urls("http://evil.example.com:11434", "http://localhost:3420")

    def test_external_dashboard_raises(self):
        with self.assertRaises(RuntimeError):
            lw.assert_local_urls("http://localhost:11434", "http://10.0.0.5:3420")

    def test_lookalike_host_raises(self):
        # "localhost.evil.com" must not slip past a naive prefix check.
        with self.assertRaises(RuntimeError):
            lw.assert_local_urls("http://localhost.evil.com:11434", "http://localhost:3420")


class AppendSuggestionPermsTests(unittest.TestCase):
    """Chad: suggestions.jsonl holds vault-derived content previews -> 0600."""

    def test_file_created_0600(self):
        tmp = tempfile.mkdtemp(prefix="lw-perm-")
        path = os.path.join(tmp, "suggestions.jsonl")
        lw.append_suggestion(path, {"memory_id": 1, "suggested_category": "warm"})
        mode = stat.S_IMODE(os.stat(path).st_mode)
        self.assertEqual(mode, 0o600, f"expected 0600, got {oct(mode)}")

    def test_loosens_preexisting_perms(self):
        tmp = tempfile.mkdtemp(prefix="lw-perm2-")
        path = os.path.join(tmp, "suggestions.jsonl")
        with open(path, "w") as f:
            f.write("")
        os.chmod(path, 0o644)
        lw.append_suggestion(path, {"memory_id": 2})
        mode = stat.S_IMODE(os.stat(path).st_mode)
        self.assertEqual(mode, 0o600)


class TagsHaveModelTests(unittest.TestCase):
    def test_served_model_matches(self):
        tags = {"models": [{"name": "qwen3:4b"}, {"name": "nomic-embed-text"}]}
        self.assertTrue(lw.tags_have_model(tags, "qwen3:4b"))

    def test_quantised_tag_matches_by_family(self):
        tags = {"models": [{"name": "qwen3:4b-instruct-q4_k_m"}]}
        self.assertTrue(lw.tags_have_model(tags, "qwen3:4b"))

    def test_absent_model_false(self):
        tags = {"models": [{"name": "llama3:8b"}]}
        self.assertFalse(lw.tags_have_model(tags, "qwen3:4b"))

    def test_empty_false(self):
        self.assertFalse(lw.tags_have_model({"models": []}, "qwen3:4b"))


class SelectPendingTests(unittest.TestCase):
    def _mems(self, n):
        return [{"id": i, "content": f"m{i}", "category": "warm"} for i in range(n)]

    def test_dedups_already_suggested(self):
        mems = self._mems(5)
        out = lw.select_pending(mems, already={1, 3}, cap=10, rng=_FixedRng())
        ids = {m["id"] for m in out}
        self.assertEqual(ids, {0, 2, 4})

    def test_caps_at_limit(self):
        mems = self._mems(25)
        out = lw.select_pending(mems, already=set(), cap=10, rng=_FixedRng())
        self.assertEqual(len(out), 10)

    def test_shuffles_before_cap_for_coverage(self):
        # With >cap pending, two different shuffles must be able to surface
        # different items -- otherwise the same 10 are classified forever (GAP1).
        mems = self._mems(25)
        first = lw.select_pending(mems, already=set(), cap=10, rng=_SeqRng([24, 23, 22, 21, 20, 19, 18, 17, 16, 15]))
        ids = {m["id"] for m in first}
        # the injected rng pulls the tail items to the front -> they make the cap
        self.assertTrue(ids & {24, 23, 22}, "shuffle must let tail items reach the cap")

    def test_empty_input(self):
        self.assertEqual(lw.select_pending([], already=set(), cap=10, rng=_FixedRng()), [])


class MakeSuggestionRecordTests(unittest.TestCase):
    def test_valid_suggestion_includes_divergence_fields(self):
        entry = {"id": 9, "content": "x" * 200, "category": "warm"}
        rec = lw.make_suggestion_record(entry, suggested="cold", raw='{"category":"cold"}', now=1000.0)
        self.assertEqual(rec["memory_id"], 9)
        self.assertEqual(rec["suggested_category"], "cold")
        self.assertEqual(rec["current_category"], "warm")
        self.assertEqual(rec["ts"], 1000.0)
        self.assertLessEqual(len(rec["content_preview"]), 80)
        self.assertLessEqual(len(rec["raw_response"]), 200)

    def test_parse_fail_marker(self):
        entry = {"id": 2, "content": "y", "category": "hot"}
        rec = lw.make_suggestion_record(entry, suggested=None, raw="garbage", now=1.0)
        self.assertEqual(rec["suggested_category"], "PARSE_FAIL")
        self.assertEqual(rec["current_category"], "hot")


class _FixedRng:
    """rng stub whose shuffle is a no-op (preserves input order)."""

    def shuffle(self, seq):
        pass


class _SeqRng:
    """rng stub whose shuffle reorders seq to a fixed id ordering (front = given ids)."""

    def __init__(self, front_ids):
        self.front_ids = front_ids

    def shuffle(self, seq):
        order = {mid: i for i, mid in enumerate(self.front_ids)}
        seq.sort(key=lambda m: order.get(m["id"], len(self.front_ids) + m["id"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
