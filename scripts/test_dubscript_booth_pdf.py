#!/usr/bin/env python3
"""Unit tests for dubscript-booth-pdf.py pure logic + a render smoke test.

Run: python3 scripts/test_dubscript_booth_pdf.py
"""

import importlib.util
import os
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "booth_pdf", os.path.join(_HERE, "dubscript-booth-pdf.py")
)
booth = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(booth)


class KamBadgeTests(unittest.TestCase):
    def test_v2_enum_colours(self):
        self.assertEqual(booth.kam_badge("ON-KEY"), ("ON-KEY", "8B0000"))
        self.assertEqual(booth.kam_badge("ON-STD"), ("ON-STD", "FF0000"))
        self.assertEqual(booth.kam_badge("OC"), ("OC", "FFD700"))
        self.assertEqual(booth.kam_badge("OFF"), ("OFF", "B0B0B0"))
        self.assertEqual(booth.kam_badge("TEXT"), ("TEXT", "1E90FF"))

    def test_legacy_on_maps_to_red(self):
        self.assertEqual(booth.kam_badge("ON")[1], "FF0000")

    def test_case_and_whitespace_insensitive(self):
        self.assertEqual(booth.kam_badge("  on-key  "), ("ON-KEY", "8B0000"))

    def test_empty_or_unknown_is_none(self):
        self.assertIsNone(booth.kam_badge(""))
        self.assertIsNone(booth.kam_badge(None))
        self.assertIsNone(booth.kam_badge("BANANA"))


class IsOffTests(unittest.TestCase):
    def test_off_only(self):
        self.assertTrue(booth.is_off("OFF"))
        self.assertTrue(booth.is_off(" off "))
        self.assertFalse(booth.is_off("ON"))
        self.assertFalse(booth.is_off(""))


class SyllableOverflowTests(unittest.TestCase):
    def test_on_family_over_threshold_warns(self):
        self.assertTrue(booth.syllable_overflow(10, 5, "ON"))      # 100% diff
        self.assertTrue(booth.syllable_overflow(7, 5, "ON-KEY"))   # 40% diff
        self.assertTrue(booth.syllable_overflow(3, 5, "ON-STD"))   # 40% diff

    def test_on_family_within_threshold_ok(self):
        self.assertFalse(booth.syllable_overflow(5, 5, "ON"))      # 0%
        self.assertFalse(booth.syllable_overflow(6, 5, "ON"))      # 20% exactly, not >20%

    def test_non_on_lines_never_warn(self):
        # OFF / OC have free rhythm -> no lip-sync warning even on a big diff
        self.assertFalse(booth.syllable_overflow(10, 2, "OFF"))
        self.assertFalse(booth.syllable_overflow(10, 2, "OC"))
        self.assertFalse(booth.syllable_overflow(10, 2, ""))

    def test_bad_or_zero_counts_are_safe(self):
        self.assertFalse(booth.syllable_overflow("", "", "ON"))
        self.assertFalse(booth.syllable_overflow(5, 0, "ON"))
        self.assertFalse(booth.syllable_overflow("x", "y", "ON"))


class CharacterFilterTests(unittest.TestCase):
    ROWS = [
        {"KARAKTER": "Kapitány", "MAGYAR_SZOVEG": "a"},
        {"KARAKTER": "Mogyi", "MAGYAR_SZOVEG": "b"},
        {"KARAKTER": "Kapitány, Mogyi, Bryce", "MAGYAR_SZOVEG": "c"},
        {"KARAKTER": "", "MAGYAR_SZOVEG": "d"},
    ]

    def test_split_characters(self):
        self.assertEqual(booth.split_characters("Kapitány, Mogyi, Bryce"), ["Kapitány", "Mogyi", "Bryce"])
        self.assertEqual(booth.split_characters(""), [])
        self.assertEqual(booth.split_characters("  Pók  "), ["Pók"])

    def test_shared_line_belongs_to_each_speaker(self):
        self.assertTrue(booth.char_matches("Kapitány, Mogyi, Bryce", "Bryce"))
        self.assertTrue(booth.char_matches("Kapitány, Mogyi, Bryce", "Kapitány"))
        self.assertFalse(booth.char_matches("Kapitány, Mogyi", "Pók"))
        # substring must NOT false-match: "Kap" is not a full speaker
        self.assertFalse(booth.char_matches("Kapitány", "Kap"))

    def test_rows_for_character_includes_shared(self):
        kap = booth.rows_for_character(self.ROWS, "Kapitány")
        self.assertEqual([r["MAGYAR_SZOVEG"] for r in kap], ["a", "c"])

    def test_distinct_characters_sorted_deduped(self):
        self.assertEqual(booth.distinct_characters(self.ROWS), ["Bryce", "Kapitány", "Mogyi"])


class FilenameTests(unittest.TestCase):
    def test_ascii_fold(self):
        self.assertEqual(booth.ascii_fold("Kapitány"), "Kapitany")
        self.assertEqual(booth.ascii_fold("Űrkirály"), "Urkiraly")
        self.assertEqual(booth.ascii_fold("Dühöngő"), "Duhongo")

    def test_delivery_filename(self):
        self.assertEqual(
            booth.delivery_filename("EP01", "S01-003", "Kapitány"),
            "EP01_S01_003_Kapitany.wav",
        )

    def test_booth_pdf_name(self):
        self.assertEqual(booth.booth_pdf_name("EP01", "Űrkirály"), "EP01_Urkiraly_booth.pdf")


class RenderSmokeTest(unittest.TestCase):
    def test_builds_a_nonempty_pdf(self):
        rows = [
            {"GLOBAL_ID": "S01-001", "TC_IN": "00:00:01.000", "TC_OUT": "00:00:02.000",
             "DUR": "1.0", "KAMERA": "ON-KEY", "KARAKTER": "Kapitány", "SZOT_HU": "4",
             "SZOT_EN": "3", "MAGYAR_SZOVEG": "Tűz! <vág>", "DIREKCIO": "kiabál",
             "KIEJTES": "", "FORD_MEGJEGYZES": "ALT: Lőj!\nreviewer vita itt", "TAKE": "RETAKE"},
            {"GLOBAL_ID": "S01-002", "TC_IN": "00:00:03.000", "TC_OUT": "00:00:04.000",
             "DUR": "2.0", "KAMERA": "OFF", "KARAKTER": "Kapitány, Mogyi", "SZOT_HU": "5",
             "SZOT_EN": "5", "MAGYAR_SZOVEG": "Csendben.", "DIREKCIO": "", "KIEJTES": "Brajsz",
             "FORD_MEGJEGYZES": "", "TAKE": ""},
        ]
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out.pdf")
            n = booth.build_booth_pdf(rows, "Kapitány", "EP01", out)
            self.assertEqual(n, 2)
            self.assertTrue(os.path.exists(out))
            self.assertGreater(os.path.getsize(out), 1000)  # a real PDF, not empty
            with open(out, "rb") as f:
                self.assertEqual(f.read(5), b"%PDF-")


if __name__ == "__main__":
    unittest.main(verbosity=2)
