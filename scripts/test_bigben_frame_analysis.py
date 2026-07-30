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
