#!/usr/bin/env python3
"""Tests for Medic's `restart <target>` handler.

The handler maps a pre-validated restart target to the supervisor's existing
relaunch path: it tears down the matching tmux session(s) -- SESSION-scoped only,
never `pkill -f` -- and lets the always-on watchdog/supervisor revive them. These
tests assert exactly that argv shape, the target->session resolution, the
orchestrator-exclusion on "all", and that no destructive or shell command can be
produced.

Run: python3 scripts/test_medic_handlers_restart.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import dispatch  # noqa: E402
from medic import handlers_restart  # noqa: E402
from medic.types import ExecResult, HandlerContext, Reply  # noqa: E402


class FakeExecutor:
    """Records every argv it is asked to run and returns a scripted exit code.

    `alive` is the set of session names that `tmux has-session` should report as
    existing (code 0); everything else returns code 1. `kill_fail` is the set of
    sessions whose `tmux kill-session` should fail (code 1) to exercise the error
    branch. The Executor NEVER touches the real system.
    """

    def __init__(self, alive=None, kill_fail=None):
        self.alive = set(alive or [])
        self.kill_fail = set(kill_fail or [])
        self.calls = []  # list[list[str]] -- every argv, in order

    def run(self, argv, timeout=30.0):
        argv = list(argv)
        self.calls.append(argv)
        # tmux has-session -t "=<session>" / kill-session -t "=<session>".
        # The '=' is asserted here rather than tolerated: without it tmux falls
        # back to prefix matching, and `-t marveen` reaches `marveen-channels`
        # whenever `marveen` is absent (card OPS-106). A fake that silently
        # accepted either form would let that regression back in.
        if argv[:2] in (["tmux", "has-session"], ["tmux", "kill-session"]):
            target = argv[-1]
            assert target.startswith("="), (
                "tmux session target must be anchored, got %r" % target
            )
            session = target[1:]
            if argv[1] == "has-session":
                return ExecResult(0 if session in self.alive else 1, "", "")
            return ExecResult(1 if session in self.kill_fail else 0, "", "")
        return ExecResult(0, "", "")

    # Unused read-only surface (handler never calls these), present for Protocol.
    def read_text(self, path):
        return None

    def write_text(self, path, content, mode=0o600):
        return True

    def path_mtime(self, path):
        return None

    def query(self, sql, params=()):
        return []

    def now(self):
        return 1780916754.0

    # --- test helpers ---------------------------------------------------------
    def killed_sessions(self):
        # Returns session NAMES with the `=` anchor removed. The anchor itself is
        # asserted in run(); stripping it here keeps the callers about behaviour
        # ("which session died") rather than about tmux target syntax.
        return [c[-1].lstrip("=") for c in self.calls if c[:2] == ["tmux", "kill-session"]]

    def all_argv(self):
        return self.calls


def _ctx(ex, arg):
    return HandlerContext(ex=ex, arg=arg)


class ResolutionTests(unittest.TestCase):
    def test_single_agent_maps_to_agent_session(self):
        self.assertEqual(handlers_restart._sessions_for("dave"), ["agent-dave"])
        self.assertEqual(handlers_restart._sessions_for("thor"), ["agent-thor"])

    def test_genesis_maps_to_orchestrator_sessions(self):
        self.assertEqual(
            handlers_restart._sessions_for("genesis"),
            ["marveen", "marveen-channels"],
        )

    def test_all_is_every_supervised_agent_session(self):
        sessions = handlers_restart._sessions_for("all")
        expected = [
            f"agent-{a}" for a in dispatch.AGENTS
            if a in handlers_restart.SUPERVISED_AGENTS
        ]
        self.assertEqual(sessions, expected)
        # Each supervised agent appears exactly once.
        self.assertEqual(len(set(sessions)), len(sessions))

    def test_all_excludes_unsupervised_agents(self):
        # buster (chameleon sandbox) and heartbeat (not a tmux agent session) have
        # no reviving watchdog -> "all" must never target them.
        sessions = handlers_restart._sessions_for("all")
        self.assertNotIn("agent-buster", sessions)
        self.assertNotIn("agent-heartbeat", sessions)

    def test_unsupervised_single_agent_resolves_to_no_session(self):
        self.assertEqual(handlers_restart._sessions_for("buster"), [])
        self.assertEqual(handlers_restart._sessions_for("heartbeat"), [])

    def test_all_excludes_the_orchestrator_by_default(self):
        self.assertFalse(handlers_restart.ALL_INCLUDES_ORCHESTRATOR)
        sessions = handlers_restart._sessions_for("all")
        self.assertNotIn("marveen", sessions)
        self.assertNotIn("marveen-channels", sessions)

    def test_all_includes_orchestrator_only_when_flag_flipped(self):
        original = handlers_restart.ALL_INCLUDES_ORCHESTRATOR
        try:
            handlers_restart.ALL_INCLUDES_ORCHESTRATOR = True
            sessions = handlers_restart._sessions_for("all")
            self.assertIn("marveen", sessions)
            self.assertIn("marveen-channels", sessions)
        finally:
            handlers_restart.ALL_INCLUDES_ORCHESTRATOR = original


class KillPathTests(unittest.TestCase):
    def test_live_agent_is_killed_session_scoped(self):
        ex = FakeExecutor(alive={"agent-dave"})
        reply = handlers_restart.handle(_ctx(ex, "dave"))
        self.assertIsInstance(reply, Reply)
        # Exactly the one session was killed.
        self.assertEqual(ex.killed_sessions(), ["agent-dave"])
        # The kill is SESSION-scoped: argv is the explicit tmux kill-session form.
        self.assertIn(
            ["tmux", "kill-session", "-t", "=agent-dave"], ex.all_argv()
        )
        self.assertIn("ujrainditva", reply.text)
        self.assertIn("agent-dave", reply.text)

    def test_absent_agent_is_not_killed(self):
        ex = FakeExecutor(alive=set())  # nothing alive
        reply = handlers_restart.handle(_ctx(ex, "dave"))
        self.assertEqual(ex.killed_sessions(), [])  # never kill a dead session
        self.assertIn("nem futott", reply.text)

    def test_genesis_bounces_both_orchestrator_sessions(self):
        ex = FakeExecutor(alive={"marveen", "marveen-channels"})
        handlers_restart.handle(_ctx(ex, "genesis"))
        self.assertEqual(
            sorted(ex.killed_sessions()), ["marveen", "marveen-channels"]
        )

    def test_all_kills_only_live_agents_never_orchestrator(self):
        # Two agents up plus (defensively) the orchestrator sessions reported up.
        ex = FakeExecutor(
            alive={"agent-dave", "agent-thor", "marveen", "marveen-channels"}
        )
        handlers_restart.handle(_ctx(ex, "all"))
        killed = ex.killed_sessions()
        self.assertIn("agent-dave", killed)
        self.assertIn("agent-thor", killed)
        # The orchestrator must NEVER be bounced by "all" (default flag).
        self.assertNotIn("marveen", killed)
        self.assertNotIn("marveen-channels", killed)

    def test_kill_failure_is_reported_not_swallowed(self):
        ex = FakeExecutor(alive={"agent-dave"}, kill_fail={"agent-dave"})
        reply = handlers_restart.handle(_ctx(ex, "dave"))
        self.assertIn("HIBA", reply.text)

    def test_unsupervised_target_is_refused_never_killed(self):
        # Even with the session reported alive, an unsupervised target must NOT be
        # killed (it would never come back). The handler refuses and runs nothing.
        for target in ("buster", "heartbeat"):
            ex = FakeExecutor(alive={f"agent-{target}"})
            reply = handlers_restart.handle(_ctx(ex, target))
            self.assertEqual(ex.killed_sessions(), [], target)
            self.assertEqual(ex.all_argv(), [], target)  # no tmux call at all
            self.assertIn("nincs felugyelo watchdog", reply.text, target)


class SafetyTests(unittest.TestCase):
    """No matter the target, the handler may only ever emit safe, session-scoped
    tmux argv lists -- never a shell string, never `pkill`, never `-f`."""

    def test_only_tmux_argv_and_never_pkill_or_shell(self):
        for target in dispatch.RESTART_TARGETS:
            # Report every session as alive so the kill branch is exercised too.
            sess = handlers_restart._sessions_for(target)
            ex = FakeExecutor(alive=set(sess))
            handlers_restart.handle(_ctx(ex, target))
            for argv in ex.all_argv():
                self.assertIsInstance(argv, list, target)  # argv, not a string
                self.assertEqual(argv[0], "tmux", target)
                self.assertIn(argv[1], ("has-session", "kill-session"), target)
                # No broad-match flag, no pkill, no shell metacharacters anywhere.
                self.assertNotIn("-f", argv, target)
                joined = " ".join(argv)
                self.assertNotIn("pkill", joined, target)
                for meta in (";", "&", "|", "`", "$", "(", ")", ">", "<"):
                    self.assertNotIn(meta, joined, f"{target} / {meta}")

    def test_every_kill_is_preceded_by_a_liveness_check(self):
        # The handler must has-session before kill-session for each target, so it
        # never blindly kills. Verify ordering for a multi-session target.
        ex = FakeExecutor(alive={"marveen", "marveen-channels"})
        handlers_restart.handle(_ctx(ex, "genesis"))
        argv = ex.all_argv()
        for session in ("marveen", "marveen-channels"):
            chk = argv.index(["tmux", "has-session", "-t", "=" + session])
            kill = argv.index(["tmux", "kill-session", "-t", "=" + session])
            self.assertLess(chk, kill, session)


if __name__ == "__main__":
    unittest.main(verbosity=2)
