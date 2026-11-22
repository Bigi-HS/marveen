#!/usr/bin/env python3
"""Tests: classify.py honors the structured `parked_until` column on EVERY tick
surface -- card da838ff2 / 05c1671f (false-TICK_DRIVE root-fix).

Root cause: classify.py honored only the free-text awaiting-marker (+ age windows)
and the boss_waiting flag, but never read the `parked_until` column. A card with
parked_until=FUTURE but a stale last_moved was surfaced as MINE (owner view) or
NUDGEABLE (orchestrator view) -> repeated 15-min false-nudge churn. An explicit
parked_until in the future must suppress driving on EVERY surface, regardless of
status/age/marker, and must fall through to normal classification once it expires.

Run: python3 scripts/__tests__/parked-until.test.py
"""
import os
import sys
import unittest

# classify.py / parked.py live in scripts/autopilot/; add it to path regardless of cwd.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "autopilot"))

from classify import classify  # noqa: E402
from parked import parked_until_active, _coerce_epoch_seconds  # noqa: E402

NOW = 1_700_000_000.0  # epoch seconds
H = 3600.0
FUTURE = NOW + 30 * 24 * H   # parked 30 days out
PAST = NOW - 24 * H          # parked_until already elapsed yesterday


def _card(id="c1", assignee="dave", status="in_progress", age_h=0.0,
          parked_until=None, desc="", title="t", priority="normal", boss_waiting=0):
    """Build a card fixture; age is driven via updated_at = now - age_h."""
    c = {
        "id": id,
        "status": status,
        "assignee": assignee,
        "title": title,
        "description": desc,
        "priority": priority,
        "updated_at": NOW - age_h * H,
        "boss_waiting": boss_waiting,
    }
    if parked_until is not None:
        c["parked_until"] = parked_until
    return c


class TestParkedUntilUnit(unittest.TestCase):
    def test_future_seconds_is_active(self):
        self.assertTrue(parked_until_active({"parked_until": FUTURE}, NOW))

    def test_past_seconds_is_inactive(self):
        self.assertFalse(parked_until_active({"parked_until": PAST}, NOW))

    def test_absent_is_inactive(self):
        self.assertFalse(parked_until_active({}, NOW))
        self.assertFalse(parked_until_active({"parked_until": None}, NOW))
        self.assertFalse(parked_until_active({"parked_until": 0}, NOW))
        self.assertFalse(parked_until_active({"parked_until": ""}, NOW))

    def test_milliseconds_tolerated(self):
        # Live DB stores seconds, but an older design note labelled it "ms".
        # A future value expressed in ms must still read as active.
        self.assertTrue(parked_until_active({"parked_until": FUTURE * 1000}, NOW))
        self.assertFalse(parked_until_active({"parked_until": PAST * 1000}, NOW))

    def test_coerce_units(self):
        self.assertEqual(_coerce_epoch_seconds(FUTURE), FUTURE)
        self.assertEqual(_coerce_epoch_seconds(FUTURE * 1000), FUTURE)
        self.assertIsNone(_coerce_epoch_seconds(None))
        self.assertIsNone(_coerce_epoch_seconds(""))
        self.assertIsNone(_coerce_epoch_seconds("not-a-number"))


class TestParkedUntilMineSurface(unittest.TestCase):
    """REPRO-1: owner's stale card with a future parked_until must NOT be MINE."""

    def test_future_park_suppresses_mine(self):
        cards = [_card(assignee="dave", status="in_progress", age_h=200.0,
                       parked_until=FUTURE)]
        r = classify(cards, "dave", NOW)
        self.assertNotIn("c1", [x["id"] for x in r["mine"]])
        self.assertIn("c1", [x["id"] for x in r["parked"]])

    def test_expired_park_falls_through_to_mine(self):
        # parked_until in the past -> normal classification: stale owner card = MINE.
        cards = [_card(assignee="dave", status="planned", age_h=200.0,
                       parked_until=PAST)]
        r = classify(cards, "dave", NOW)
        self.assertIn("c1", [x["id"] for x in r["mine"]])

    def test_absent_park_unchanged(self):
        # No parked_until -> existing behavior: stale owner card = MINE (no regression).
        cards = [_card(assignee="dave", status="planned", age_h=200.0)]
        r = classify(cards, "dave", NOW)
        self.assertIn("c1", [x["id"] for x in r["mine"]])

    def test_parked_until_does_not_block_idle(self):
        # PARKED never blocks idle_ok (sec3): a lone parked-until card -> idle_ok True.
        cards = [_card(assignee="dave", status="in_progress", age_h=200.0,
                       parked_until=FUTURE)]
        r = classify(cards, "dave", NOW)
        self.assertTrue(r["idle_ok"])


class TestParkedUntilNudgeableSurface(unittest.TestCase):
    """REPRO-2: orchestrator's stale delegated card with future parked_until
    must NOT be NUDGEABLE."""

    def test_future_park_suppresses_delegated_nudge(self):
        cards = [_card(id="d1", assignee="scout", status="in_progress", age_h=200.0,
                       parked_until=FUTURE)]
        r = classify(cards, "marveen", NOW, orchestrator="marveen")
        self.assertNotIn("d1", [x["id"] for x in r["nudgeable"]])
        self.assertIn("d1", [x["id"] for x in r["parked"]])

    def test_expired_park_delegated_nudges_again(self):
        cards = [_card(id="d1", assignee="scout", status="in_progress", age_h=200.0,
                       parked_until=PAST)]
        r = classify(cards, "marveen", NOW, orchestrator="marveen")
        self.assertIn("d1", [x["id"] for x in r["nudgeable"]])

    def test_non_owner_non_orchestrator_ignores_parked_peer_card(self):
        # dave is neither owner (scout) nor orchestrator -> card invisible to dave.
        cards = [_card(id="d1", assignee="scout", status="in_progress", age_h=200.0,
                       parked_until=FUTURE)]
        r = classify(cards, "dave", NOW, orchestrator="marveen")
        all_ids = [x["id"] for x in r["mine"] + r["nudgeable"] + r["parked"]]
        self.assertNotIn("d1", all_ids)


if __name__ == "__main__":
    unittest.main(verbosity=2)
