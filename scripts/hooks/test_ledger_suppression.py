#!/usr/bin/env python3
"""Dedup lock-test for the memory-continuity S3 checkpoint <-> ledger overlap.

The checkpoint-replay path and the ledger-replay hook BOTH carry the most-recent
turns. On a crash-resume they must NOT stack. The coordination is a one-boot
FS marker store/agent-checkpoints/<agent>.ledger-suppressed, stamped by the
checkpoint path when it injected the recent-turns window; ledger-replay.py
CONSUMES it and skips its own transcript window for THAT boot.

This test verifies the ledger-side of the contract directly (no live dashboard):
  - _suppress_marker_path resolves under store/agent-checkpoints/<agent>.*
  - _consume_ledger_suppressed returns True AND deletes the marker (one-boot)
  - a second call after consume returns False (single boot only)
  - fail-open: no marker / no agent -> False (window replays as before)

Run: python3 scripts/hooks/test_ledger_suppression.py
"""
import importlib.util
import os
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPLAY_HOOK = os.path.join(_HERE, "ledger-replay.py")


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod = _load(_REPLAY_HOOK, "ledger_replay")


class LedgerSuppressionContract(unittest.TestCase):
    def test_marker_path_is_under_agent_checkpoints(self):
        p = mod._suppress_marker_path("avery")
        self.assertTrue(p.endswith(os.path.join("agent-checkpoints", "avery.ledger-suppressed")))

    def test_marker_path_sanitizes_agent(self):
        p = mod._suppress_marker_path("../../etc/passwd")
        # path traversal chars stripped -> a bare filename in the store dir
        self.assertTrue(p.endswith(os.path.join("agent-checkpoints", "etcpasswd.ledger-suppressed")))

    def test_no_marker_is_not_suppressed(self):
        self.assertFalse(mod._consume_ledger_suppressed("no-such-agent-xyz"))

    def test_none_agent_is_not_suppressed(self):
        self.assertFalse(mod._consume_ledger_suppressed(None))
        self.assertFalse(mod._consume_ledger_suppressed(""))

    def test_consume_is_one_boot_only(self):
        # Point the resolver at a temp marker by monkeypatching the path fn.
        with tempfile.TemporaryDirectory() as d:
            marker = os.path.join(d, "tester.ledger-suppressed")
            orig = mod._suppress_marker_path
            mod._suppress_marker_path = lambda a: marker
            try:
                open(marker, "w").close()
                # first boot: suppressed AND marker deleted
                self.assertTrue(mod._consume_ledger_suppressed("tester"))
                self.assertFalse(os.path.exists(marker))
                # second boot: no marker -> not suppressed (window replays again)
                self.assertFalse(mod._consume_ledger_suppressed("tester"))
            finally:
                mod._suppress_marker_path = orig


if __name__ == "__main__":
    unittest.main(verbosity=2)
