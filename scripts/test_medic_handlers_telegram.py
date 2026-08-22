#!/usr/bin/env python3
"""Tests for Medic's Telegram-recovery handlers (mcp / restart-telegram).

These handlers are the ONLY Medic commands that drive a tmux pane, so the tests
focus on: (1) the exact argv shape sent through the Executor (argv list, no shell
string, no metacharacters), (2) the success/failure reply branches keyed off the
ExecResult code, and (3) the honest level-2 skip when no deep re-pull script is
wired. The Executor is faked -- nothing touches a real tmux/system.

Run: python3 scripts/test_medic_handlers_telegram.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import handlers_telegram  # noqa: E402
from medic.types import ExecResult, HandlerContext, Reply  # noqa: E402


class FakeExecutor:
    """Minimal Executor that records run() calls; never touches the real system.

    `code` is the exit code every run() returns (default 0 = success). It records
    each argv list so tests can assert the exact command shape.
    """
    def __init__(self, code=0):
        self.calls = []
        self.code = code

    def run(self, argv, timeout=30.0):
        self.calls.append(list(argv))
        return ExecResult(self.code, "", "")

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


def ctx_for(agent, code=0):
    ex = FakeExecutor(code=code)
    return HandlerContext(ex=ex, arg=agent), ex


class McpHandlerTests(unittest.TestCase):
    def test_sends_exact_mcp_send_keys_argv(self):
        ctx, ex = ctx_for("dave")
        reply = handlers_telegram.handle_mcp(ctx)
        self.assertIsInstance(reply, Reply)
        # Exactly one run() call, with the precise argv -- no shell string.
        self.assertEqual(
            ex.calls,
            [["tmux", "send-keys", "-t", "agent-dave", "/mcp", "Enter"]],
        )

    def test_argv_is_a_list_never_a_shell_string(self):
        ctx, ex = ctx_for("thor")
        handlers_telegram.handle_mcp(ctx)
        argv = ex.calls[0]
        self.assertIsInstance(argv, list)
        for token in argv:
            self.assertIsInstance(token, str)

    def test_success_reply_mentions_session(self):
        ctx, _ = ctx_for("claudia", code=0)
        reply = handlers_telegram.handle_mcp(ctx)
        self.assertIn("agent-claudia", reply.text)
        self.assertNotIn("SIKERTELEN", reply.text)
        self.assertNotIn("NEM sikerult", reply.text)

    def test_failure_reply_when_send_keys_nonzero(self):
        ctx, _ = ctx_for("hibiki", code=1)
        reply = handlers_telegram.handle_mcp(ctx)
        self.assertIn("agent-hibiki", reply.text)
        self.assertIn("NEM sikerult", reply.text)

    def test_session_is_agent_prefixed_for_every_agent(self):
        from medic import dispatch
        for agent in dispatch.AGENTS:
            ctx, ex = ctx_for(agent)
            handlers_telegram.handle_mcp(ctx)
            self.assertEqual(ex.calls[0][3], f"agent-{agent}")


class RestartTelegramHandlerTests(unittest.TestCase):
    def test_level1_send_keys_always_fires(self):
        ctx, ex = ctx_for("dave")
        reply = handlers_telegram.handle_restart_telegram(ctx)
        self.assertIsInstance(reply, Reply)
        # Level 1 is the same /mcp send-keys argv.
        self.assertIn(
            ["tmux", "send-keys", "-t", "agent-dave", "/mcp", "Enter"],
            ex.calls,
        )

    def test_level2_skipped_when_no_deep_script_configured(self):
        # On eng/medic-base DEEP_REPULL_SCRIPT is None -> honest skip, only L1.
        self.assertIsNone(handlers_telegram.DEEP_REPULL_SCRIPT)
        ctx, ex = ctx_for("scout")
        reply = handlers_telegram.handle_restart_telegram(ctx)
        # Exactly one run() (the L1 send-keys); no second escalation call.
        self.assertEqual(len(ex.calls), 1)
        self.assertIn("L1", reply.text)
        self.assertIn("NINCS bekotve", reply.text)

    def test_level1_failure_is_reported(self):
        ctx, _ = ctx_for("forge", code=1)
        reply = handlers_telegram.handle_restart_telegram(ctx)
        self.assertIn("SIKERTELEN", reply.text)

    def test_level2_invoked_when_deep_script_configured(self):
        # Temporarily wire a fake deep re-pull script and assert it is invoked
        # via ex.run([abs_path, session]) as an argv -- no shell.
        original = handlers_telegram.DEEP_REPULL_SCRIPT
        handlers_telegram.DEEP_REPULL_SCRIPT = "scripts/fake-agent-mcp-reconnect.sh"
        try:
            ctx, ex = ctx_for("radar")
            reply = handlers_telegram.handle_restart_telegram(ctx)
            self.assertEqual(len(ex.calls), 2)  # L1 send-keys + L2 script
            l2 = ex.calls[1]
            self.assertEqual(len(l2), 2)
            self.assertTrue(l2[0].endswith("scripts/fake-agent-mcp-reconnect.sh"))
            self.assertTrue(os.path.isabs(l2[0]))  # resolved to abs path
            self.assertEqual(l2[1], "agent-radar")
            self.assertIn("L2", reply.text)
        finally:
            handlers_telegram.DEEP_REPULL_SCRIPT = original

    def test_no_shell_metacharacters_reach_any_argv(self):
        # Defence-in-depth: even though dispatch enum-validates, assert no token
        # this handler emits carries a shell metacharacter.
        original = handlers_telegram.DEEP_REPULL_SCRIPT
        handlers_telegram.DEEP_REPULL_SCRIPT = "scripts/fake.sh"
        try:
            ctx, ex = ctx_for("gauge")
            handlers_telegram.handle_restart_telegram(ctx)
            for call in ex.calls:
                for token in call:
                    self.assertNotRegex(token, r"[;&|`$()<>'\"\\]")
        finally:
            handlers_telegram.DEEP_REPULL_SCRIPT = original


class RepullPathSafetyTests(unittest.TestCase):
    """Chad PR#84 low-finding (card eac0423a): DEEP_REPULL_SCRIPT must not compose
    a path that escapes <root>/scripts/. _resolve_repull_script validates it."""

    def _with_script(self, value):
        original = handlers_telegram.DEEP_REPULL_SCRIPT
        handlers_telegram.DEEP_REPULL_SCRIPT = value
        self.addCleanup(setattr, handlers_telegram, "DEEP_REPULL_SCRIPT", original)

    def test_none_resolves_to_none(self):
        self._with_script(None)
        self.assertIsNone(handlers_telegram._resolve_repull_script())

    def test_valid_under_scripts_resolves_to_abs_path(self):
        self._with_script("scripts/agent-mcp-reconnect.sh")
        got = handlers_telegram._resolve_repull_script()
        self.assertIsNotNone(got)
        self.assertTrue(os.path.isabs(got))
        self.assertTrue(got.endswith("scripts/agent-mcp-reconnect.sh"))

    def test_absolute_path_rejected(self):
        self._with_script("/etc/cron.d/evil.sh")
        self.assertIsNone(handlers_telegram._resolve_repull_script())

    def test_traversal_rejected(self):
        # Even prefixed with scripts/, a '..' segment that climbs out is refused.
        self._with_script("scripts/../../../etc/passwd")
        self.assertIsNone(handlers_telegram._resolve_repull_script())

    def test_outside_scripts_prefix_rejected(self):
        self._with_script("store/secret.sh")
        self.assertIsNone(handlers_telegram._resolve_repull_script())

    def test_handler_skips_l2_when_path_unsafe(self):
        # A configured-but-unsafe script must NOT be executed: only the L1
        # send-keys call fires, and the reply says L2 was skipped.
        self._with_script("scripts/../outside/evil.sh")
        ctx, ex = ctx_for("dave")
        reply = handlers_telegram.handle_restart_telegram(ctx)
        self.assertEqual(len(ex.calls), 1)  # L1 only; the unsafe L2 never ran
        self.assertIn("KIHAGYVA", reply.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
