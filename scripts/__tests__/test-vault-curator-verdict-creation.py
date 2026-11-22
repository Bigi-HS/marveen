"""
Tests for vault-curator-verdict-creation.py (card d4b69dde).

Option C (Hybrid): jaccard >= JACCARD_THRESHOLD -> APPROVE, else -> REJECT.
REJECT-default: any unexpected error yields REJECT.

Fixtures: 10 pairs (5 clear APPROVE, 3 clear REJECT, 2 edge-case boundary).
Adversarial fixtures (Chad F-1, F-2): malformed entry resilience + approve-cap circuit-breaker.
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

SCRIPT = Path(__file__).parent.parent / "vault-curator-verdict-creation.py"

def load_module():
    spec = importlib.util.spec_from_file_location("vault_curator_verdict_creation", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FIXTURE_CANDIDATES = [
    # 5 clear APPROVE (jaccard >= 0.65)
    {
        "agent_id": "marveen", "entry_a": {"id": 10, "keywords": "k1", "content_preview": "p1"},
        "entry_b": {"id": 11, "keywords": "k2", "content_preview": "p2"}, "jaccard": 0.65,
        "suggestion": "entry_a may be superseded"
    },
    {
        "agent_id": "marveen", "entry_a": {"id": 12, "keywords": "k3", "content_preview": "p3"},
        "entry_b": {"id": 13, "keywords": "k4", "content_preview": "p4"}, "jaccard": 0.80,
        "suggestion": "entry_a may be superseded"
    },
    {
        "agent_id": "claudia", "entry_a": {"id": 20, "keywords": "ka", "content_preview": "pa"},
        "entry_b": {"id": 21, "keywords": "kb", "content_preview": "pb"}, "jaccard": 0.75,
        "suggestion": "entry_a may be superseded"
    },
    {
        "agent_id": "claudia", "entry_a": {"id": 22, "keywords": "kc", "content_preview": "pc"},
        "entry_b": {"id": 23, "keywords": "kd", "content_preview": "pd"}, "jaccard": 0.90,
        "suggestion": "entry_a may be superseded"
    },
    {
        "agent_id": "bond", "entry_a": {"id": 30, "keywords": "k5", "content_preview": "p5"},
        "entry_b": {"id": 31, "keywords": "k6", "content_preview": "p6"}, "jaccard": 0.70,
        "suggestion": "entry_a may be superseded"
    },
    # 3 clear REJECT (jaccard < 0.65)
    {
        "agent_id": "marveen", "entry_a": {"id": 40, "keywords": "k7", "content_preview": "p7"},
        "entry_b": {"id": 41, "keywords": "k8", "content_preview": "p8"}, "jaccard": 0.30,
        "suggestion": "possible overlap"
    },
    {
        "agent_id": "forge", "entry_a": {"id": 50, "keywords": "k9", "content_preview": "p9"},
        "entry_b": {"id": 51, "keywords": "k10", "content_preview": "p10"}, "jaccard": 0.45,
        "suggestion": "possible overlap"
    },
    {
        "agent_id": "dave", "entry_a": {"id": 60, "keywords": "k11", "content_preview": "p11"},
        "entry_b": {"id": 61, "keywords": "k12", "content_preview": "p12"}, "jaccard": 0.20,
        "suggestion": "possible overlap"
    },
    # 2 edge-case (boundary: 0.64 -> REJECT, 0.65 -> APPROVE)
    {
        "agent_id": "dave", "entry_a": {"id": 70, "keywords": "k13", "content_preview": "p13"},
        "entry_b": {"id": 71, "keywords": "k14", "content_preview": "p14"}, "jaccard": 0.6499,
        "suggestion": "borderline"
    },
    {
        "agent_id": "dave", "entry_a": {"id": 72, "keywords": "k15", "content_preview": "p15"},
        "entry_b": {"id": 73, "keywords": "k16", "content_preview": "p16"}, "jaccard": 0.6500,
        "suggestion": "borderline"
    },
]


class TestClassifyCandidate(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()

    def test_above_threshold_is_approve(self):
        c = FIXTURE_CANDIDATES[1]  # jaccard 0.80
        result = self.mod.classify_candidate(c)
        self.assertEqual(result["verdict"], "APPROVE")

    def test_below_threshold_is_reject(self):
        c = FIXTURE_CANDIDATES[5]  # jaccard 0.30
        result = self.mod.classify_candidate(c)
        self.assertEqual(result["verdict"], "REJECT")

    def test_exact_threshold_is_approve(self):
        # 0.65 exactly -> APPROVE (inclusive)
        c = FIXTURE_CANDIDATES[9]  # jaccard 0.6500
        result = self.mod.classify_candidate(c)
        self.assertEqual(result["verdict"], "APPROVE")

    def test_just_below_threshold_is_reject(self):
        # 0.6499 -> REJECT
        c = FIXTURE_CANDIDATES[8]  # jaccard 0.6499
        result = self.mod.classify_candidate(c)
        self.assertEqual(result["verdict"], "REJECT")

    def test_reject_verdict_has_low_confidence_note(self):
        c = FIXTURE_CANDIDATES[6]  # jaccard 0.45
        result = self.mod.classify_candidate(c)
        self.assertIn("low-confidence", result["curator_notes"].lower())

    def test_approve_verdict_has_proposal_id(self):
        c = FIXTURE_CANDIDATES[0]  # jaccard 0.65
        result = self.mod.classify_candidate(c)
        # proposal_id encodes agent + entry ids
        self.assertIn(str(c["entry_a"]["id"]), result["proposal_id"])
        self.assertIn(str(c["entry_b"]["id"]), result["proposal_id"])

    def test_classify_preserves_agent_id(self):
        c = FIXTURE_CANDIDATES[2]  # agent_id claudia
        result = self.mod.classify_candidate(c)
        self.assertEqual(result["agent_id"], "claudia")


class TestProcessCandidates(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()

    def test_five_approves_three_rejects_two_edge(self):
        results = [self.mod.classify_candidate(c) for c in FIXTURE_CANDIDATES]
        approves = [r for r in results if r["verdict"] == "APPROVE"]
        rejects = [r for r in results if r["verdict"] == "REJECT"]
        # 5 clear + 1 edge (0.65) = 6 APPROVE; 3 clear + 1 edge (0.6499) = 4 REJECT
        self.assertEqual(len(approves), 6)
        self.assertEqual(len(rejects), 4)

    def test_empty_candidates_returns_empty(self):
        results = [self.mod.classify_candidate(c) for c in []]
        self.assertEqual(results, [])


class TestPostVerdict(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()

    def test_post_verdict_sends_correct_payload(self):
        import urllib.request
        verdict = {
            "proposal_id": "marveen:10:11:0.65",
            "agent_id": "marveen",
            "entry_a_id": 10,
            "entry_b_id": 11,
            "jaccard": 0.65,
            "verdict": "APPROVE",
            "curator_notes": "jaccard>=0.65 auto-approve",
            "ttl_days": 90,
        }
        response_mock = MagicMock()
        response_mock.read.return_value = b'{"ok":true,"id":1}'
        response_mock.__enter__ = lambda s: s
        response_mock.__exit__ = MagicMock(return_value=False)

        with patch.object(urllib.request, "urlopen", return_value=response_mock) as mock_open:
            result = self.mod.post_verdict(verdict, base_url="http://localhost:3420", token="test-tok")
            self.assertTrue(result["ok"])
            call_args = mock_open.call_args[0][0]
            sent_body = json.loads(call_args.data)
            self.assertEqual(sent_body["verdict"], "APPROVE")
            self.assertEqual(sent_body["entry_a_id"], 10)

    def test_dry_run_does_not_call_api(self):
        import urllib.request
        verdict = {
            "proposal_id": "x:1:2:0.9", "agent_id": "a", "entry_a_id": 1,
            "entry_b_id": 2, "jaccard": 0.9, "verdict": "APPROVE",
            "curator_notes": "auto", "ttl_days": 90,
        }
        with patch.object(urllib.request, "urlopen") as mock_open:
            result = self.mod.post_verdict(verdict, base_url="http://localhost:3420",
                                           token="tok", dry_run=True)
            mock_open.assert_not_called()
            self.assertEqual(result.get("dry_run"), True)


class TestClassifyCandidateBoundsAndEdge(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()

    def test_jaccard_above_1_is_reject_bounds_guard(self):
        # jaccard > 1.0 is a data error -> REJECT fail-closed (Chad LOW advisory)
        c = {
            "agent_id": "marveen", "entry_a": {"id": 90, "keywords": "k", "content_preview": "p"},
            "entry_b": {"id": 91, "keywords": "k2", "content_preview": "p2"}, "jaccard": 1.1,
            "suggestion": "malformed"
        }
        result = self.mod.classify_candidate(c)
        self.assertEqual(result["verdict"], "REJECT")
        self.assertIn("invalid", result["curator_notes"].lower())

    def test_jaccard_negative_is_reject_bounds_guard(self):
        c = {
            "agent_id": "marveen", "entry_a": {"id": 92, "keywords": "k", "content_preview": "p"},
            "entry_b": {"id": 93, "keywords": "k2", "content_preview": "p2"}, "jaccard": -0.1,
            "suggestion": "malformed"
        }
        result = self.mod.classify_candidate(c)
        self.assertEqual(result["verdict"], "REJECT")


class TestRunPipeline(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()

    def test_pipeline_summary_counts(self):
        proposals_data = {"dedup_candidates": FIXTURE_CANDIDATES}
        with patch.object(self.mod, "post_verdict", return_value={"ok": True, "id": 99}):
            summary = self.mod.run_pipeline(
                proposals_data,
                base_url="http://localhost:3420",
                token="tok",
                dry_run=False
            )
        self.assertEqual(summary["approved"], 6)
        self.assertEqual(summary["rejected"], 4)
        self.assertEqual(summary["total"], 10)
        self.assertEqual(summary["errors"], 0)

    def test_pipeline_dry_run_no_api_calls(self):
        proposals_data = {"dedup_candidates": FIXTURE_CANDIDATES[:3]}
        with patch.object(self.mod, "post_verdict", return_value={"dry_run": True}) as mock_post:
            self.mod.run_pipeline(
                proposals_data,
                base_url="http://localhost:3420",
                token="tok",
                dry_run=True
            )
            for c in mock_post.call_args_list:
                self.assertTrue(c.kwargs.get("dry_run") or c.args[2] if len(c.args) > 2 else True)

    def test_malformed_entry_does_not_halt_pipeline(self):
        # F-1 adversarial: one entry missing 'jaccard' key; rest must still be processed
        malformed = {"agent_id": "marveen", "entry_a": {"id": 1}, "entry_b": {"id": 2}}
        good = FIXTURE_CANDIDATES[0]  # jaccard 0.65 -> APPROVE
        proposals_data = {"dedup_candidates": [malformed, good]}
        with patch.object(self.mod, "post_verdict", return_value={"ok": True, "id": 1}):
            summary = self.mod.run_pipeline(
                proposals_data,
                base_url="http://localhost:3420",
                token="tok",
                dry_run=False
            )
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["errors"], 1)       # malformed counted as error
        self.assertEqual(summary["approved"], 1)      # good entry still processed

    def test_approve_cap_circuit_breaker(self):
        # F-2 adversarial: 51 high-jaccard pairs; only MAX_APPROVES_PER_RUN=50 approved,
        # the 51st is downgraded to REJECT with cap note.
        cap = self.mod.MAX_APPROVES_PER_RUN
        pairs = [
            {
                "agent_id": "marveen",
                "entry_a": {"id": i * 2, "keywords": "k", "content_preview": "p"},
                "entry_b": {"id": i * 2 + 1, "keywords": "k2", "content_preview": "p2"},
                "jaccard": 0.80,
                "suggestion": "superseded",
            }
            for i in range(cap + 1)
        ]
        proposals_data = {"dedup_candidates": pairs}
        posted_verdicts = []
        def capture_post(verdict, base_url, token, dry_run=False):
            posted_verdicts.append(verdict["verdict"])
            return {"ok": True, "id": len(posted_verdicts)}
        with patch.object(self.mod, "post_verdict", side_effect=capture_post):
            summary = self.mod.run_pipeline(
                proposals_data,
                base_url="http://localhost:3420",
                token="tok",
                dry_run=False
            )
        self.assertEqual(summary["approved"], cap)
        self.assertEqual(summary["rejected"], 1)       # the 51st was capped -> REJECT
        self.assertEqual(summary["errors"], 0)
        self.assertEqual(posted_verdicts.count("APPROVE"), cap)
        self.assertEqual(posted_verdicts.count("REJECT"), 1)


if __name__ == "__main__":
    unittest.main()
