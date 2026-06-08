#!/usr/bin/env python3
"""Tests for Medic's credential CORE (actions_core): token-refresh + login-link.

Focus: the static-bearer model (validate + idempotent fleet-env propagation, no
8h refresh), the missing/malformed/expired -> login-link guidance, and the hard
security invariant that the token VALUE never appears in any Reply.

Run: python3 scripts/test_medic_actions_core.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import actions_core as ac  # noqa: E402
from medic.types import ExecResult, HandlerContext, Reply  # noqa: E402

# A realistic-shaped but entirely fake token (108 chars), used to prove it never
# leaks into a Reply.
FAKE_TOKEN = "sk-ant-oat01-" + ("Z" * 95)
DAY = 86400.0
NOW = 1780929600.0


class FakeExecutor:
    """In-memory filesystem; records writes. Never touches the real system."""

    def __init__(self, files=None, mtimes=None, now=NOW, write_ok=True):
        self.files = dict(files or {})
        self.mtimes = dict(mtimes or {})
        self._now = now
        self.write_ok = write_ok
        self.writes = []  # list[(path, content, mode)]

    def run(self, argv, timeout=30.0):
        return ExecResult(0, "", "")

    def read_text(self, path):
        return self.files.get(path)

    def write_text(self, path, content, mode=0o600):
        if not self.write_ok:
            return False
        self.files[path] = content
        self.writes.append((path, content, mode))
        return True

    def path_mtime(self, path):
        return self.mtimes.get(path)

    def query(self, sql, params=()):
        return []

    def now(self):
        return self._now


def _ctx(ex):
    return HandlerContext(ex=ex, arg=None)


def _ex_with_token(age_days=10.0, token=FAKE_TOKEN, fleet_env=None, write_ok=True):
    mtime = NOW - age_days * DAY
    files = {ac.SETUP_TOKEN_PATH: token + "\n"}
    if fleet_env is not None:
        files[ac.FLEET_ENV_PATH] = fleet_env
    return FakeExecutor(
        files=files,
        mtimes={ac.SETUP_TOKEN_PATH: mtime},
        write_ok=write_ok,
    )


class ShapeTests(unittest.TestCase):
    def test_valid_and_invalid_shapes(self):
        self.assertTrue(ac._valid_shape(FAKE_TOKEN))
        self.assertFalse(ac._valid_shape("nope"))
        self.assertFalse(ac._valid_shape("sk-ant-oat01-short"))   # too short
        self.assertFalse(ac._valid_shape("sk-ant-oat01-" + "A" * 95 + " x"))  # space
        self.assertFalse(ac._valid_shape("sk-ant-api03-" + "A" * 95))  # wrong prefix


class StatusTests(unittest.TestCase):
    def test_absent_token(self):
        st = ac._token_status(_ctx(FakeExecutor()))
        self.assertFalse(st["present"])
        self.assertFalse(st["valid_shape"])

    def test_valid_fresh_token(self):
        st = ac._token_status(_ctx(_ex_with_token(age_days=10.0)))
        self.assertTrue(st["present"] and st["valid_shape"])
        self.assertFalse(st["expired"])
        self.assertFalse(st["expiring_soon"])
        self.assertAlmostEqual(st["age_days"], 10.0, places=3)

    def test_expiring_soon(self):
        st = ac._token_status(_ctx(_ex_with_token(age_days=350.0)))
        self.assertFalse(st["expired"])
        self.assertTrue(st["expiring_soon"])

    def test_expired(self):
        st = ac._token_status(_ctx(_ex_with_token(age_days=400.0)))
        self.assertTrue(st["expired"])
        self.assertFalse(st["expiring_soon"])


class TokenRefreshTests(unittest.TestCase):
    def test_missing_token_defers_to_login_link(self):
        r = ac.handle_token_refresh(_ctx(FakeExecutor()))
        self.assertIsInstance(r, Reply)
        self.assertIn("login-link", r.text)
        self.assertIn("hianyzik", r.text)

    def test_malformed_token_defers_to_login_link(self):
        ex = FakeExecutor(files={ac.SETUP_TOKEN_PATH: "garbage-token\n"},
                          mtimes={ac.SETUP_TOKEN_PATH: NOW - 5 * DAY})
        r = ac.handle_token_refresh(_ctx(ex))
        self.assertIn("login-link", r.text)
        self.assertIn("alakja rossz", r.text)

    def test_expired_token_defers_to_login_link(self):
        r = ac.handle_token_refresh(_ctx(_ex_with_token(age_days=400.0)))
        self.assertIn("login-link", r.text)
        self.assertIn("lejart", r.text)

    def test_valid_token_propagates_to_fleet_env(self):
        ex = _ex_with_token(age_days=30.0)
        r = ac.handle_token_refresh(_ctx(ex))
        # Wrote exactly the env-file, 0600, with the env-var form.
        self.assertEqual(len(ex.writes), 1)
        path, content, mode = ex.writes[0]
        self.assertEqual(path, ac.FLEET_ENV_PATH)
        self.assertEqual(mode, 0o600)
        self.assertEqual(content, f"{ac.ENV_VAR}={FAKE_TOKEN}\n")
        self.assertIn("frissitve", r.text)

    def test_propagation_is_idempotent(self):
        already = f"{ac.ENV_VAR}={FAKE_TOKEN}\n"
        ex = _ex_with_token(age_days=30.0, fleet_env=already)
        r = ac.handle_token_refresh(_ctx(ex))
        self.assertEqual(ex.writes, [])          # nothing rewritten
        self.assertIn("mar naprakesz", r.text)

    def test_write_failure_is_reported(self):
        ex = _ex_with_token(age_days=30.0, write_ok=False)
        r = ac.handle_token_refresh(_ctx(ex))
        self.assertIn("SIKERTELEN", r.text)

    def test_expiring_soon_warns(self):
        ex = _ex_with_token(age_days=350.0)
        r = ac.handle_token_refresh(_ctx(ex))
        self.assertIn("FIGYELEM", r.text)


class LoginLinkTests(unittest.TestCase):
    def test_login_link_gives_procedure(self):
        r = ac.handle_login_link(_ctx(_ex_with_token(age_days=400.0)))
        self.assertIn("setup-token", r.text)
        self.assertIn("store/.claude-oauth-token", r.text)
        self.assertIn("token-refresh", r.text)

    def test_login_link_no_token_state(self):
        r = ac.handle_login_link(_ctx(FakeExecutor()))
        self.assertIn("nincs canonical token", r.text)


class SecurityTests(unittest.TestCase):
    """The token VALUE must never appear in any Reply text, in any state."""

    def test_token_value_never_in_any_reply(self):
        states = [
            _ex_with_token(age_days=10.0),                 # valid -> propagates
            _ex_with_token(age_days=10.0,
                           fleet_env=f"{ac.ENV_VAR}={FAKE_TOKEN}\n"),  # idempotent
            _ex_with_token(age_days=350.0),                # expiring
            _ex_with_token(age_days=400.0),                # expired
        ]
        for ex in states:
            for handler in (ac.handle_token_refresh, ac.handle_login_link):
                reply = handler(_ctx(ex))
                self.assertNotIn(FAKE_TOKEN, reply.text)
                # not even the distinctive body of the token
                self.assertNotIn("Z" * 95, reply.text)


class ExtractUrlTests(unittest.TestCase):
    def test_finds_first_url(self):
        text = "Visit https://claude.ai/oauth/authorize?code=abc to continue."
        self.assertEqual(
            ac.extract_setup_url(text),
            "https://claude.ai/oauth/authorize?code=abc",
        )

    def test_none_when_no_url(self):
        self.assertIsNone(ac.extract_setup_url("no link here"))
        self.assertIsNone(ac.extract_setup_url(""))
        self.assertIsNone(ac.extract_setup_url(None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
