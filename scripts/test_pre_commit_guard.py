#!/usr/bin/env python3
"""Tests for scripts/hooks/pre-commit-guard.sh (card f7b6c1d6).

The hook must block direct commits to develop or main from any agent context
(AI or human) -- the fleet workflow is always feature-branch + PR.

Tests run the hook script via subprocess, mocking git rev-parse via PATH override.
"""
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'scripts', 'hooks', 'pre-commit-guard.sh',
)


def _run_hook(branch, *, allow_override=False, extra_env=None):
    """Run the hook, stubbing git rev-parse to return `branch`."""
    with tempfile.TemporaryDirectory() as td:
        # Write a stub git that returns the desired branch for rev-parse --abbrev-ref HEAD
        stub = os.path.join(td, 'git')
        with open(stub, 'w') as fh:
            fh.write('#!/bin/sh\n')
            fh.write(f'if [ "$1" = "rev-parse" ]; then echo "{branch}"; exit 0; fi\n')
            fh.write('exec /usr/bin/git "$@"\n')
        os.chmod(stub, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP)

        env = dict(os.environ)
        env['PATH'] = td + ':' + env['PATH']
        if allow_override:
            env['ALLOW_DIRECT_COMMIT'] = '1'
        elif 'ALLOW_DIRECT_COMMIT' in env:
            del env['ALLOW_DIRECT_COMMIT']
        if extra_env:
            env.update(extra_env)

        proc = subprocess.run(
            ['bash', HOOK_PATH],
            env=env,
            capture_output=True,
            text=True,
        )
        return proc


class TestPreCommitGuard(unittest.TestCase):
    def test_allows_feature_branch(self):
        r = _run_hook('feat/some-feature')
        self.assertEqual(r.returncode, 0)

    def test_allows_ops_branch(self):
        r = _run_hook('ops/3ceab75a-guard-watchdog')
        self.assertEqual(r.returncode, 0)

    def test_allows_sec_branch(self):
        r = _run_hook('sec/ad7bc51a-restrictive-fallback')
        self.assertEqual(r.returncode, 0)

    def test_blocks_develop(self):
        r = _run_hook('develop')
        self.assertNotEqual(r.returncode, 0, 'Hook must block direct commit to develop')

    def test_blocks_main(self):
        r = _run_hook('main')
        self.assertNotEqual(r.returncode, 0, 'Hook must block direct commit to main')

    def test_blocks_develop_prints_guidance(self):
        r = _run_hook('develop')
        combined = r.stdout + r.stderr
        # Must mention the blocked branch and what to do instead
        self.assertIn('develop', combined)
        self.assertIn('feature', combined.lower())

    def test_override_allows_develop(self):
        """ALLOW_DIRECT_COMMIT=1 escape hatch must work (for operator emergencies)."""
        r = _run_hook('develop', allow_override=True)
        self.assertEqual(r.returncode, 0)

    def test_override_allows_main(self):
        r = _run_hook('main', allow_override=True)
        self.assertEqual(r.returncode, 0)

    def test_allows_arbitrary_branch_name(self):
        for branch in ('hotfix/urgent', 'eng/acd7fa13-fix', 'chore/cleanup', 'v2'):
            with self.subTest(branch=branch):
                r = _run_hook(branch)
                self.assertEqual(r.returncode, 0, f'Should allow branch: {branch}')

    def test_detached_head_is_blocked(self):
        """HEAD (detached) should be blocked as a safe default."""
        r = _run_hook('HEAD')
        self.assertNotEqual(r.returncode, 0)

    def test_hook_is_executable(self):
        """The script must be chmod +x."""
        self.assertTrue(os.access(HOOK_PATH, os.X_OK),
                        f'{HOOK_PATH} must be executable')


if __name__ == '__main__':
    unittest.main()
