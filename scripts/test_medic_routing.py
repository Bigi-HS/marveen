#!/usr/bin/env python3
"""Tests for Medic's alert-routing classifier (card 79b206b1).

The routing layer so Boss NEVER receives a raw busy-FAIL. It ingests a monitor/
scheduler Alert, CLASSIFIES it into one of three classes, ROUTES it to a pure
action descriptor, and (at the edge) DISPATCHES the IO for non-SILENT actions.

classify() and route() are PURE; dispatch() does the single send at the edge via
the injected Executor's run(argv) -- argv lists only, never a shell string. These
tests feed a FakeExecutor and assert the class, the action descriptor, and that
the edge performs exactly the right number of sends to the right recipient.

Run: python3 scripts/test_medic_routing.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import routing  # noqa: E402
from medic.routing import (  # noqa: E402
    Alert,
    AlertClass,
    RouteAction,
)
from medic.types import ExecResult, HealthSnapshot  # noqa: E402

NOW = 1780916754.0


class FakeExecutor:
    """Fake Executor that records every run(argv) call and returns a canned
    ExecResult. Never touches the real system. The dispatcher's only IO path is
    ex.run(argv), so sends are fully observable here."""

    def __init__(self, run_code=0, now=NOW):
        self._run_code = run_code
        self._now = now
        self.runs = []  # list of argv lists

    def run(self, argv, timeout=30.0):
        self.runs.append(list(argv))
        return ExecResult(self._run_code, "", "")

    def read_text(self, path):
        return None

    def write_text(self, path, content, mode=0o600):
        return True

    def path_mtime(self, path):
        return None

    def query(self, sql, params=()):
        return []

    def now(self):
        return self._now


def snap(sessions=None, token_expires_at=None, now=NOW):
    s = HealthSnapshot(now=now)
    s.sessions = sessions or {}
    s.token_expires_at = token_expires_at
    return s


# --------------------------------------------------------------------------- #
# classify(): the 3-class rules                                                 #
# --------------------------------------------------------------------------- #
class ClassifyBusyCollisionTests(unittest.TestCase):
    def test_busy_collision_on_live_session_is_benign(self):
        # Target session EXISTS and is ALIVE -> busy collision is benign.
        alert = Alert(kind="busy_collision", target="agent-dave",
                      detail="scheduled task target busy")
        s = snap(sessions={"agent-dave": True})
        self.assertEqual(routing.classify(alert, s), AlertClass.BENIGN_COLLISION)

    def test_busy_collision_on_dead_session_is_real_problem(self):
        # Target session present but DEAD (False) -> real problem.
        alert = Alert(kind="busy_collision", target="agent-dave",
                      detail="scheduled task target busy")
        s = snap(sessions={"agent-dave": False})
        self.assertEqual(routing.classify(alert, s), AlertClass.REAL_PROBLEM)

    def test_busy_collision_on_missing_session_is_real_problem(self):
        # Target session ABSENT from snapshot -> treated as dead -> real problem.
        alert = Alert(kind="busy_collision", target="agent-ghost",
                      detail="scheduled task target busy")
        s = snap(sessions={"agent-dave": True})
        self.assertEqual(routing.classify(alert, s), AlertClass.REAL_PROBLEM)


class ClassifyLagTests(unittest.TestCase):
    def test_lag_with_owner_is_real_lag(self):
        alert = Alert(kind="lag", target="todo-freshness", owner="scout",
                      age_sec=4000.0, detail="freshness lag 66m")
        self.assertEqual(routing.classify(alert, snap()), AlertClass.REAL_LAG)

    def test_lag_without_owner_is_real_problem(self):
        # A genuine lag with no responsible owner can't be routed to an agent;
        # it escalates to Boss rather than being silently dropped.
        alert = Alert(kind="lag", target="todo-freshness", owner=None,
                      age_sec=4000.0, detail="freshness lag 66m")
        self.assertEqual(routing.classify(alert, snap()), AlertClass.REAL_PROBLEM)


class ClassifyTokenExpiryTests(unittest.TestCase):
    def test_token_expiry_when_expired_is_real_problem(self):
        alert = Alert(kind="token_expiry", target="main-oauth",
                      detail="token near/at expiry")
        s = snap(token_expires_at=NOW - 10.0)  # already expired
        self.assertEqual(routing.classify(alert, s), AlertClass.REAL_PROBLEM)

    def test_token_expiry_within_warning_window_is_real_problem(self):
        alert = Alert(kind="token_expiry", target="main-oauth",
                      detail="token near expiry")
        # Inside the near-expiry warning window (but not yet expired).
        s = snap(token_expires_at=NOW + routing.TOKEN_EXPIRY_WARN_SEC - 1.0)
        self.assertEqual(routing.classify(alert, s), AlertClass.REAL_PROBLEM)

    def test_token_expiry_far_from_expiry_is_benign(self):
        alert = Alert(kind="token_expiry", target="main-oauth",
                      detail="token expiry alert")
        # Plenty of time left -> stale/benign alert, Boss gets nothing.
        s = snap(token_expires_at=NOW + routing.TOKEN_EXPIRY_WARN_SEC + 3600.0)
        self.assertEqual(routing.classify(alert, s), AlertClass.BENIGN_COLLISION)

    def test_token_expiry_unknown_expiry_is_real_problem(self):
        # No expiry known -> cannot prove it is safe -> escalate (fail-closed).
        alert = Alert(kind="token_expiry", target="main-oauth",
                      detail="token expiry alert")
        self.assertEqual(routing.classify(alert, snap(token_expires_at=None)),
                         AlertClass.REAL_PROBLEM)


class ClassifyPipeStaleTests(unittest.TestCase):
    def test_pipe_stale_is_real_problem(self):
        alert = Alert(kind="pipe_stale", target="agent-dave",
                      detail="telegram pipe stale")
        self.assertEqual(routing.classify(alert, snap()), AlertClass.REAL_PROBLEM)


class ClassifyUnknownTests(unittest.TestCase):
    def test_unknown_kind_fails_closed_to_real_problem(self):
        # An unmodelled alert kind must not be silently dropped.
        alert = Alert(kind="something_new", target="x", detail="?")
        self.assertEqual(routing.classify(alert, snap()), AlertClass.REAL_PROBLEM)


# --------------------------------------------------------------------------- #
# route(): class -> pure action descriptor                                      #
# --------------------------------------------------------------------------- #
class RouteTests(unittest.TestCase):
    def test_benign_routes_to_silent_no_message(self):
        alert = Alert(kind="busy_collision", target="agent-dave", detail="busy")
        action = routing.route(alert, AlertClass.BENIGN_COLLISION)
        self.assertEqual(action.kind, "SILENT")
        self.assertIsNone(action.recipient)
        self.assertEqual(action.message, "")

    def test_real_lag_routes_to_notify_owner(self):
        alert = Alert(kind="lag", target="todo", owner="scout",
                      age_sec=4000.0, detail="freshness lag")
        action = routing.route(alert, AlertClass.REAL_LAG)
        self.assertEqual(action.kind, "NOTIFY_OWNER")
        self.assertEqual(action.recipient, "scout")
        self.assertNotEqual(action.message, "")

    def test_real_problem_routes_to_escalate_boss(self):
        alert = Alert(kind="busy_collision", target="agent-dave", detail="dead")
        action = routing.route(alert, AlertClass.REAL_PROBLEM)
        self.assertEqual(action.kind, "ESCALATE_BOSS")
        self.assertNotEqual(action.message, "")

    def test_messages_do_not_leak_secrets(self):
        # The detail of an alert should never carry a secret, but the route
        # messages are what get sent -- assert they are plain human text with no
        # token-looking blob. (Defence: keep messages derived from kind/target.)
        alert = Alert(kind="token_expiry", target="main-oauth",
                      detail="expiresAt=sk-ant-SECRETSECRETSECRET")
        action = routing.route(alert, AlertClass.REAL_PROBLEM)
        self.assertNotIn("SECRETSECRET", action.message)


# --------------------------------------------------------------------------- #
# dispatch(): the IO edge -- classify + route + perform exactly one send        #
# --------------------------------------------------------------------------- #
class DispatchTests(unittest.TestCase):
    def test_silent_performs_no_send(self):
        alert = Alert(kind="busy_collision", target="agent-dave", detail="busy")
        s = snap(sessions={"agent-dave": True})
        ex = FakeExecutor()
        action = routing.dispatch(alert, s, ex)
        self.assertEqual(action.kind, "SILENT")
        self.assertEqual(len(ex.runs), 0)  # zero sends: Boss gets nothing

    def test_escalate_boss_performs_one_send(self):
        alert = Alert(kind="busy_collision", target="agent-ghost", detail="dead")
        s = snap(sessions={})  # missing -> dead -> real problem
        ex = FakeExecutor()
        action = routing.dispatch(alert, s, ex)
        self.assertEqual(action.kind, "ESCALATE_BOSS")
        self.assertEqual(len(ex.runs), 1)

    def test_notify_owner_sends_to_owner_not_boss(self):
        alert = Alert(kind="lag", target="todo", owner="scout",
                      age_sec=4000.0, detail="freshness lag")
        ex = FakeExecutor()
        action = routing.dispatch(alert, snap(), ex)
        self.assertEqual(action.kind, "NOTIFY_OWNER")
        self.assertEqual(len(ex.runs), 1)
        # The send payload must target the owner agent, not Boss.
        payload = _extract_message_payload(ex.runs[0])
        self.assertEqual(payload.get("to"), "scout")
        self.assertNotEqual(payload.get("to"), routing.BOSS_RELAY_AGENT)

    def test_escalate_boss_sends_to_boss_relay(self):
        alert = Alert(kind="pipe_stale", target="agent-dave",
                      detail="pipe stale")
        ex = FakeExecutor()
        action = routing.dispatch(alert, snap(), ex)
        self.assertEqual(action.kind, "ESCALATE_BOSS")
        payload = _extract_message_payload(ex.runs[0])
        self.assertEqual(payload.get("to"), routing.BOSS_RELAY_AGENT)

    def test_dispatch_uses_argv_not_shell(self):
        # The edge must use an argv list (curl ...), never a shell string.
        alert = Alert(kind="pipe_stale", target="agent-dave", detail="stale")
        ex = FakeExecutor()
        routing.dispatch(alert, snap(), ex)
        argv = ex.runs[0]
        self.assertIsInstance(argv, list)
        self.assertEqual(argv[0], "curl")
        # No element is a packed shell command with metacharacters doing work.
        self.assertFalse(any(";" in a or "&&" in a or "|" in a for a in argv))

    def test_dispatch_send_failure_still_returns_action(self):
        # A failed send (non-zero rc) must not raise; the action is still returned
        # so the outcome is observable.
        alert = Alert(kind="pipe_stale", target="agent-dave", detail="stale")
        ex = FakeExecutor(run_code=7)
        action = routing.dispatch(alert, snap(), ex)
        self.assertEqual(action.kind, "ESCALATE_BOSS")
        self.assertEqual(len(ex.runs), 1)


def _extract_message_payload(argv):
    """Pull the JSON body out of a curl argv list (the element after -d)."""
    for i, a in enumerate(argv):
        if a in ("-d", "--data", "--data-raw") and i + 1 < len(argv):
            try:
                return json.loads(argv[i + 1])
            except (ValueError, TypeError):
                return {}
    return {}


if __name__ == "__main__":
    unittest.main(verbosity=2)
