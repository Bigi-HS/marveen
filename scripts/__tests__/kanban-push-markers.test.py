#!/usr/bin/env python3
"""Unit tests for PARKED_RE in heartbeat-kanban-push.py.

Verifies that:
  - each new boss-blocker pattern triggers the guard (is_blocked -> True)
  - a clean description does not over-match (is_blocked -> False)

Run: python3 scripts/__tests__/kanban-push-markers.test.py
"""
import re
import sys
import unittest

# Replicate the regex exactly as defined in heartbeat-kanban-push.py so this
# test acts as a regression guard for the pattern itself.
PARKED_RE = re.compile(
    r"awaiting|do-?not-?nudge|parked|Boss-?oldali|Boss-?GO|Boss-?BLOCK|boss.?lepes|boss.?decision|"
    r"vak[aá]ci|vakacio.?utan|nyaral[aá]s|visszat[eé]r|OAuth-consent|unblock|TG\d|deploy-gated|"
    r"awaiting-dominik|external.trigger|repro.?block|credential|boss_waiting",
    re.I,
)


def is_blocked(desc: str) -> bool:
    """Return True if desc contains a parked/blocked marker."""
    return bool(PARKED_RE.search(desc))


class TestExistingPatterns(unittest.TestCase):
    """Regression: patterns that existed before the expansion must still match."""

    def test_awaiting(self):
        self.assertTrue(is_blocked("awaiting boss response"))

    def test_do_not_nudge(self):
        self.assertTrue(is_blocked("do-not-nudge this card"))

    def test_parked(self):
        self.assertTrue(is_blocked("parked until sprint 3"))

    def test_boss_go(self):
        self.assertTrue(is_blocked("Boss-GO kell ehhez"))

    def test_deploy_gated(self):
        self.assertTrue(is_blocked("deploy-gated waiting for prod"))

    def test_awaiting_dominik(self):
        self.assertTrue(is_blocked("awaiting-dominik döntés"))

    def test_tg_ref(self):
        self.assertTrue(is_blocked("related to TG9811 discussion"))


class TestNewBossBlockerPatterns(unittest.TestCase):
    """New patterns added in this PR must trigger the guard."""

    def test_boss_block_hyphen(self):
        self.assertTrue(is_blocked("boss-block kell"))

    def test_boss_block_case_insensitive(self):
        self.assertTrue(is_blocked("Boss-BLOCKED until Monday"))

    def test_boss_block_no_separator(self):
        self.assertTrue(is_blocked("bossblock nincs szabad sáv"))

    def test_boss_lepes_hyphen(self):
        self.assertTrue(is_blocked("boss-lepes var"))

    def test_boss_lepes_no_separator(self):
        self.assertTrue(is_blocked("bosslepes kell ehhez"))

    def test_boss_decision(self):
        self.assertTrue(is_blocked("boss.decision pending"))

    def test_boss_decision_no_dot(self):
        self.assertTrue(is_blocked("boss-decision nincs"))

    def test_external_trigger(self):
        self.assertTrue(is_blocked("external-trigger deployed"))

    def test_external_trigger_dot(self):
        self.assertTrue(is_blocked("external.trigger event needed"))

    def test_repro_blocked_hyphen(self):
        self.assertTrue(is_blocked("repro-blocked nem reprodukálható"))

    def test_repro_blocked_no_separator(self):
        self.assertTrue(is_blocked("repro_blocked confirmed"))

    def test_credential(self):
        self.assertTrue(is_blocked("credential hianyzik a deployhoz"))

    def test_credential_plural(self):
        self.assertTrue(is_blocked("credentials expired"))

    def test_vakacio_utan(self):
        self.assertTrue(is_blocked("vakacio-utan folytatjuk"))

    def test_vakacio_utan_no_separator(self):
        self.assertTrue(is_blocked("vakacioutan indul a sprint"))

    def test_boss_waiting_eq(self):
        self.assertTrue(is_blocked("boss_waiting=1"))

    def test_boss_waiting_plain(self):
        self.assertTrue(is_blocked("boss_waiting flag is set"))


class TestNoOvermatch(unittest.TestCase):
    """Clean descriptions must NOT be flagged as blocked."""

    def test_clean_simple(self):
        self.assertFalse(is_blocked("implement the feature"))

    def test_clean_long(self):
        self.assertFalse(is_blocked(
            "Extend the marker regex to include new blocker patterns "
            "identified in the lesson file. Add unit tests. No external deps."
        ))

    def test_clean_code_comment(self):
        self.assertFalse(is_blocked("# fix off-by-one in scheduler loop"))

    def test_clean_assignee_name(self):
        self.assertFalse(is_blocked("in_progress dave: build kanban endpoint"))


if __name__ == "__main__":
    result = unittest.main(verbosity=2, exit=False)
    sys.exit(0 if result.result.wasSuccessful() else 1)
