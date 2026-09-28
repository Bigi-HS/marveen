#!/usr/bin/env python3
"""Tests for scripts/da-cross-model-critic.py (card 637543d6).

DA Phase-2 cross-model critic: qwen3:8b via ollama, wired into T3 round-3
when round 2 has CRITICAL/HIGH findings. Graceful degradation when unavailable.

AC1: Only runs on T3 trigger, only in round 3 (not T1/T2, not round 1/2)
AC2: Only runs if round 2 has CRITICAL or HIGH findings
AC3: Calls POST /api/generate with qwen3:8b (or configured fallback model)
AC4: Parses response: extracts verdict (AMPLIFY/DIVERGE/NOTHING_NEW/SKIPPED)
     + divergences list + missed_by_claude list
AC5: Sentinel field: cross_model_critic {model, verdict, divergences, missed_by_claude}
AC6: Graceful degradation: if ollama unavailable (ConnectionError/timeout), returns SKIPPED
AC7: Graceful degradation: if model not found (404), falls back or returns SKIPPED
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_THIS_DIR = Path(__file__).resolve().parent
_MODULE_PATH = _THIS_DIR.parent / "da-cross-model-critic.py"

_spec = importlib.util.spec_from_file_location("da_cross_model_critic", _MODULE_PATH)
assert _spec and _spec.loader, f"cannot load {_MODULE_PATH}"
mod = importlib.util.module_from_spec(_spec)
sys.modules["da_cross_model_critic"] = mod
_spec.loader.exec_module(mod)


SAMPLE_FINDINGS = [
    {"id": "F1", "severity": "CRITICAL", "verdict": "BLOCK", "label": "prod token in env"},
    {"id": "F2", "severity": "HIGH", "verdict": "BLOCK", "label": "race on shared file"},
]

SAMPLE_RESPONSE = """
I disagree with finding F2 - the file lock is already in place.

DIVERGE

Divergences:
- F2 is mitigated by existing flock() call in the writer

