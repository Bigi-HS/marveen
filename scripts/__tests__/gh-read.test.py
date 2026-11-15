#!/usr/bin/env python3
"""Unit tests for gh-read.py (card 24b12610 piece B): the READ-only gh wrapper.

Enforces NoA's three mandatory conditions for exposing a write-capable PAT to
the gh CLI:
  (a) GH_TOKEN is set ONLY in the per-call subprocess env (os.environ.copy() +
      key), never exported into the agent session.
  (b) only read subcommands run; explicit default-deny allowlist + a documented
      write blocklist; `gh api` is GET-only.
  (c) the fleet endpoint stays the only write path (enforced by never allowing a
      write gh command here).

Run: python3 scripts/__tests__/gh-read.test.py
"""
import importlib.util
import os
import unittest
from pathlib import Path

_MOD_PATH = Path(__file__).parent.parent / 'gh-read.py'


def _load():
    spec = importlib.util.spec_from_file_location('gh_read', _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


g = _load()


class TestReadAllowlist(unittest.TestCase):
    def test_pr_read_subcommands_allowed(self):
        for argv in (['pr', 'view', '997'], ['pr', 'diff', '997'],
                     ['pr', 'checks', '997'], ['pr', 'list']):
            ok, _ = g.is_read_only(argv)
            self.assertTrue(ok, f'{argv} should be read-only')

    def test_run_read_subcommands_allowed(self):
        for argv in (['run', 'list'], ['run', 'view', '123'],
                     ['run', 'download', '123']):
            ok, _ = g.is_read_only(argv)
            self.assertTrue(ok, f'{argv} should be read-only')

    def test_default_deny_unknown(self):
        # Not on the allowlist -> denied even though it is not an obvious write.
        for argv in (['issue', 'list'], ['pr', 'frobnicate', '1'], ['secret', 'list']):
            ok, reason = g.is_read_only(argv)
            self.assertFalse(ok, f'{argv} should be denied by default')
            self.assertTrue(reason)

    def test_empty_denied(self):
        ok, _ = g.is_read_only([])
        self.assertFalse(ok)


class TestWriteBlocklist(unittest.TestCase):
    def test_pr_writes_blocked(self):
        for argv in (['pr', 'create'], ['pr', 'merge', '997'],
                     ['pr', 'close', '997'], ['pr', 'edit', '997'],
                     ['pr', 'comment', '997']):
            ok, reason = g.is_read_only(argv)
            self.assertFalse(ok, f'{argv} must be blocked')
            self.assertIn('write', reason.lower())

    def test_repo_and_release_blocked(self):
        for argv in (['repo', 'clone', 'x'], ['repo', 'delete', 'x'],
                     ['release', 'create', 'v1']):
            ok, _ = g.is_read_only(argv)
            self.assertFalse(ok, f'{argv} must be blocked')


class TestApiGetOnly(unittest.TestCase):
    def test_api_default_get_allowed(self):
        ok, _ = g.is_read_only(['api', 'repos/Bigi-HS/marveen/pulls/997'])
        self.assertTrue(ok)

    def test_api_explicit_get_allowed(self):
        ok, _ = g.is_read_only(['api', '-X', 'GET', 'repos/x/y/commits'])
        self.assertTrue(ok)

    def test_api_write_method_rejected(self):
        for argv in (['api', '-X', 'POST', 'repos/x/y/issues'],
                     ['api', '--method', 'DELETE', 'repos/x/y'],
                     ['api', '-X', 'PATCH', 'repos/x/y']):
            ok, reason = g.is_read_only(argv)
            self.assertFalse(ok, f'{argv} must be rejected')
            self.assertTrue(reason)

    def test_api_body_fields_rejected(self):
        # -f/--field/-F/--raw-field/--input imply a request body -> not a GET.
        for argv in (['api', 'repos/x/y/issues', '-f', 'title=hi'],
                     ['api', 'repos/x/y', '--field', 'a=b'],
                     ['api', 'repos/x/y', '-F', 'a=b'],
                     ['api', '--input', 'body.json', 'repos/x/y']):
            ok, _ = g.is_read_only(argv)
            self.assertFalse(ok, f'{argv} must be rejected (implies write body)')


class TestBuildEnv(unittest.TestCase):
    def test_token_injected_without_mutating_base(self):
        base = {'PATH': '/usr/bin', 'HOME': '/home/x'}
        env = g.build_env(base, 'secrettok')
        self.assertEqual(env['GH_TOKEN'], 'secrettok')
        # Base env must be untouched (no leak into the caller's process env).
        self.assertNotIn('GH_TOKEN', base)
        self.assertIsNot(env, base)

    def test_result_preserves_base_keys(self):
        base = {'PATH': '/usr/bin'}
        env = g.build_env(base, 't')
        self.assertEqual(env['PATH'], '/usr/bin')


class TestExtractPat(unittest.TestCase):
    def test_parses_token(self):
        cred = 'https://Bigi-HS:ghp_ABC123def@github.com'
        self.assertEqual(g.extract_pat(cred), 'ghp_ABC123def')

    def test_missing_raises(self):
        with self.assertRaises(ValueError):
            g.extract_pat('not-a-credential-line')


class TestTokenNotLeaked(unittest.TestCase):
    def test_reason_never_contains_token(self):
        # Denied commands must not echo any env/token material in their reason.
        for argv in (['pr', 'merge', '1'], ['api', '-X', 'POST', 'x']):
            _, reason = g.is_read_only(argv)
            self.assertNotIn('ghp_', reason)


if __name__ == '__main__':
    unittest.main()
