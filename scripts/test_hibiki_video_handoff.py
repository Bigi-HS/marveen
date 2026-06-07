#!/usr/bin/env python3
"""Unit tests for scripts/hibiki-video-handoff.py (spec E-AC2 / OQ2).

Pure stdlib (unittest). No network / no real inter-agent calls: the transport
boundary (send_fn) is stubbed and the clock is injected so the timeout path is
deterministic. Run:  python3 scripts/test_hibiki_video_handoff.py
"""

import importlib.util
import unittest
from pathlib import Path

# The module filename has a hyphen, so import it by path.
_MODULE_PATH = Path(__file__).resolve().parent / "hibiki-video-handoff.py"
_spec = importlib.util.spec_from_file_location("hibiki_video_handoff", _MODULE_PATH)
hvh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hvh)


# --- Sanitized fixtures ------------------------------------------------------

VALID_RESPONSE = {
    "exercise": "squat",
    "timestamp": "2026-06-07T10:15:00+02:00",
    "findings": [
        {"issue": "knee cave on left side", "severity": "advisory", "cue": "push knees out"},
        {"issue": "slight forward lean", "severity": "note", "cue": "chest up, brace harder"},
    ],
    # extra field should be tolerated and dropped from the normalized record
    "processed_by": "bigben",
}


class TestRequestBuilder(unittest.TestCase):
    def test_builds_expected_shape(self):
        req = hvh.build_form_analysis_request(
            "squat", "https://example/v.mp4", ["knee tracking", "depth"]
        )
        self.assertEqual(req["type"], "form_analysis_request")
        self.assertEqual(req["from"], "hibiki")
        self.assertEqual(req["exercise"], "squat")
        self.assertEqual(req["video_url"], "https://example/v.mp4")
        self.assertEqual(req["specific_concerns"], ["knee tracking", "depth"])

    def test_concerns_default_empty_and_trimmed(self):
        req = hvh.build_form_analysis_request("squat", "u")
        self.assertEqual(req["specific_concerns"], [])
        req2 = hvh.build_form_analysis_request("squat", "u", ["  depth  ", "", "  "])
        self.assertEqual(req2["specific_concerns"], ["depth"])

    def test_rejects_empty_exercise_or_url(self):
        with self.assertRaises(ValueError):
            hvh.build_form_analysis_request("", "u")
        with self.assertRaises(ValueError):
            hvh.build_form_analysis_request("squat", "   ")


class TestResponseValidation(unittest.TestCase):
    def test_valid_response_normalizes(self):
        out = hvh.validate_form_feedback(VALID_RESPONSE)
        self.assertEqual(out["exercise"], "squat")
        self.assertEqual(len(out["findings"]), 2)
        self.assertEqual(out["findings"][0]["severity"], "advisory")
        self.assertNotIn("processed_by", out)  # extra field dropped

    def test_empty_findings_is_valid(self):
        out = hvh.validate_form_feedback({"exercise": "bench", "findings": []})
        self.assertEqual(out["findings"], [])

    def test_invalid_severity_rejected(self):
        bad = {
            "exercise": "squat",
            "findings": [{"issue": "x", "severity": "warning", "cue": "y"}],
        }
        with self.assertRaises(hvh.FormAnalysisError):
            hvh.validate_form_feedback(bad)

    def test_missing_findings_rejected(self):
        with self.assertRaises(hvh.FormAnalysisError):
            hvh.validate_form_feedback({"exercise": "squat"})

    def test_missing_cue_rejected(self):
        bad = {
            "exercise": "squat",
            "findings": [{"issue": "x", "severity": "note"}],
        }
        with self.assertRaises(hvh.FormAnalysisError):
            hvh.validate_form_feedback(bad)

    def test_non_dict_rejected(self):
        with self.assertRaises(hvh.FormAnalysisError):
            hvh.validate_form_feedback(["not", "a", "dict"])


class TestHandoffOrchestration(unittest.TestCase):
    def test_happy_path_returns_validated_feedback(self):
        def send_fn(req, budget):
            self.assertEqual(req["exercise"], "squat")
            self.assertEqual(budget, 300.0)
            return VALID_RESPONSE

        out = hvh.request_form_analysis("squat", "u", send_fn)
        self.assertNotIn("pending", out)
        self.assertEqual(len(out["findings"]), 2)

    def test_timeout_returns_fallback(self):
        # Injected clock advances past the budget so the timeout branch fires
        # without any real waiting.
        ticks = iter([0.0, 301.0])

        def clock():
            return next(ticks)

        def slow_send(req, budget):
            return VALID_RESPONSE  # arrives, but "too late" per the clock

        out = hvh.request_form_analysis(
            "squat", "u", slow_send, timeout_sec=300, clock=clock
        )
        self.assertTrue(out["pending"])
        self.assertEqual(out["findings"][0]["severity"], "note")
        self.assertIn("push knees out".split()[0], out["findings"][0]["cue"].lower())
        self.assertIn("timeout", out["fallback_reason"])

    def test_none_response_returns_fallback(self):
        out = hvh.request_form_analysis("deadlift", "u", lambda r, b: None)
        self.assertTrue(out["pending"])
        self.assertIn("no response", out["fallback_reason"])
        # deadlift-specific library cue
        self.assertIn("bar close", out["findings"][0]["cue"].lower())

    def test_transport_error_returns_fallback(self):
        def boom(req, budget):
            raise RuntimeError("pipe wedged")

        out = hvh.request_form_analysis("bench", "u", boom)
        self.assertTrue(out["pending"])
        self.assertIn("delivery error", out["fallback_reason"])

    def test_invalid_response_returns_fallback(self):
        bad = {"exercise": "squat", "findings": [{"issue": "x", "severity": "BAD", "cue": "y"}]}
        out = hvh.request_form_analysis("squat", "u", lambda r, b: bad)
        self.assertTrue(out["pending"])
        self.assertIn("invalid response", out["fallback_reason"])

    def test_unknown_exercise_uses_generic_cue(self):
        out = hvh.request_form_analysis("zercher carry", "u", lambda r, b: None)
        self.assertTrue(out["pending"])
        self.assertEqual(out["findings"][0]["cue"], hvh.GENERIC_FALLBACK_CUE)


if __name__ == "__main__":
    unittest.main(verbosity=2)
