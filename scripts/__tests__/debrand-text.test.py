#!/usr/bin/env python3
"""Tests for the de-brand text engine core (scripts/debrand_text.py, card 901ecb0b).

Spec: store/specs/v2-debrand-hybrid-tooling.md (Thor PASS + DA T1 closed).
This PR covers the deterministic CODE-context classifier: blocklist (pattern-based),
A1 path, A2 agent-id (key-gated), A3 route REFUSE, fail-closed unclassified. The
prose/memory tier (A4, M1/M2/M3, provenance, pre-scan gate) lands in the follow-up PR.

Run: python3 scripts/__tests__/debrand-text.test.py
"""
import os
import sys
import unittest

# Module under test lives in scripts/ (parent of this scripts/__tests__/ dir).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from debrand_text import (  # noqa: E402
    classify,
    apply,
    case_map,
    REWRITE,
    REFUSE,
    NOOP,
)


class CaseMapTest(unittest.TestCase):
    def test_lower(self):
        self.assertEqual(case_map("marveen"), "noa")

    def test_capitalized(self):
        self.assertEqual(case_map("Marveen"), "Noa")

    def test_upper(self):
        self.assertEqual(case_map("MARVEEN"), "NOA")

    def test_embedded_all_occurrences(self):
        self.assertEqual(case_map("marveen-and-Marveen"), "noa-and-Noa")


class BlocklistTest(unittest.TestCase):
    def test_launchd_label_refused(self):
        v = classify("com.marveen.channel-coordinator")
        self.assertEqual(v.action, REFUSE)
        self.assertEqual(v.tag, "coordinated-infra")

    def test_launchd_variant_not_in_literal_list_still_refused(self):
        # DA-F3 / glued-shorthand lesson: pattern, not literal list.
        v = classify("com.marveen.newthing")
        self.assertEqual((v.action, v.tag), (REFUSE, "coordinated-infra"))

    def test_session_name_refused(self):
        for s in ("marveen-channels", "agent-marveen-local", "agent-marveen-prod"):
            v = classify(s)
            self.assertEqual((v.action, v.tag), (REFUSE, "coordinated-infra"), s)

    def test_external_handle_refused(self):
        for s in ("@marveen", "slack-channel@marveen-marketplace"):
            v = classify(s)
            self.assertEqual((v.action, v.tag), (REFUSE, "coordinated-infra"), s)

    def test_blocklist_wins_over_allowlist_key(self):
        # Even in an agent-id key context, a blocklist token must REFUSE (blocklist wins).
        v = classify("com.marveen.channels", key="agent_id")
        self.assertEqual((v.action, v.tag), (REFUSE, "coordinated-infra"))


class A1PathTest(unittest.TestCase):
    def test_path_prefix_rewritten(self):
        v = classify("/home/domin/marveen/store/noa.db")
        self.assertEqual(v.action, REWRITE)
        self.assertEqual(v.new_value, "/home/domin/noa/store/noa.db")

    def test_bare_prefix(self):
        v = classify("/home/domin/marveen")
        self.assertEqual((v.action, v.new_value), (REWRITE, "/home/domin/noa"))


class A2AgentIdTest(unittest.TestCase):
    def test_agent_id_key_rewrites(self):
        for k in ("agent_id", "agentId", "from", "to", "MAIN_AGENT_ID", "source"):
            v = classify("marveen", key=k)
            self.assertEqual((v.action, v.new_value), (REWRITE, "noa"), k)

    def test_default_agent_key_rewrites(self):
        # DA-5: migrate-to-noa.py:40 DEFAULT_AGENT = "marveen" must be covered.
        v = classify("marveen", key="DEFAULT_AGENT")
        self.assertEqual((v.action, v.new_value), (REWRITE, "noa"))

    def test_without_key_context_not_auto_rewritten(self):
        # A2 is key-gated: a bare 'marveen' with no agent-id key is NOT an A2 rewrite.
        v = classify("marveen")
        self.assertEqual(v.action, REFUSE)
        self.assertEqual(v.tag, "unclassified")

    def test_non_agentid_key_not_rewritten(self):
        v = classify("marveen", key="comment")
        self.assertEqual((v.action, v.tag), (REFUSE, "unclassified"))


class A3RouteTest(unittest.TestCase):
    def test_api_route_refused(self):
        v = classify("/api/marveen")
        self.assertEqual((v.action, v.tag), (REFUSE, "contract-change-route"))

    def test_bare_route_refused(self):
        v = classify("/api/marveen/avatar")
        self.assertEqual((v.action, v.tag), (REFUSE, "contract-change-route"))


class FailClosedTest(unittest.TestCase):
    def test_unknown_shape_refused_unclassified(self):
        v = classify("some marveen prose nobody classified", key=None)
        self.assertEqual((v.action, v.tag), (REFUSE, "unclassified"))

    def test_noop_when_no_marveen(self):
        v = classify("/home/domin/noa/store")
        self.assertEqual(v.action, NOOP)


class ApplyTest(unittest.TestCase):
    def test_apply_rewrite_returns_new_value(self):
        new, v = apply("/home/domin/marveen/x", key=None)
        self.assertEqual(new, "/home/domin/noa/x")
        self.assertEqual(v.action, REWRITE)

    def test_apply_refuse_leaves_value_unchanged(self):
        new, v = apply("com.marveen.channels", key=None)
        self.assertEqual(new, "com.marveen.channels")
        self.assertEqual(v.action, REFUSE)

    def test_apply_noop_unchanged(self):
        new, v = apply("plain text", key=None)
        self.assertEqual(new, "plain text")
        self.assertEqual(v.action, NOOP)

    def test_apply_is_idempotent(self):
        new1, _ = apply("/home/domin/marveen/x", key=None)
        new2, v2 = apply(new1, key=None)
        self.assertEqual(new1, new2)
        self.assertEqual(v2.action, NOOP)


if __name__ == "__main__":
    unittest.main()
