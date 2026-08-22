#!/usr/bin/env python3
"""Tests for Medic's `status` handler -- read-only health summary for Boss.

Run: python3 scripts/test_medic_handlers_status.py

The handler reuses probe_tmux.collect + probe_token.collect. Those are real
modules (stubs on eng/medic-base), so each test monkeypatches their `collect`
with a synthetic return value -- no live system, deterministic output. The token
expiry is asserted to render in Europe/Budapest local time and to NEVER leak a
token value (the probe only ever exposes the numeric expiry anyway).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import handlers_status, probe_tmux, probe_token  # noqa: E402
from medic.types import ExecResult, HandlerContext, Reply  # noqa: E402

# 2026-06-08 13:05:54 Europe/Budapest == this epoch (CEST, UTC+2).
NOW = 1780916754.0
# 2026-06-08 20:57 Europe/Budapest == this epoch; ~7.85h after NOW.
TOKEN_EXP = 1780945020.0


class FakeExecutor:
    """Minimal Executor; deterministic now(), never touches the real system.

    Mirrors the FakeExecutor in test_medic_dispatch.py. The status handler only
    calls ex.now() directly (the probes are monkeypatched), but run/read_text are
    provided so a regression that starts touching the system is caught loudly.
    """
    def __init__(self, now=NOW):
        self._now = now
        self.calls = []

    def run(self, argv, timeout=30.0):
        self.calls.append(list(argv))
        return ExecResult(0, "", "")

    def read_text(self, path):
        self.calls.append(["read_text", path])
        return None

    def write_text(self, path, content, mode=0o600):
        raise AssertionError("status is read-only; write_text must never be called")

    def path_mtime(self, path):
        return None

    def query(self, sql, params=()):
        return []

    def now(self):
        return self._now


class StatusHandlerTests(unittest.TestCase):
    def setUp(self):
        # Save + restore the real probe collect() around each test.
        self._tmux = probe_tmux.collect
        self._token = probe_token.collect
        self.addCleanup(lambda: setattr(probe_tmux, "collect", self._tmux))
        self.addCleanup(lambda: setattr(probe_token, "collect", self._token))

    def _patch(self, sessions, token):
        probe_tmux.collect = lambda ex: {"sessions": sessions} if sessions is not None else {}
        probe_token.collect = lambda ex: token

    def _run(self, sessions, token, now=NOW):
        self._patch(sessions, token)
        return handlers_status.handle(HandlerContext(ex=FakeExecutor(now)))

    # --- happy path -------------------------------------------------------- #
    def test_all_alive_with_token_expiry(self):
        sessions = {f"agent-a{i}": True for i in range(16)}
        reply = self._run(sessions, {"token_expires_at": TOKEN_EXP,
                                     "token_refreshed_age_sec": 60.0})
        self.assertIsInstance(reply, Reply)
        self.assertIn("16/16 session el", reply.text)
        # Europe/Budapest local rendering (CEST), not UTC.
        self.assertIn("2026-06-08 20:57", reply.text)
        self.assertIn("~7.9h", reply.text)  # ~7.85h rounds to 7.9

    def test_local_time_is_budapest_not_utc(self):
        # 20:57 local == 18:57 UTC; the UTC string must NOT appear.
        reply = self._run({"agent-dave": True},
                          {"token_expires_at": TOKEN_EXP})
        self.assertIn("2026-06-08 20:57", reply.text)
        self.assertNotIn("18:57", reply.text)

    # --- degraded sessions ------------------------------------------------- #
    def test_some_sessions_dead_are_named(self):
        sessions = {"agent-dave": True, "agent-thor": False, "marveen": True}
        reply = self._run(sessions, {"token_expires_at": TOKEN_EXP})
        self.assertIn("2/3 session el", reply.text)
        self.assertIn("halott: agent-thor", reply.text)
        self.assertNotIn("agent-dave", reply.text.split("halott")[1])

    # --- unknown / empty probe data (stub base, or a probe that failed) ----- #
    def test_empty_probes_degrade_gracefully(self):
        reply = self._run({}, {})  # both probes returned nothing useful
        self.assertIsInstance(reply, Reply)
        self.assertIn("session-allapot ismeretlen", reply.text)
        self.assertIn("Fo token lejarat ismeretlen", reply.text)

    def test_unknown_token_only(self):
        reply = self._run({"agent-dave": True}, {})
        self.assertIn("1/1 session el", reply.text)
        self.assertIn("Fo token lejarat ismeretlen", reply.text)

    # --- expired token ----------------------------------------------------- #
    def test_expired_token_flagged(self):
        past = NOW - 3600.0  # expired an hour ago
        reply = self._run({"agent-dave": True}, {"token_expires_at": past})
        self.assertIn("LEJART", reply.text)
        self.assertNotIn("~", reply.text)  # no positive remaining-hours figure

    # --- security / read-only guarantees ----------------------------------- #
    def test_handler_never_writes(self):
        # FakeExecutor.write_text raises; reaching it would fail the test.
        self._run({"agent-dave": True}, {"token_expires_at": TOKEN_EXP})

    def test_token_value_never_surfaced(self):
        # The probe contract only exposes numeric expiry, but assert the handler
        # never echoes anything resembling a token even if a probe misbehaved by
        # adding extra keys.
        probe_tmux.collect = lambda ex: {"sessions": {"agent-dave": True}}
        probe_token.collect = lambda ex: {
            "token_expires_at": TOKEN_EXP,
            "token_value": "sk-ant-SECRET-DEADBEEF",  # rogue extra key
        }
        reply = handlers_status.handle(HandlerContext(ex=FakeExecutor()))
        self.assertNotIn("SECRET", reply.text)
        self.assertNotIn("sk-ant", reply.text)

    def test_probe_returning_none_is_tolerated(self):
        # health.collect tolerates a probe returning None; so must we.
        probe_tmux.collect = lambda ex: None
        probe_token.collect = lambda ex: None
        reply = handlers_status.handle(HandlerContext(ex=FakeExecutor()))
        self.assertIsInstance(reply, Reply)
        self.assertIn("session-allapot ismeretlen", reply.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