Missed by Claude:
- No check on disk-full scenario
- Token rotation not addressed
"""


class ShouldRunCriticTests(unittest.TestCase):
    """AC1 + AC2: gate logic deciding when the critic fires."""

    def test_t3_round3_with_critical_runs(self):
        # AC1 + AC2: T3, round 3, CRITICAL finding -> should run
        self.assertTrue(mod.should_run_cross_critic(
            trigger="T3", round_num=3, has_critical_or_high=True, ollama_available=True
        ))

    def test_t1_never_runs(self):
        # AC1: T1 never uses cross-model critic
        self.assertFalse(mod.should_run_cross_critic(
            trigger="T1", round_num=1, has_critical_or_high=True, ollama_available=True
        ))

    def test_t2_never_runs(self):
        # AC1: T2 never uses cross-model critic
        self.assertFalse(mod.should_run_cross_critic(
            trigger="T2", round_num=1, has_critical_or_high=True, ollama_available=True
        ))

    def test_t3_round1_does_not_run(self):
        # AC1: cross-model only at round 3
        self.assertFalse(mod.should_run_cross_critic(
            trigger="T3", round_num=1, has_critical_or_high=True, ollama_available=True
        ))

    def test_t3_round2_does_not_run(self):
        # AC1: cross-model only at round 3
        self.assertFalse(mod.should_run_cross_critic(
            trigger="T3", round_num=2, has_critical_or_high=True, ollama_available=True
        ))

    def test_t3_round3_no_critical_high_does_not_run(self):
        # AC2: no CRITICAL/HIGH -> skip
        self.assertFalse(mod.should_run_cross_critic(
            trigger="T3", round_num=3, has_critical_or_high=False, ollama_available=True
        ))

    def test_ollama_unavailable_does_not_run(self):
        # AC6: ollama unavailable -> skip (graceful)
        self.assertFalse(mod.should_run_cross_critic(
            trigger="T3", round_num=3, has_critical_or_high=True, ollama_available=False
        ))


class BuildCriticPromptTests(unittest.TestCase):
    """AC3: prompt construction."""

    def test_prompt_contains_decision_summary(self):
        prompt = mod.build_critic_prompt("Deploy new auth flow", "F1: CRITICAL - token leak")
        self.assertIn("Deploy new auth flow", prompt)

    def test_prompt_contains_findings(self):
        prompt = mod.build_critic_prompt("Deploy new auth flow", "F1: CRITICAL - token leak")
        self.assertIn("F1: CRITICAL", prompt)

    def test_prompt_contains_verdict_options(self):
        prompt = mod.build_critic_prompt("summary", "findings")
        # Must include the verdict options so the model knows what to return
        self.assertIn("AMPLIFY", prompt)
        self.assertIn("DIVERGE", prompt)
        self.assertIn("NOTHING NEW", prompt)


class ParseCriticResponseTests(unittest.TestCase):
    """AC4: parse ollama response into structured verdict."""

    def test_parse_diverge_verdict(self):
        result = mod.parse_critic_response("DIVERGE\nDivergences:\n- F2 mitigated\nMissed by Claude:\n- disk-full")
        self.assertEqual(result["verdict"], "DIVERGE")

    def test_parse_amplify_verdict(self):
        result = mod.parse_critic_response("AMPLIFY\nFindings are solid.")
        self.assertEqual(result["verdict"], "AMPLIFY")

    def test_parse_nothing_new_verdict(self):
        result = mod.parse_critic_response("NOTHING NEW\nAll looks correct.")
        self.assertEqual(result["verdict"], "NOTHING_NEW")

    def test_parse_nothing_new_variant(self):
        result = mod.parse_critic_response("NOTHING_NEW")
        self.assertEqual(result["verdict"], "NOTHING_NEW")

    def test_parse_extracts_divergences(self):
        result = mod.parse_critic_response(SAMPLE_RESPONSE)
        self.assertEqual(result["verdict"], "DIVERGE")
        self.assertIsInstance(result["divergences"], list)
        self.assertGreater(len(result["divergences"]), 0)
        self.assertTrue(any("F2" in d for d in result["divergences"]))

    def test_parse_extracts_missed_by_claude(self):
        result = mod.parse_critic_response(SAMPLE_RESPONSE)
        self.assertIsInstance(result["missed_by_claude"], list)
        self.assertGreater(len(result["missed_by_claude"]), 0)

    def test_parse_unknown_falls_back_to_diverge(self):
        result = mod.parse_critic_response("I cannot determine a clear verdict here.")
        self.assertIn(result["verdict"], ("AMPLIFY", "DIVERGE", "NOTHING_NEW"))


class SentinelFieldTests(unittest.TestCase):
    """AC5: build_sentinel_field produces correct structure."""

    def test_sentinel_field_structure(self):
        result = mod.build_critic_sentinel_field(
            model="qwen3:8b",
            verdict="AMPLIFY",
            divergences=[],
            missed_by_claude=["disk-full not checked"],
        )
        self.assertIn("model", result)
        self.assertIn("verdict", result)
        self.assertIn("divergences", result)
        self.assertIn("missed_by_claude", result)
        self.assertEqual(result["model"], "qwen3:8b")
        self.assertEqual(result["verdict"], "AMPLIFY")

    def test_sentinel_field_skipped(self):
        result = mod.build_critic_sentinel_field(
            model="qwen3:8b",
            verdict="SKIPPED",
            divergences=[],
            missed_by_claude=[],
        )
        self.assertEqual(result["verdict"], "SKIPPED")


class GracefulDegradationTests(unittest.TestCase):
    """AC6 + AC7: graceful degradation when ollama unavailable."""

    def test_connection_error_returns_skipped(self):
        import urllib.error
        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            result = mod.call_ollama_critic(
                prompt="test",
                model="qwen3:8b",
                api_base="http://localhost:11434",
            )
        self.assertEqual(result["verdict"], "SKIPPED")

    def test_timeout_returns_skipped(self):
        import socket
        with patch("urllib.request.urlopen", side_effect=TimeoutError("timeout")):
            result = mod.call_ollama_critic(
                prompt="test",
                model="qwen3:8b",
                api_base="http://localhost:11434",
            )
        self.assertEqual(result["verdict"], "SKIPPED")

    def test_http_error_404_returns_skipped(self):
        import urllib.error
        err = urllib.error.HTTPError(
            url="http://localhost:11434/api/generate",
            code=404,
            msg="Not Found",
            hdrs=None,  # type: ignore
            fp=None,  # type: ignore
        )
        with patch("urllib.request.urlopen", side_effect=err):
            result = mod.call_ollama_critic(
                prompt="test",
                model="qwen3:8b",
                api_base="http://localhost:11434",
            )
        self.assertEqual(result["verdict"], "SKIPPED")

    def test_successful_call_returns_parsed_verdict(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "response": "AMPLIFY\nFindings look solid, no divergence found.",
            "done": True,
        }).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            result = mod.call_ollama_critic(
                prompt="test",
                model="qwen3:4b",
                api_base="http://localhost:11434",
            )
        self.assertIn(result["verdict"], ("AMPLIFY", "DIVERGE", "NOTHING_NEW"))


if __name__ == "__main__":
    unittest.main()
