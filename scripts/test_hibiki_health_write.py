#!/usr/bin/env python3
"""Unit tests for scripts/hibiki-health-write.py RANGE_CHECKS (SEC-AC1).

Focuses on the range-validation contract, in particular the bone_density field
(card a0f3f7d3): bone_density is stored as a DEXA T-score, so its plausible
range is roughly -4.0 .. 3.0.

The target module has a hyphen in its name (hibiki-health-write.py), so it
cannot be imported with a normal `import`; we load it via importlib from the
path next to this test file.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_MODULE_PATH = _THIS_DIR / "hibiki-health-write.py"

_spec = importlib.util.spec_from_file_location("hibiki_health_write", _MODULE_PATH)
assert _spec and _spec.loader, f"cannot load module at {_MODULE_PATH}"
hw = importlib.util.module_from_spec(_spec)
sys.modules["hibiki_health_write"] = hw
_spec.loader.exec_module(hw)


class RangeChecksTests(unittest.TestCase):
    def test_bone_density_present(self):
        self.assertIn("bone_density", hw.RANGE_CHECKS)
        lo, hi = hw.RANGE_CHECKS["bone_density"]
        self.assertEqual((lo, hi), (-4.0, 3.0))

    def test_bone_density_in_range_passes(self):
        # Typical/edge in-range T-scores (incl. the example -0.3 in the dexa tests).
        for v in (-4.0, -2.5, -0.3, 0.0, 1.5, 3.0):
            self.assertEqual(
                hw.validate_ranges({"bone_density": v}), [],
                f"expected {v} to be in range",
            )

    def test_bone_density_out_of_range_rejected(self):
        for v in (-4.1, -10.0, 3.1, 50.0):
            errors = hw.validate_ranges({"bone_density": v})
            self.assertTrue(errors, f"expected {v} to be rejected")
            self.assertIn("bone_density", errors[0])

    def test_other_fields_still_validate(self):
        # Regression: pre-existing checks unaffected.
        self.assertEqual(hw.validate_ranges({"weight_kg": 80}), [])
        self.assertTrue(hw.validate_ranges({"weight_kg": 9999}))


class RangeChecksSyncTests(unittest.TestCase):
    """RANGE_CHECKS is a single source of truth (hibiki_ranges), shared by
    hibiki-health-write.py and hibiki-stats.py -- so they cannot drift."""

    def _load_stats(self):
        stats_path = _THIS_DIR / "hibiki-stats.py"
        spec = importlib.util.spec_from_file_location("hibiki_stats", stats_path)
        assert spec and spec.loader
        stats = importlib.util.module_from_spec(spec)
        sys.modules["hibiki_stats"] = stats
        spec.loader.exec_module(stats)
        return stats

    def test_in_sync_with_stats(self):
        stats = self._load_stats()
        self.assertEqual(hw.RANGE_CHECKS, stats.RANGE_CHECKS)

    def test_shared_single_source(self):
        # Both scripts must reference the SAME object from hibiki_ranges, not
        # two copies kept equal by chance -- this structurally forecloses drift.
        import hibiki_ranges
        stats = self._load_stats()
        self.assertIs(hw.RANGE_CHECKS, hibiki_ranges.RANGE_CHECKS)
        self.assertIs(stats.RANGE_CHECKS, hibiki_ranges.RANGE_CHECKS)


if __name__ == "__main__":
    unittest.main()
