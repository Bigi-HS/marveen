#!/usr/bin/env python3
"""Unit tests for scripts/model-switch-detect.py -- pure decide() core only.

No network, no disk, no dashboard token required.
Run: python3 -m pytest scripts/test_model_switch_detect.py -v
  or: python3 scripts/test_model_switch_detect.py
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, "model-switch-detect.py")
_spec = importlib.util.spec_from_file_location("model_switch_detect", _MOD_PATH)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


class DecideTests(unittest.TestCase):

    # --- first run (no prior record) ---

    def test_first_run_no_stored(self):
        v = mod.decide("claude-sonnet-4-6", None)
        self.assertEqual(v["action"], "first_run")
        self.assertIsNone(v["old"])
        self.assertEqual(v["new"], "claude-sonnet-4-6")

    def test_first_run_message_contains_model(self):
        v = mod.decide("claude-opus-4-8", None)
        self.assertIn("claude-opus-4-8", v["message"])

    # --- no change ---

    def test_same_model_is_ok(self):
        v = mod.decide("claude-sonnet-4-6", "claude-sonnet-4-6")
        self.assertEqual(v["action"], "ok")

    def test_same_model_message_contains_ok(self):
        v = mod.decide("claude-haiku-4-5", "claude-haiku-4-5")
        self.assertIn("OK", v["message"])
        self.assertIn("claude-haiku-4-5", v["message"])

    # --- switch ---

    def test_model_switch_detected(self):
        v = mod.decide("claude-opus-4-8", "claude-sonnet-4-6")
        self.assertEqual(v["action"], "switch")

    def test_switch_records_old_and_new(self):
        v = mod.decide("claude-opus-4-8", "claude-sonnet-4-6")
        self.assertEqual(v["old"], "claude-sonnet-4-6")
        self.assertEqual(v["new"], "claude-opus-4-8")

    def test_switch_message_contains_both_models(self):
        v = mod.decide("claude-opus-4-8", "claude-sonnet-4-6")
        self.assertIn("MODEL_SWITCH", v["message"])
        self.assertIn("claude-sonnet-4-6", v["message"])
        self.assertIn("claude-opus-4-8", v["message"])

    def test_downgrade_also_switch(self):
        v = mod.decide("claude-haiku-4-5", "claude-opus-4-8")
        self.assertEqual(v["action"], "switch")
        self.assertIn("MODEL_SWITCH", v["message"])

    # --- edge cases ---

    def test_empty_string_model_switch(self):
        # An empty model field should still trigger a switch vs a valid stored value
        v = mod.decide("", "claude-sonnet-4-6")
        self.assertEqual(v["action"], "switch")

    def test_same_empty_model_is_ok(self):
        v = mod.decide("", "")
        self.assertEqual(v["action"], "ok")

    def test_first_run_exit_code_semantics(self):
        # first_run -> exit 0 (not a switch -- just initialise)
        v = mod.decide("claude-sonnet-4-6", None)
        self.assertNotEqual(v["action"], "switch")

    def test_switch_exit_code_semantics(self):
        # switch -> exit 1
        v = mod.decide("claude-opus-4-8", "claude-sonnet-4-6")
        self.assertEqual(v["action"], "switch")


if __name__ == "__main__":
    unittest.main()
