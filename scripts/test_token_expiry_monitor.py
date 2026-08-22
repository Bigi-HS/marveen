#!/usr/bin/env python3
"""Unit tests for scripts/token-expiry-monitor.py.

Pure: no Telegram, no disk, no medic import. The monitor's decision core takes an
injected sender + persist, and reads a plain status dict, so every escalation path is
testable in isolation. Run: python3 -m pytest scripts/test_token_expiry_monitor.py
(or python3 scripts/test_token_expiry_monitor.py for the unittest runner).
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, "token-expiry-monitor.py")
_spec = importlib.util.spec_from_file_location("token_expiry_monitor", _MOD_PATH)
mon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mon)

NOW = 1_780_000_000.0  # fixed clock; no Date.now flakiness


def status(present=True, valid=True, remaining=100.0, expired=False):
    return {
        "present": present,
        "valid_shape": valid,
        "expires_in_days": remaining,
        "expired": expired,
    }


class ClassifyTests(unittest.TestCase):
    def test_healthy_far_out(self):
        self.assertEqual(mon.classify(status(remaining=100))[0], mon.LEVEL_HEALTHY)

    def test_just_above_first_threshold_is_healthy(self):
        self.assertEqual(mon.classify(status(remaining=21.5))[0], mon.LEVEL_HEALTHY)

    def test_21_day_threshold(self):
        level, label = mon.classify(status(remaining=20))
        self.assertEqual(level, 1)
        self.assertEqual(label, "21d")

    def test_7_day_threshold(self):
        level, label = mon.classify(status(remaining=5))
        self.assertEqual(level, 3)
        self.assertEqual(label, "7d")

    def test_1_day_threshold(self):
        level, label = mon.classify(status(remaining=0.5))
        self.assertEqual(level, 5)
        self.assertEqual(label, "1d")

    def test_expired_by_remaining(self):
        self.assertEqual(mon.classify(status(remaining=-2))[0], mon.LEVEL_EXPIRED)

    def test_expired_by_flag(self):
        self.assertEqual(
            mon.classify(status(remaining=0, expired=True))[0], mon.LEVEL_EXPIRED
        )

    def test_missing(self):
        self.assertEqual(mon.classify(status(present=False))[0], mon.LEVEL_MISSING)

    def test_malformed(self):
        self.assertEqual(mon.classify(status(valid=False))[0], mon.LEVEL_MISSING)

    def test_present_but_age_unknown_is_healthy(self):
        # No mtime -> remaining None -> don't cry wolf.
        self.assertEqual(mon.classify(status(remaining=None))[0], mon.LEVEL_HEALTHY)


class EscalationLogicTests(unittest.TestCase):
    def test_alert_on_escalation(self):
        self.assertTrue(mon.should_alert(3, 1))

    def test_no_alert_same_level(self):
        self.assertFalse(mon.should_alert(3, 3))

    def test_no_alert_lower_severity(self):
        # remaining grew (e.g. clock skew) -> current less severe -> no alert
        self.assertFalse(mon.should_alert(1, 3))

    def test_no_alert_when_healthy(self):
        self.assertFalse(mon.should_alert(mon.LEVEL_HEALTHY, mon.LEVEL_HEALTHY))

    def test_reset_after_alert(self):
        self.assertTrue(mon.should_reset(mon.LEVEL_HEALTHY, 3))

    def test_no_reset_when_never_alerted(self):
        self.assertFalse(mon.should_reset(mon.LEVEL_HEALTHY, mon.LEVEL_HEALTHY))


class _Spy:
    def __init__(self, send_ok=True):
        self.sent = []
        self.persisted = []
        self.send_ok = send_ok

    def sender(self, text):
        self.sent.append(text)
        return self.send_ok

    def persist(self, level, label, now):
        self.persisted.append((level, label, now))


class DecideTests(unittest.TestCase):
    def test_first_cross_alerts_and_persists(self):
        spy = _Spy()
        r = mon.decide(status(remaining=20), {"level": 0}, NOW, spy.sender, spy.persist)
        self.assertEqual(r, "alerted")
        self.assertEqual(len(spy.sent), 1)
        self.assertEqual(spy.persisted[0][0], 1)

    def test_same_level_is_noop(self):
        spy = _Spy()
        r = mon.decide(status(remaining=18), {"level": 1}, NOW, spy.sender, spy.persist)
        self.assertEqual(r, "noop")
        self.assertEqual(spy.sent, [])
        self.assertEqual(spy.persisted, [])

    def test_deeper_level_re_alerts(self):
        spy = _Spy()
        r = mon.decide(status(remaining=5), {"level": 1}, NOW, spy.sender, spy.persist)
        self.assertEqual(r, "alerted")
        self.assertEqual(spy.persisted[0][0], 3)

    def test_expired_alerts(self):
        spy = _Spy()
        r = mon.decide(status(remaining=-1, expired=True), {"level": 5}, NOW,
                       spy.sender, spy.persist)
        self.assertEqual(r, "alerted")
        self.assertIn("LEJART", spy.sent[0])

    def test_missing_alerts(self):
        spy = _Spy()
        r = mon.decide(status(present=False), {"level": 0}, NOW, spy.sender, spy.persist)
        self.assertEqual(r, "alerted")
        self.assertIn("HIANYZIK", spy.sent[0])

    def test_reset_sends_all_clear(self):
        spy = _Spy()
        r = mon.decide(status(remaining=300), {"level": 3}, NOW, spy.sender, spy.persist)
        self.assertEqual(r, "reset")
        self.assertEqual(spy.persisted[0][0], mon.LEVEL_HEALTHY)
        self.assertIn("all-clear", spy.sent[0])

    def test_failed_send_does_not_persist(self):
        # The key robustness property: a send failure must NOT mark the level done,
        # so the next cron run retries.
        spy = _Spy(send_ok=False)
        r = mon.decide(status(remaining=5), {"level": 0}, NOW, spy.sender, spy.persist)
        self.assertEqual(r, "alert-failed")
        self.assertEqual(spy.persisted, [])


class MessageTests(unittest.TestCase):
    def test_no_em_dash_anywhere(self):
        for st, lvl in [
            (status(remaining=5), 3),
            (status(remaining=-1, expired=True), mon.LEVEL_EXPIRED),
            (status(present=False), mon.LEVEL_MISSING),
        ]:
            self.assertNotIn("—", mon.build_message(lvl, st, NOW))

    def test_warning_has_setup_token_instruction(self):
        msg = mon.build_message(3, status(remaining=5), NOW)
        self.assertIn("claude setup-token", msg)

    def test_warning_has_day_count(self):
        msg = mon.build_message(3, status(remaining=5), NOW)
        self.assertIn("5 nap", msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
