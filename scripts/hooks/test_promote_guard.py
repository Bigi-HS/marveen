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
    scripts/hooks/test_<guard>.py, scripts/hooks/canary_guardrail_example.py.

    Includes a bare 'origin' with a 'develop' branch so that the blob-presence
    gate (_require_on_develop, card 8c754df8 Part 2) passes for the initial
    guard files.  Tests that exercise canary/suite failures can rely on the blob
    gate having already cleared, because the guard IS on origin/develop."""

    NAME = 'guardrail-example.py'

    ENV = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t',
               GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')

    def setUp(self):
        tmp = tempfile.mkdtemp(prefix='promote-guard-test-')
        self.addCleanup(shutil.rmtree, tmp, True)
        origin = os.path.join(tmp, 'origin.git')
        self.root = os.path.join(tmp, 'clone')
        self.hooks = os.path.join(self.root, 'scripts', 'hooks')
        self.guard_dir = os.path.join(self.root, '.guard')

        subprocess.run(['git', 'init', '-q', '--bare', origin],
                       env=self.ENV, check=True, capture_output=True)
        subprocess.run(['git', 'clone', '-q', origin, self.root],
                       env=self.ENV, check=True, capture_output=True)
        os.makedirs(self.hooks)

        self.write('scripts/hooks/' + self.NAME, GUARD_V2)
        self.write('scripts/hooks/test_guardrail_example.py', EXIT_OK)
        self.write('scripts/hooks/canary_guardrail_example.py', EXIT_OK)

        for cmd in (['git', 'add', '-A'],
                    ['git', 'commit', '-q', '-m', 'seed'],
                    ['git', 'push', '-q', 'origin', 'HEAD:develop'],
                    ['git', 'fetch', 'origin']):
            subprocess.run(cmd, cwd=self.root, env=self.ENV, check=True,
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

    def test_the_suite_is_run_with_no_extra_argv(self):
        # unittest.main() parses sys.argv, so handing a suite the target path
        # makes it try to load that path as a test name and fail for a reason
        # that has nothing to do with the guard.  Found on the first real
        # promotion, which refused with "module __main__ has no attribute
        # scripts" -- fail-closed working, but reporting a false cause.
        self.write('scripts/hooks/test_guardrail_example.py',
                   'import sys\nsys.exit(0 if len(sys.argv) == 1 else 1)\n')
        self.commit_all()
        self.promote()   # must not raise

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


class BlobGateFixture(unittest.TestCase):
    """Temp-repo fixture with a bare 'origin' so _require_on_develop can be
    tested without touching the live develop branch (card 8c754df8 Part 2).

    Layout:
        self.origin  -- bare repo acting as the remote
        self.root    -- working clone with 'origin' remote pointing at it
        origin/develop is created in setUp with the guard file committed.
    """

    NAME = 'guardrail-example.py'

    ENV = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t',
               GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')

    def _git(self, args, cwd=None):
        return subprocess.run(['git'] + args, cwd=cwd or self.root,
                              env=self.ENV, capture_output=True, text=True, check=True)

    def setUp(self):
        tmp = tempfile.mkdtemp(prefix='promote-blob-test-')
        self.addCleanup(shutil.rmtree, tmp, True)
        self.origin = os.path.join(tmp, 'origin.git')
        self.root = os.path.join(tmp, 'clone')
        self.hooks = os.path.join(self.root, 'scripts', 'hooks')
        self.guard_dir = os.path.join(self.root, '.guard')

        # bare origin
        subprocess.run(['git', 'init', '-q', '--bare', self.origin],
                       env=self.ENV, check=True, capture_output=True)

        # working clone
        subprocess.run(['git', 'clone', '-q', self.origin, self.root],
                       env=self.ENV, check=True, capture_output=True)

        # seed files + commit + push to origin/develop
        os.makedirs(self.hooks)
        self._write('scripts/hooks/' + self.NAME, GUARD_V2)
        self._write('scripts/hooks/test_guardrail_example.py', EXIT_OK)
        self._write('scripts/hooks/canary_guardrail_example.py', EXIT_OK)
        self._git(['add', '-A'])
        self._git(['commit', '-q', '-m', 'seed'])
        self._git(['push', '-q', 'origin', 'HEAD:develop'])
        self._git(['fetch', 'origin'])

    def _write(self, rel, content):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as fh:
            fh.write(content)

    def _promote(self, **kwargs):
        return promote_guard.promote(self.NAME, repo_root=self.root,
                                     guard_dir=self.guard_dir, **kwargs)

    def _require_on_develop(self, source=None, **kwargs):
        if source is None:
            source = os.path.join(self.root, 'scripts', 'hooks', self.NAME)
        return promote_guard._require_on_develop(source, self.root, **kwargs)


class BlobGateRefusalTests(BlobGateFixture):
    """_require_on_develop refuses when the blob is not on origin/develop (SEC-049 Part 2)."""

    def test_passes_when_blob_matches_origin_develop(self):
        """Guard committed + pushed to develop -> gate passes, promote succeeds."""
        self._promote()   # must not raise

    def test_refuses_when_file_absent_from_develop(self):
        """A guard committed locally but NOT on develop fails the blob gate."""
        # Write and commit a new guard that was never pushed to origin/develop.
        new_name = 'guardrail-new.py'
        self._write('scripts/hooks/' + new_name, GUARD_V2)
        self._write('scripts/hooks/test_guardrail_new.py', EXIT_OK)
        self._write('scripts/hooks/canary_guardrail_new.py', EXIT_OK)
        self._git(['add', '-A'])
        self._git(['commit', '-q', '-m', 'add new guard (not pushed)'])
        # Do NOT push -- file is tracked+clean but absent from origin/develop.
        source = os.path.join(self.root, 'scripts', 'hooks', new_name)
        with self.assertRaises(promote_guard.PromotionRefused) as ctx:
            promote_guard._require_on_develop(source, self.root, force=False)
        self.assertIn('not present on origin/develop', str(ctx.exception))

    def test_refuses_when_local_blob_ahead_of_develop(self):
        """Guard is on develop but local copy has uncommitted-to-develop edits."""
        guard_path = os.path.join(self.root, 'scripts', 'hooks', self.NAME)
        with open(guard_path, 'w') as fh:
            fh.write('# guard v3 -- ahead of develop\nimport sys\nsys.exit(0)\n')
        self._git(['add', guard_path])
        self._git(['commit', '-q', '-m', 'local bump, not pushed to develop'])
        # Local blob differs from origin/develop blob.
        with self.assertRaises(promote_guard.PromotionRefused) as ctx:
            self._require_on_develop()
        self.assertIn('does not match origin/develop blob', str(ctx.exception))

    def test_force_logs_and_allows_when_file_absent_from_develop(self):
        """--force-promote bypasses refusal and logs to stderr when file absent."""
        new_name = 'guardrail-force.py'
        self._write('scripts/hooks/' + new_name, GUARD_V2)
        self._write('scripts/hooks/test_guardrail_force.py', EXIT_OK)
        self._write('scripts/hooks/canary_guardrail_force.py', EXIT_OK)
        self._git(['add', '-A'])
        self._git(['commit', '-q', '-m', 'force guard (not pushed)'])
        source = os.path.join(self.root, 'scripts', 'hooks', new_name)
        import io
        old_stderr, sys.stderr = sys.stderr, io.StringIO()
        try:
            promote_guard._require_on_develop(source, self.root, force=True)
            log = sys.stderr.getvalue()
        finally:
            sys.stderr = old_stderr
        self.assertIn('PROMOTE OVERRIDE', log)
        self.assertIn('--force-promote', log)

    def test_force_logs_and_allows_when_blob_ahead_of_develop(self):
        """--force-promote bypasses refusal and logs when local blob differs."""
        guard_path = os.path.join(self.root, 'scripts', 'hooks', self.NAME)
        with open(guard_path, 'w') as fh:
            fh.write('# guard v3 -- ahead\nimport sys\nsys.exit(0)\n')
        self._git(['add', guard_path])
        self._git(['commit', '-q', '-m', 'local bump'])
        import io
        old_stderr, sys.stderr = sys.stderr, io.StringIO()
        try:
            self._require_on_develop(force=True)
            log = sys.stderr.getvalue()
        finally:
            sys.stderr = old_stderr
        self.assertIn('PROMOTE OVERRIDE', log)
        self.assertIn('differs from origin/develop blob', log)

    def test_full_promote_fails_when_not_on_develop(self):
        """End-to-end: promote() raises when the blob is absent from develop."""
        # Write a second guard, commit but don't push.
        name2 = 'guardrail-b.py'
        self._write('scripts/hooks/' + name2, GUARD_V2)
        self._write('scripts/hooks/test_guardrail_b.py', EXIT_OK)
        self._write('scripts/hooks/canary_guardrail_b.py', EXIT_OK)
        self._git(['add', '-A'])
        self._git(['commit', '-q', '-m', 'b not pushed'])
        with self.assertRaises(promote_guard.PromotionRefused):
            promote_guard.promote(name2, repo_root=self.root, guard_dir=self.guard_dir)


def _hook_pinning_deployed():
    """True when the settings.json hook-pinning from card e571e67 is on develop.

    LiveWiringTests require that pinning; they are skipped on branches that
    cherry-picked promote-guard.py without the settings.json repointing (e.g.
    SEC-049, card 8c754df8) and will re-activate once the pinning PR lands."""
    repo = os.path.dirname(os.path.dirname(_HERE))
    template = os.path.join(repo, 'templates', 'settings.json.template')
    try:
        with open(template) as fh:
            text = fh.read()
        return '.guard/guardrail-permission-rules.py' in text
    except OSError:
        return False


@unittest.skipUnless(_hook_pinning_deployed(),
                     'settings.json hook-pinning (card e571e67) not yet on '
                     'develop -- LiveWiringTests activate after that PR lands')
class LiveWiringTests(unittest.TestCase):
    """Assertions about THIS repo rather than a fixture, because the wiring IS
    the deployment: if a hook config drifts back to the checkout copy, the
    promoter still works perfectly and protects nothing.

    These pins were written after the change, so they prove nothing on their own
    -- a pin that only ever agrees with you is not an instrument.  The teeth are
    in test_the_pin_rejects_the_spelling_it_replaced, which runs the same
    predicate over the OLD committed text and requires it to fail."""

    REPO = os.path.dirname(os.path.dirname(_HERE))
    PROMOTED = '.guard/guardrail-permission-rules.py'
    CHECKOUT_SPELLING = 'scripts/hooks/guardrail-permission-rules.py'
    CONFIGS = ['.claude/settings.json', 'templates/settings.json.template']

    def read(self, rel):
        with open(os.path.join(self.REPO, rel)) as fh:
            return fh.read()

    @staticmethod
    def wiring_is_pinned(text):
        """A hook config is pinned iff it names the promoted guard and never the
        checkout copy of it."""
        return ('.guard/guardrail-permission-rules.py' in text
                and 'scripts/hooks/guardrail-permission-rules.py' not in text)

    def test_every_hook_config_is_pinned_to_the_promoted_guard(self):
        for rel in self.CONFIGS:
            self.assertTrue(self.wiring_is_pinned(self.read(rel)),
                            '%s does not name the promoted guard, or still names '
                            'the checkout copy' % rel)

    def test_the_pin_rejects_the_spelling_it_replaced(self):
        # The predicate has to be able to fail, so run it on what was committed
        # before this change.  Note .claude/settings.json is GITIGNORED -- the
        # fleet's live hook config has no history to compare against -- so this
        # skips per file and then asserts it actually exercised something.  The
        # first draft skipped out on the first file and reported OK having
        # checked nothing.
        checked = 0
        for rel in self.CONFIGS:
            old = subprocess.run(['git', 'show', 'HEAD~1:' + rel], cwd=self.REPO,
                                 capture_output=True, text=True)
            if old.returncode != 0:
                continue        # untracked (.claude) or new file: nothing to compare
            checked += 1
            self.assertFalse(self.wiring_is_pinned(old.stdout),
                             'the predicate passes the pre-change %s too, so it '
                             'is not testing anything' % rel)
        self.assertGreater(checked, 0,
                           'no config had a previous revision to test the predicate '
                           'against -- this test verified nothing')

    def test_the_promoted_guard_exists_and_is_readable(self):
        live = os.path.join(self.REPO, self.PROMOTED)
        self.assertTrue(os.path.isfile(live),
                        'settings.json points at %s but nothing is promoted there'
                        % self.PROMOTED)
        with open(live) as fh:
            source = fh.read()
        # Parses as Python: a promoted file that cannot compile would fail-open
        # on every single tool call, which is the worst outcome available here.
        compile(source, live, 'exec')


if __name__ == '__main__':
    unittest.main(verbosity=2)
