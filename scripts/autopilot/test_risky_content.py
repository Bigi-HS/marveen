#!/usr/bin/env python3
"""Adversarial test suite for risky_content.is_risky_instruction (autopilot step 3,
RK-01 content-inspection). adversarial-fixture-gate skill: a detector PR must ship
fixtures for the known bypass classes.

Falsifying discipline (assertion-direction-check): the DANGEROUS direction is a
risky instruction read as SAFE (false negative -> autonomous risky action). The
bulk of these cases assert on that side.

Run: python3 scripts/autopilot/test_risky_content.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from risky_content import is_risky_instruction, normalize  # noqa: E402


class PlainHits(unittest.TestCase):
    """Unobfuscated risky instructions MUST be flagged (dangerous side)."""

    def test_deploy(self):
        self.assertTrue(is_risky_instruction("please deploy the server now")[0])

    def test_delete(self):
        self.assertTrue(is_risky_instruction("delete the store/ backups")[0])

    def test_merge_to_main(self):
        self.assertTrue(is_risky_instruction("go ahead and merge to main")[0])

    def test_publish(self):
        self.assertTrue(is_risky_instruction("publish the video to the channel")[0])

    def test_send_email(self):
        self.assertTrue(is_risky_instruction("send email to the client under NoA")[0])

    def test_hungarian_torol(self):
        self.assertTrue(is_risky_instruction("töröld a kártyát és a markert")[0])

    def test_hungarian_elesit(self):
        self.assertTrue(is_risky_instruction("élesítsd a build-et prod-ra")[0])

    def test_rm_rf(self):
        self.assertTrue(is_risky_instruction("run rm -rf on the dist dir")[0])


class ObfuscationBypass(unittest.TestCase):
    """Cheap evasion the normalizer is REQUIRED to defeat (dangerous side)."""

    def test_casing(self):
        self.assertTrue(is_risky_instruction("DEPLOY IT NOW")[0])

    def test_inter_letter_dots(self):
        self.assertTrue(is_risky_instruction("d.e.p.l.o.y the server")[0])

    def test_inter_letter_dashes(self):
        self.assertTrue(is_risky_instruction("d-e-l-e-t-e the record")[0])

    def test_zero_width(self):
        # "de​ploy" -- zero-width space injected mid-word
        self.assertTrue(is_risky_instruction("de​ploy the server")[0])

    def test_whitespace_runs(self):
        self.assertTrue(is_risky_instruction("merge    to     main")[0])

    def test_accent_variation(self):
        # Fully accented Hungarian still normalizes to the stem.
        self.assertTrue(is_risky_instruction("PUBLIKÁLD ki azonnal")[0])

    def test_mixed_separator_bypass(self):
        # REGRESSION (lesson-verify-normalization-fix-against-live-input-1027):
        # normalize() drops inter-letter separators but keeps word-spaces, so the
        # hyphen-spelled "merge-to-main" stem was DEAD and mixed separators slipped
        # through BOTH spellings. Falsifying assertions on the DANGEROUS side: every
        # separator variant of a risky multiword instruction MUST be caught.
        for variant in (
            "merge-to-main",    # the registered hyphen stem -- was a dead miss
            "merge to-main",    # mixed: space then hyphen -- bypassed both spellings
            "merge-to main",    # mixed: hyphen then space
            "m e r g e t o m a i n",  # per-letter spacing
        ):
            self.assertTrue(
                is_risky_instruction(variant)[0], f"BYPASS not caught: {variant!r}"
            )


class BenignNegatives(unittest.TestCase):
    """Non-risky nudges MUST pass (false-positive control). These are the SAFE
    inter-agent messages the autopilot sends constantly; over-blocking them would
    wedge the normal nudge flow."""

    def test_status_nudge(self):
        self.assertFalse(is_risky_instruction("mi a helyzet a kártyával? tudsz haladni?")[0])

    def test_deadline_reminder(self):
        self.assertFalse(is_risky_instruction("emlékeztető: a review holnap esedékes")[0])

    def test_question(self):
        self.assertFalse(is_risky_instruction("blokkolt valami? miben segíthetek?")[0])

    def test_plain_report(self):
        self.assertFalse(is_risky_instruction("a teszt 13/13 zöld, kész")[0])


class NormalizeUnit(unittest.TestCase):
    def test_empty_and_nonstr(self):
        self.assertEqual(normalize(None), "")
        self.assertEqual(normalize(123), "")
        self.assertEqual(normalize(""), "")

    def test_keeps_word_boundaries(self):
        # A legitimate sentence should not collapse into a false stem. "made-up"
        # hyphen between letters collapses, but that must not fabricate a risky stem.
        risky, _ = is_risky_instruction("the well-made plan is ready")
        self.assertFalse(risky)

    def test_nonstr_input_not_risky(self):
        self.assertFalse(is_risky_instruction(None)[0])
        self.assertFalse(is_risky_instruction(["delete"])[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
