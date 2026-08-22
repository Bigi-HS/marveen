"""
Tests for bigben-frame-analysis.py -- zero-frame / no-detection guard (card 9586048c).

Run:  python3 scripts/test_bigben_frame_analysis.py
"""

import importlib.util
import sys
import os
import json
import tempfile
import unittest

# Load the module by path (no package, hyphenated filename)
_spec = importlib.util.spec_from_file_location(
    "bigben_frame_analysis",
    os.path.join(os.path.dirname(__file__), "bigben-frame-analysis.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

consensus_zone = _mod.consensus_zone
NoDetectionError = _mod.NoDetectionError
zone_confidence = _mod.zone_confidence
zone_share = _mod.zone_share
summary_of = _mod.summary_of


class TestZoneConfidence(unittest.TestCase):
    """confidence must span the full [0,1] range and ignore the overlapping centre."""

    def test_runner_up_zero_is_full_confidence(self):
        """One quadrant scoring alone is unambiguous."""
        totals = {"top-left": 0.8, "top-right": 0.0, "bottom-left": 0.0,
                  "bottom-right": 0.0, "center": 0.4}
        self.assertEqual(zone_confidence(totals), 1.0)

    def test_tied_quadrants_is_zero_confidence(self):
        """Indistinguishable leaders must not read as confident."""
        totals = {"top-left": 0.5, "top-right": 0.5, "bottom-left": 0.2,
                  "bottom-right": 0.1, "center": 0.9}
        self.assertEqual(zone_confidence(totals), 0.0)

    def test_center_does_not_suppress_a_clear_quadrant(self):
        """A dominant 'center' score must not drag a clear quadrant lead down.

        This is the whole reason centre is excluded: it overlaps all four
        quadrants, so leaving it in made every margin look small.

        Numbers chosen so the two implementations DISAGREE: excluding centre
        gives (1.0-0.2)/1.0 = 0.8, including it gives (1.5-1.0)/1.5 = 0.333.
        With centre at 5.0 both happened to return 0.8 and the test was a
        rubber stamp -- caught by mutation-testing it on 08-05.
        """
        totals = {"top-left": 1.0, "top-right": 0.2, "bottom-left": 0.2,
                  "bottom-right": 0.2, "center": 1.5}
        self.assertEqual(zone_confidence(totals), 0.8)

    def test_all_zero_is_zero_not_crash(self):
        """No signal must return 0.0, never divide by zero."""
        totals = {k: 0.0 for k in ("top-left", "top-right", "bottom-left",
                                   "bottom-right", "center")}
        self.assertEqual(zone_confidence(totals), 0.0)

    def test_confidence_outranges_zone_share(self):
        """Regression guard for the 08-05 recalibration (card CONT-052).

        zone_share could not separate a perfect detection from garbage: it was
        capped near 0.5 either way. confidence must react far more strongly to
        the same input, otherwise the fix did not land.
        """
        clear = {"top-left": 1.0, "top-right": 0.0, "bottom-left": 0.0,
                 "bottom-right": 0.0, "center": 0.5}
        murky = {"top-left": 0.51, "top-right": 0.50, "bottom-left": 0.50,
                 "bottom-right": 0.50, "center": 0.50}
        self.assertGreater(
            zone_confidence(clear) - zone_confidence(murky),
            zone_share(clear, "top-left") - zone_share(murky, "top-left"),
        )

    def test_zone_share_is_not_a_probability(self):
        """Documented caveat, pinned: share stays low even when unambiguous."""
        totals = {"top-left": 1.0, "top-right": 0.0, "bottom-left": 0.0,
                  "bottom-right": 0.0, "center": 1.0}
        self.assertEqual(zone_share(totals, "top-left"), 0.5)


class TestSummarySchema(unittest.TestCase):
    """stdout must stay a strict subset of the --out file schema."""

    def _result(self):
        return {
            "video": "x.mp4", "resolution": "1280x720", "duration_s": 6.0,
            "frames_analyzed": 4, "speaker_zone": "top-left",
            "safe_overlay_zone": "bottom-right",
            "overlay_position_ffmpeg": {"x": "w*0.55", "y": "h*0.60"},
            "confidence": 0.67, "zone_share": 0.47,
            "zone_scores": {}, "frame_details": [], "hyperframes_hint": {},
        }

    def test_summary_fields_exist_in_file_schema(self):
        """Every shared key must carry the same name AND value in both views."""
        result = self._result()
        summary = summary_of(result)
        for key in _mod.SUMMARY_FIELDS:
            self.assertIn(key, result, f"{key} missing from file schema")
            self.assertEqual(summary[key], result[key], f"{key} diverged")

    def test_confidence_present_in_both_views(self):
        """The pre-08-05 bug: confidence existed only on stdout."""
        result = self._result()
        self.assertIn("confidence", result)
        self.assertIn("confidence", summary_of(result))

    def test_legacy_flat_keys_retained(self):
        """Old stdout consumers must not break."""
        summary = summary_of(self._result())
        self.assertEqual(summary["overlay_ffmpeg_x"], "w*0.55")
        self.assertEqual(summary["overlay_ffmpeg_y"], "h*0.60")

    def test_no_detection_summary_has_null_coords(self):
        """overlay_position_ffmpeg is None on no-detection; must not raise."""
        summary = summary_of({
            "speaker_zone": "no-detection", "safe_overlay_zone": "no-detection",
            "overlay_position_ffmpeg": None, "confidence": 0.0, "zone_share": 0.0,
        })
        self.assertIsNone(summary["overlay_ffmpeg_x"])
        self.assertEqual(summary["confidence"], 0.0)


class TestConsensusZoneZeroFrame(unittest.TestCase):
    """consensus_zone must raise NoDetectionError when no detection is possible."""

    def test_empty_frame_list_raises(self):
        """Empty frame_analyses must not return a fake zone."""
        with self.assertRaises(NoDetectionError):
            consensus_zone([])

    def test_all_zero_composites_raises(self):
        """All-zero composites (e.g. black frames) must not return a fake zone."""
        zero_scores = {name: {"composite": 0.0} for name in _mod.QUADRANTS}
        frame_analyses = [{"timestamp": 1.0, "quadrant_scores": zero_scores}]
        with self.assertRaises(NoDetectionError):
            consensus_zone(frame_analyses)

    def test_all_zero_multi_frame_raises(self):
        """Multiple frames all zero -- still no detection."""
        zero_scores = {name: {"composite": 0.0} for name in _mod.QUADRANTS}
        frame_analyses = [
            {"timestamp": t, "quadrant_scores": zero_scores}
            for t in [1.0, 2.0, 3.0]
        ]
        with self.assertRaises(NoDetectionError):
            consensus_zone(frame_analyses)

    def test_normal_case_still_works(self):
        """Non-zero composites: consensus_zone returns the highest-scoring zone."""
        scores_base = {name: {"composite": 0.1} for name in _mod.QUADRANTS}
        scores_base["bottom-right"] = {"composite": 0.9}
        frame_analyses = [{"timestamp": 1.0, "quadrant_scores": scores_base}]
        speaker, safe, totals = consensus_zone(frame_analyses)
        self.assertEqual(speaker, "bottom-right")
        self.assertEqual(safe, "top-left")  # SAFE_ZONE_OPPOSITE["bottom-right"]

    def test_partial_zero_frames_still_detects(self):
        """Mix of zero + non-zero frames: aggregation works, detection fires."""
        zero_scores = {name: {"composite": 0.0} for name in _mod.QUADRANTS}
        good_scores = {name: {"composite": 0.05} for name in _mod.QUADRANTS}
        good_scores["top-right"] = {"composite": 0.8}
        frame_analyses = [
            {"timestamp": 1.0, "quadrant_scores": zero_scores},
            {"timestamp": 2.0, "quadrant_scores": good_scores},
        ]
        speaker, safe, totals = consensus_zone(frame_analyses)
        self.assertEqual(speaker, "top-right")


class TestMainNoDetectionOutput(unittest.TestCase):
    """main() must output a no-detection JSON when frame extraction yields nothing."""

    def _run_main_with_empty_tmpdir(self):
        """
        Simulate: valid video path check bypassed, extract_frames returns [].
        We patch get_video_info and extract_frames, then call main() via
        the module's internal flow, capturing stdout.
        """
        import io
        from unittest.mock import patch

        fake_info = {
            "duration": 0.1,
            "width": 1920,
            "height": 1080,
            "fps": 30.0,
        }

        captured = io.StringIO()
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            fake_video = f.name
        try:
            with (
                patch.object(_mod, "get_video_info", return_value=fake_info),
                patch.object(_mod, "extract_frames", return_value=[]),
                patch.object(sys, "argv", ["bigben-frame-analysis.py", "--video", fake_video]),
                patch("sys.stdout", captured),
            ):
                try:
                    _mod.main()
                except SystemExit:
                    pass
        finally:
            os.unlink(fake_video)

        return captured.getvalue()

    def test_no_detection_json_output(self):
        """main() with 0 extracted frames must output no-detection JSON (not a fake zone)."""
        output = self._run_main_with_empty_tmpdir()
        data = json.loads(output)
        self.assertEqual(data.get("speaker_zone"), "no-detection")
        self.assertEqual(data.get("confidence"), 0.0)
        self.assertIn("no-detection", data.get("safe_overlay_zone", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
