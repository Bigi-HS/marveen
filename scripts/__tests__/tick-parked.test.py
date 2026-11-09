#!/usr/bin/env python3
"""Tests: classify.py AWAITING_RE parked-marker guard -- card 41e31d7e.

Verifies that the expanded marker set (synced with heartbeat-kanban-push.py
card 7125b579) correctly parks Boss-blocked / external-trigger / credential
cards instead of driving them.

Run: python3 scripts/__tests__/tick-parked.test.py
"""
import sys
import os
import unittest

# classify.py lives in scripts/autopilot/; add it to path regardless of cwd.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "autopilot"))

from classify import classify  # noqa: E402

NOW = 1_700_000_000.0
H = 3600.0
_FRESH_H = 1.0  # well within any window


def _card(desc: str, age_h: float = _FRESH_H):
    """Minimal card owned by 'dave' with the given description."""
    return {
        "id": "test0001",
        "status": "planned",
        "assignee": "dave",
        "description": desc,
        "title": "test card",
        "last_moved": NOW - age_h * H,
        "priority": "normal",
    }


class TestParkedMarkerExpansion(unittest.TestCase):
    """Card 41e31d7e: new markers from heartbeat-kanban-push.py PARKED_RE expansion."""

    # --- NEW markers that must park a card ---

    def test_boss_block_is_parked(self):
        """A card with 'boss-block kell' must be classified as parked (not nudgeable)."""
        r = classify([_card("boss-block kell")], "dave", NOW)
        self.assertTrue(r["idle_ok"], "idle_ok should be True (card is parked, not actionable)")
        self.assertEqual(r["counts"]["parked"], 1)
        self.assertEqual(r["counts"]["mine"], 0)

    def test_external_trigger_is_parked(self):
        """A card with 'external-trigger deployed' must be classified as parked."""
        r = classify([_card("external-trigger deployed")], "dave", NOW)
        self.assertTrue(r["idle_ok"])
        self.assertEqual(r["counts"]["parked"], 1)
        self.assertEqual(r["counts"]["mine"], 0)

    def test_credential_is_parked(self):
        """A card with 'credential hianyzik' must be classified as parked."""
        r = classify([_card("credential hianyzik")], "dave", NOW)
        self.assertTrue(r["idle_ok"])
        self.assertEqual(r["counts"]["parked"], 1)
        self.assertEqual(r["counts"]["mine"], 0)

    def test_boss_decision_is_parked(self):
        """A card with 'boss.decision needed' must be classified as parked."""
        r = classify([_card("boss-decision needed")], "dave", NOW)
        self.assertTrue(r["idle_ok"])
        self.assertEqual(r["counts"]["parked"], 1)

    def test_boss_lepes_is_parked(self):
        """A card with 'boss-lepes var' must be classified as parked."""
        r = classify([_card("boss-lepes var")], "dave", NOW)
        self.assertTrue(r["idle_ok"])
        self.assertEqual(r["counts"]["parked"], 1)

    def test_boss_waiting_is_parked(self):
        """A card with 'boss_waiting' must be classified as parked."""
        r = classify([_card("boss_waiting")], "dave", NOW)
        self.assertTrue(r["idle_ok"])
        self.assertEqual(r["counts"]["parked"], 1)

    def test_repro_block_is_parked(self):
        """A card with 'repro-block' (without 'd') must be classified as parked."""
        r = classify([_card("repro-block: cannot reproduce on device")], "dave", NOW)
        self.assertTrue(r["idle_ok"])
        self.assertEqual(r["counts"]["parked"], 1)

    def test_vakacio_utan_is_parked(self):
        """A card with 'vakacio-utan' must be classified as parked."""
        r = classify([_card("vakacio-utan folytatjuk")], "dave", NOW)
        self.assertTrue(r["idle_ok"])
        self.assertEqual(r["counts"]["parked"], 1)

    # --- Existing markers must still park (regression guard) ---

    def test_awaiting_dominik_is_parked(self):
        """Pre-existing 'awaiting-dominik' still parks a card."""
        r = classify([_card("awaiting-dominik go")], "dave", NOW)
        self.assertTrue(r["idle_ok"])
        self.assertEqual(r["counts"]["parked"], 1)

    def test_deploy_gated_is_parked(self):
        """Pre-existing 'deploy-gated' still parks a card."""
        r = classify([_card("deploy-gated until Boss confirms login flip")], "dave", NOW)
        self.assertTrue(r["idle_ok"])
        self.assertEqual(r["counts"]["parked"], 1)

    # --- Non-parked card must remain nudgeable (no false-park) ---

    def test_normal_card_is_not_parked(self):
        """A card with 'implement the feature, low priority' must NOT be parked."""
        r = classify([_card("implement the feature, low priority")], "dave", NOW)
        self.assertFalse(r["idle_ok"], "card has no parked marker; agent must drive it")
        self.assertEqual(r["counts"]["mine"], 1)
        self.assertEqual(r["counts"]["parked"], 0)

    def test_bare_tg_ref_not_parked(self):
        """FLAG-2 regression: a bare TG-reference must NOT park a card."""
        r = classify([_card("TG9452 alapjan kesz")], "dave", NOW)
        self.assertFalse(r["idle_ok"])
        self.assertEqual(r["counts"]["mine"], 1)

    def test_credential_marker_expires(self):
        """A stale credential marker (age > 48h window) must expire and become MINE."""
        r = classify([_card("credential hianyzik", age_h=60)], "dave", NOW)
        # After WINDOW_AWAITING_H (48h), the marker expires -> card is MINE again.
        self.assertFalse(r["idle_ok"])
        self.assertEqual(r["counts"]["mine"], 1)
        self.assertEqual(r["counts"]["parked"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
