#!/usr/bin/env python3
"""Fixture set for scripts/promote-guard.py (card 2cb1ed6e, deploy direction).

Run: python3 scripts/hooks/test_promote_guard.py

The promoter exists to separate ACTIVATION from dev work.  Before it, the live
PreToolUse hook was the working copy in the checkout, so a guard edit was live
the moment it was saved -- b85acbf shipped a hole and carried it for about an
hour while it was still under review.  The promoter is the gate that makes
review precede activation, so its own failure mode has to be fail-CLOSED: any
doubt leaves the previously promoted file exactly as it was.

Every test builds a real throwaway git repo with a real (trivial) guard, suite
and canary, and drives the real promoter.  Nothing is mocked, because the thing
under test IS the wiring: which command runs, on which file, in which order.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROMOTER = os.path.join(os.path.dirname(_HERE), 'promote-guard.py')

_spec = importlib.util.spec_from_file_location('promote_guard', _PROMOTER)
promote_guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(promote_guard)


EXIT_OK = 'import sys\nsys.exit(0)\n'
EXIT_FAIL = 'import sys\nsys.stderr.write("deliberate failure\\n")\nsys.exit(1)\n'

GUARD_V1 = '# guard v1\nimport sys\nsys.exit(0)\n'
GUARD_V2 = '# guard v2, the one under promotion\nimport sys\nsys.exit(0)\n'


def sha256(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


class PromoterFixture(unittest.TestCase):
    """A throwaway repo laid out exactly like ours: scripts/hooks/<guard>,
    scripts/hooks/test_<guard>.py, scripts/hooks/canary_guardrail_example.py."""

    NAME = 'guardrail-example.py'

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='promote-guard-test-')
        self.addCleanup(shutil.rmtree, self.root, True)
        self.hooks = os.path.join(self.root, 'scripts', 'hooks')
        os.makedirs(self.hooks)
        self.guard_dir = os.path.join(self.root, '.guard')

        self.write('scripts/hooks/' + self.NAME, GUARD_V2)
        self.write('scripts/hooks/test_guardrail_example.py', EXIT_OK)
        self.write('scripts/hooks/canary_guardrail_example.py', EXIT_OK)

        env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t',
                   GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')
        for cmd in (['git', 'init', '-q'], ['git', 'add', '-A'],
                    ['git', 'commit', '-q', '-m', 'seed']):
            subprocess.run(cmd, cwd=self.root, env=env, check=True,
                           capture_output=True)

    def write(self, rel, content):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as fh:
            fh.write(content)
        return path

    def promote(self):
        return promote_guard.promote(self.NAME, repo_root=self.root,
                                     guard_dir=self.guard_dir)

    def seed_previous_promotion(self):
        """Put an already-live copy in place so refusal can be checked against
        it.  A gate that refuses but corrupts what is live is not a gate."""
        os.makedirs(self.guard_dir, exist_ok=True)
        live = os.path.join(self.guard_dir, self.NAME)
        with open(live, 'w') as fh:
            fh.write(GUARD_V1)
        return live


class HappyPathTests(PromoterFixture):
    def test_promoted_bytes_are_identical_to_the_source(self):
        result = self.promote()
        live = os.path.join(self.guard_dir, self.NAME)
        with open(live) as fh:
            self.assertEqual(fh.read(), GUARD_V2)
        self.assertEqual(result['sha256'], sha256(live))

    def test_manifest_records_sha_head_and_both_gates(self):
        self.promote()
        with open(os.path.join(self.guard_dir, self.NAME + '.manifest.json')) as fh:
            man = json.load(fh)
        live = os.path.join(self.guard_dir, self.NAME)
        self.assertEqual(man['sha256'], sha256(live))
        self.assertEqual(len(man['git_head']), 40)
        self.assertTrue(man['suite'].endswith('test_guardrail_example.py'))
        self.assertIn('canary', man)
        self.assertIn('promoted_at', man)

    def test_promotion_is_idempotent_on_an_unchanged_source(self):
        first = self.promote()
        second = self.promote()
        self.assertEqual(first['sha256'], second['sha256'])

    def test_a_second_promotion_replaces_the_live_bytes(self):
        self.seed_previous_promotion()
        self.promote()
        with open(os.path.join(self.guard_dir, self.NAME)) as fh:
            self.assertEqual(fh.read(), GUARD_V2)


class FailClosedTests(PromoterFixture):
    """Each case breaks exactly one thing and asserts two properties: the
    promotion is refused, and whatever was live before is untouched."""

    def assert_refused_and_live_untouched(self, expect_in_message):
        live = self.seed_previous_promotion()
        with self.assertRaises(promote_guard.PromotionRefused) as ctx:
            self.promote()
        self.assertIn(expect_in_message, str(ctx.exception).lower())
        with open(live) as fh:
            self.assertEqual(fh.read(), GUARD_V1, 'live copy was modified on refusal')
        self.assertFalse(
            os.path.exists(os.path.join(self.guard_dir, self.NAME + '.manifest.json')),
            'a manifest was written for a refused promotion')

    def test_refuses_when_the_unit_suite_fails(self):
        self.write('scripts/hooks/test_guardrail_example.py', EXIT_FAIL)
        self.commit_all()
        self.assert_refused_and_live_untouched('suite')

    def test_refuses_when_the_canary_fails(self):
        self.write('scripts/hooks/canary_guardrail_example.py', EXIT_FAIL)
        self.commit_all()
        self.assert_refused_and_live_untouched('canary')

    def test_refuses_when_the_source_has_uncommitted_changes(self):
        # This is the property that makes review precede activation: an edit in
        # the working tree cannot reach the fleet until it is committed.
        self.write('scripts/hooks/' + self.NAME, GUARD_V2 + '# dirty\n')
        self.assert_refused_and_live_untouched('uncommitted')

    def test_refuses_when_the_source_is_untracked(self):
        self.NAME = 'guardrail-untracked.py'
        self.write('scripts/hooks/' + self.NAME, GUARD_V2)
        self.write('scripts/hooks/test_guardrail_untracked.py', EXIT_OK)
        self.assert_refused_and_live_untouched('track')

    def test_refuses_when_no_unit_suite_exists(self):
        os.remove(os.path.join(self.hooks, 'test_guardrail_example.py'))
        self.commit_all()
        self.assert_refused_and_live_untouched('suite')

    def test_refuses_when_no_canary_exists(self):
        os.remove(os.path.join(self.hooks, 'canary_guardrail_example.py'))
        self.commit_all()
        self.assert_refused_and_live_untouched('canary')

    def test_refuses_an_unknown_source(self):
        self.NAME = 'guardrail-does-not-exist.py'
        self.assert_refused_and_live_untouched('not found')

    def commit_all(self):
        env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t',
                   GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')
        subprocess.run(['git', 'add', '-A'], cwd=self.root, env=env, check=True,
                       capture_output=True)
        subprocess.run(['git', 'commit', '-q', '-m', 'change'], cwd=self.root,
                       env=env, check=True, capture_output=True)


class GateOrderTests(PromoterFixture):
    def test_the_canary_runs_against_the_source_not_the_live_copy(self):
        # A canary pointed at the already-live file would certify the OLD code
        # and pass a broken promotion straight through -- the exact shape of
        # "a check given a result cannot verify the method".
        self.write('scripts/hooks/canary_guardrail_example.py',
                   'import sys\n'
                   'target = sys.argv[1]\n'
                   'sys.exit(0 if open(target).read().strip().startswith("# guard v2") else 1)\n')
        self.commit_all()
        self.seed_previous_promotion()
        self.promote()   # must not raise: the canary saw v2, the source
        with open(os.path.join(self.guard_dir, self.NAME)) as fh:
            self.assertEqual(fh.read(), GUARD_V2)

    def test_nothing_is_written_when_the_first_gate_refuses(self):
        # No .guard dir at all beforehand: a refusal must not even create it.
        self.write('scripts/hooks/' + self.NAME, GUARD_V2 + '# dirty\n')
        with self.assertRaises(promote_guard.PromotionRefused):
            self.promote()
        self.assertFalse(os.path.exists(os.path.join(self.guard_dir, self.NAME)))

    def commit_all(self):
        env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t',
                   GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')
        subprocess.run(['git', 'add', '-A'], cwd=self.root, env=env, check=True,
                       capture_output=True)
        subprocess.run(['git', 'commit', '-q', '-m', 'change'], cwd=self.root,
                       env=env, check=True, capture_output=True)


class VerifyTests(PromoterFixture):
    def test_verify_reports_drift_between_live_and_source(self):
        self.promote()
        # Simulate someone editing the live copy by hand: verify has to notice.
        live = os.path.join(self.guard_dir, self.NAME)
        with open(live, 'a') as fh:
            fh.write('# tampered\n')
        report = promote_guard.verify(self.NAME, repo_root=self.root,
                                      guard_dir=self.guard_dir)
        self.assertFalse(report['manifest_matches_live'])

    def test_verify_is_clean_right_after_a_promotion(self):
        self.promote()
        report = promote_guard.verify(self.NAME, repo_root=self.root,
                                      guard_dir=self.guard_dir)
        self.assertTrue(report['manifest_matches_live'])
        self.assertTrue(report['live_matches_source'])

    def test_verify_sees_source_ahead_of_live(self):
        # The everyday state after this change: the repo moves on, the fleet
        # keeps running the promoted copy until someone promotes deliberately.
        self.promote()
        self.write('scripts/hooks/' + self.NAME, GUARD_V2 + '# newer\n')
        report = promote_guard.verify(self.NAME, repo_root=self.root,
                                      guard_dir=self.guard_dir)
        self.assertTrue(report['manifest_matches_live'])
        self.assertFalse(report['live_matches_source'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
