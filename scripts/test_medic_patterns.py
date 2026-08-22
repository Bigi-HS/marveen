#!/usr/bin/env python3
"""Tests for Medic's diagnose -- the ordered known-failure-signature matcher.

Pure unit tests over SYNTHETIC HealthSnapshots: no live system, no executor
needed (diagnose is a pure function of the snapshot).

Run: python3 scripts/test_medic_patterns.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import patterns  # noqa: E402
from medic.patterns import diagnose  # noqa: E402
from medic.types import HealthSnapshot  # noqa: E402

NOW = 1780916754.0

# Every cause diagnose may return, mapped to the dispatch allowlist verbs its
# fix_command must start with (guards that no fix is a free-form/shell string).
VALID_VERBS = {
    "status", "diagnose", "restart", "restart-telegram", "mcp",
    "token-refresh", "login-link",
}


def healthy_snap(**over) -> HealthSnapshot:
    """A baseline all-green snapshot; tests override individual fields."""
    snap = HealthSnapshot(
        now=NOW,
        sessions={"marveen": True, "dave": True, "thor": True},
        token_expires_at=NOW + 3600.0,        # an hour of headroom
        token_refreshed_age_sec=120.0,
        keepalive_age_sec=30.0,
        watchdogs={"dave": True},
        pipe_alive={"dave": True, "thor": True},
        stuck_messages=0,
        log_errors=[],
    )
    for k, v in over.items():
        setattr(snap, k, v)
    return snap


class HealthyAndUnknownTests(unittest.TestCase):
    def test_all_green_is_healthy(self):
        dx = diagnose(healthy_snap())
        self.assertEqual(dx.cause, "healthy")
        self.assertEqual(dx.fix_command, "status")

    def test_empty_snapshot_is_unknown(self):
        # Default HealthSnapshot: no token, no sessions -> too sparse.
        dx = diagnose(HealthSnapshot(now=NOW))
        self.assertEqual(dx.cause, "unknown")

    def test_token_known_but_no_sessions_is_unknown(self):
        # One core signal missing -> cannot claim healthy.
        snap = HealthSnapshot(now=NOW, token_expires_at=NOW + 3600.0)
        self.assertEqual(diagnose(snap).cause, "unknown")


class TokenExpiredTests(unittest.TestCase):
    def test_expired_token_by_time(self):
        dx = diagnose(healthy_snap(token_expires_at=NOW - 1.0))
        self.assertEqual(dx.cause, "token_expired")
        self.assertEqual(dx.fix_command, "token-refresh")

    def test_token_expiring_exactly_now_counts(self):
        dx = diagnose(healthy_snap(token_expires_at=NOW))  # expires_in == 0
        self.assertEqual(dx.cause, "token_expired")

    def test_oauth_log_signature_triggers_token_expired(self):
        # Token clock looks fine, but the log signature still wins.
        dx = diagnose(healthy_snap(log_errors=["oauth_expired"]))
        self.assertEqual(dx.cause, "token_expired")
        self.assertEqual(dx.fix_command, "token-refresh")

    def test_token_outranks_a_dead_session(self):
        # Both a dead token AND a dead session present: token wins (fleet-wide).
        snap = healthy_snap(
            token_expires_at=NOW - 5.0,
            sessions={"marveen": True, "dave": False},
        )
        self.assertEqual(diagnose(snap).cause, "token_expired")


class SessionCrashTests(unittest.TestCase):
    def test_dead_session_yields_restart_of_that_agent(self):
        snap = healthy_snap(sessions={"marveen": True, "dave": False, "thor": True})
        dx = diagnose(snap)
        self.assertEqual(dx.cause, "session_crash")
        self.assertEqual(dx.fix_command, "restart dave")

    def test_dead_session_target_is_deterministic(self):
        # Two dead sessions -> sorted order picks 'chad' before 'dave'.
        snap = healthy_snap(sessions={"chad": False, "dave": False, "thor": True})
        self.assertEqual(diagnose(snap).fix_command, "restart chad")

    def test_session_crash_log_sig_without_named_session(self):
        snap = healthy_snap(log_errors=["session_crash"])
        dx = diagnose(snap)
        self.assertEqual(dx.cause, "session_crash")
        self.assertEqual(dx.fix_command, "status")  # no specific target

    def test_session_crash_outranks_pipe_dead(self):
        snap = healthy_snap(
            sessions={"marveen": True, "dave": False},
            pipe_alive={"thor": False},
        )
        self.assertEqual(diagnose(snap).cause, "session_crash")


class PipeDeadTests(unittest.TestCase):
    def test_dead_pipe_yields_mcp_of_that_agent(self):
        snap = healthy_snap(pipe_alive={"dave": True, "thor": False})
        dx = diagnose(snap)
        self.assertEqual(dx.cause, "pipe_dead")
        self.assertEqual(dx.fix_command, "mcp thor")

    def test_dead_pipe_target_is_deterministic(self):
        snap = healthy_snap(pipe_alive={"thor": False, "dave": False})
        self.assertEqual(diagnose(snap).fix_command, "mcp dave")  # sorted

    def test_pipe_closed_log_sig_without_pipe_map(self):
        snap = healthy_snap(pipe_alive={}, log_errors=["pipe_closed"])
        dx = diagnose(snap)
        self.assertEqual(dx.cause, "pipe_dead")
        self.assertEqual(dx.fix_command, "status")

    def test_empty_pipe_map_does_not_false_positive(self):
        # No pipe signal at all must NOT read as a dead pipe.
        snap = healthy_snap(pipe_alive={})
        self.assertEqual(diagnose(snap).cause, "healthy")


class WedgedTests(unittest.TestCase):
    def test_stuck_messages_with_live_sessions_is_wedged(self):
        snap = healthy_snap(stuck_messages=4)
        dx = diagnose(snap)
        self.assertEqual(dx.cause, "wedged")
        self.assertEqual(dx.fix_command, "restart genesis")

    def test_stuck_messages_but_a_dead_session_is_session_crash(self):
        # A crashed session outranks the softer wedge signal.
        snap = healthy_snap(
            stuck_messages=4,
            sessions={"marveen": True, "dave": False},
        )
        self.assertEqual(diagnose(snap).cause, "session_crash")

    def test_zero_stuck_is_not_wedged(self):
        self.assertEqual(diagnose(healthy_snap(stuck_messages=0)).cause, "healthy")


class ContractInvariantsTests(unittest.TestCase):
    """Properties that must hold for EVERY diagnosis, across the table."""

    SNAPSHOTS = None

    def setUp(self):
        self.SNAPSHOTS = [
            HealthSnapshot(now=NOW),                                  # unknown
            healthy_snap(),                                           # healthy
            healthy_snap(token_expires_at=NOW - 1.0),                # token_expired
            healthy_snap(log_errors=["oauth_expired"]),              # token_expired
            healthy_snap(sessions={"marveen": True, "dave": False}), # session_crash
            healthy_snap(log_errors=["session_crash"]),              # session_crash
            healthy_snap(pipe_alive={"dave": False}),                # pipe_dead
            healthy_snap(pipe_alive={}, log_errors=["pipe_closed"]), # pipe_dead
            healthy_snap(stuck_messages=2),                          # wedged
        ]

    def test_cause_is_always_in_the_known_set(self):
        known = {"token_expired", "pipe_dead", "session_crash",
                 "wedged", "healthy", "unknown"}
        for snap in self.SNAPSHOTS:
            self.assertIn(diagnose(snap).cause, known)

    def test_fix_command_is_always_an_allowlist_verb(self):
        for snap in self.SNAPSHOTS:
            fix = diagnose(snap).fix_command
            self.assertTrue(fix, "fix_command must be non-empty")
            self.assertIn(fix.split()[0], VALID_VERBS, fix)

    def test_fix_command_has_no_shell_metacharacters(self):
        for snap in self.SNAPSHOTS:
            fix = diagnose(snap).fix_command
            self.assertNotRegex(fix, r"[;&|`$()<>'\"\\]")

    def test_detail_carries_no_raw_log_text(self):
        # detail must be a human sentence, never the raw signature code echoed.
        for snap in self.SNAPSHOTS:
            self.assertTrue(diagnose(snap).detail)

    def test_diagnose_is_pure_and_repeatable(self):
        for snap in self.SNAPSHOTS:
            self.assertEqual(diagnose(snap), diagnose(snap))


if __name__ == "__main__":
    unittest.main(verbosity=2)
