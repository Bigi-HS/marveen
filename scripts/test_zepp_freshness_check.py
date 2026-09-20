#!/usr/bin/env python3
"""Unit tests for scripts/zepp-freshness-check.py (WELL-022, card 7e1f6628).

Pure: no Telegram, no HTTP, no disk. The poller's decision core (decide) reads a
plain freshness dict + prior state and returns a verdict; the dead-man core
(deadman_verdict) reads the poller's own heartbeat. Both are injected/pure so every
surfacing and silence path is testable in isolation.

Run: python3 scripts/test_zepp_freshness_check.py
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, "zepp-freshness-check.py")
_spec = importlib.util.spec_from_file_location("zepp_freshness_check", _MOD_PATH)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

NOW = 1_780_000_000  # fixed clock
SUPPRESS = 6 * 3600  # 6h re-alert suppression
DEADMAN = 75 * 60    # 75 min (2.5 missed 30-min ticks)


def fresh(alert=False, reason=None, sync_age=2.0, latest="2026-09-20",
          synced="2026-09-20T09:20:00Z", quiet=False):
    return {
        "alert": alert,
        "alertReason": reason,
        "syncAgeHours": sync_age,
        "latestDate": latest,
        "sourceSyncedAt": synced,
        "inQuietWindow": quiet,
        "thresholdHours": 8,
    }


class DecideTests(unittest.TestCase):
    def test_fresh_no_alert_is_ok(self):
        v = mod.decide(fresh(alert=False), {}, NOW, SUPPRESS)
        self.assertEqual(v["action"], "ok")

    def test_ok_clears_prior_alert_marker(self):
        # a healthy poll must let a later real gap alert again (no stale suppression)
        state = {"last_alert": NOW - 100}
        v = mod.decide(fresh(alert=False), state, NOW, SUPPRESS)
        self.assertEqual(v["action"], "ok")
        self.assertTrue(v["clear_alert"])

    def test_stale_alert_surfaces_with_reason(self):
        reason = "Zepp data stale: 36.0h since last sync (threshold 8h)."
        v = mod.decide(fresh(alert=True, reason=reason, sync_age=36.0), {}, NOW, SUPPRESS)
        self.assertEqual(v["action"], "alert")
        self.assertIn("stale", v["content"].lower())
        self.assertIn("36", v["content"])

    def test_repeat_alert_within_window_is_suppressed(self):
        state = {"last_alert": NOW - 3600}  # alerted 1h ago, within 6h window
        v = mod.decide(fresh(alert=True, reason="x", sync_age=40.0), state, NOW, SUPPRESS)
        self.assertEqual(v["action"], "suppressed")

    def test_alert_again_after_suppress_window_expires(self):
        state = {"last_alert": NOW - (SUPPRESS + 60)}
        v = mod.decide(fresh(alert=True, reason="x", sync_age=40.0), state, NOW, SUPPRESS)
        self.assertEqual(v["action"], "alert")

    def test_missing_sync_timestamp_still_alerts(self):
        # endpoint drives alert=True when sourceSyncedAt is null; poller surfaces it
        v = mod.decide(fresh(alert=True, reason="no sync timestamp", sync_age=None,
                             synced=None), {}, NOW, SUPPRESS)
        self.assertEqual(v["action"], "alert")

    def test_malformed_response_is_fail_safe_alert(self):
        # a response missing 'alert' must NOT be read as fresh -- surface it
        v = mod.decide({"latestDate": "2026-09-20"}, {}, NOW, SUPPRESS)
        self.assertEqual(v["action"], "alert")
        self.assertIn("unparseable", v["content"].lower())


class DeadmanTests(unittest.TestCase):
    def test_first_run_no_heartbeat_is_not_silent(self):
        v = mod.deadman_verdict({}, NOW, DEADMAN)
        self.assertFalse(v["silent"])

    def test_recent_heartbeat_is_alive(self):
        state = {"last_ok_run": NOW - 1800}  # 30 min ago -> within deadman
        v = mod.deadman_verdict(state, NOW, DEADMAN)
        self.assertFalse(v["silent"])

    def test_stale_heartbeat_is_silent(self):
        state = {"last_ok_run": NOW - (DEADMAN + 60)}
        v = mod.deadman_verdict(state, NOW, DEADMAN)
        self.assertTrue(v["silent"])
        self.assertGreaterEqual(v["silent_seconds"], DEADMAN)

    def test_deadman_suppressed_within_window(self):
        # once the silence is reported, don't re-report every tick
        state = {"last_ok_run": NOW - (DEADMAN + 60), "last_deadman_alert": NOW - 60}
        v = mod.deadman_verdict(state, NOW, DEADMAN, suppress_seconds=SUPPRESS)
        self.assertTrue(v["silent"])
        self.assertTrue(v["suppressed"])


if __name__ == "__main__":
    unittest.main()
