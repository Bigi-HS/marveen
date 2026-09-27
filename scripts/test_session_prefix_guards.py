#!/usr/bin/env python3
"""Tests for the two session-name prefix guards.

Written the way Forge does it: every assertion is first shown to FAIL on a
mutated input. A guard that has only ever been run on a healthy system has not
been tested, it has been watched.

Run: python3 scripts/test_session_prefix_guards.py
"""
import os
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from session_prefix_guard import (  # noqa: E402
    EXIT_OK, EXIT_UNMEASURABLE, EXIT_VIOLATION, Unmeasurable, derive_source_names,
    find_pairs, glob_risky, known_pairs, read_live_names, unsanctioned,
)

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)


def stub_tmux(body: str) -> str:
    """A directory containing a fake `tmux` that runs `body`. Returns the dir."""
    d = tempfile.mkdtemp(prefix='chad-stub-tmux-')
    path = os.path.join(d, 'tmux')
    with open(path, 'w') as fh:
        fh.write('#!/bin/sh\n' + body + '\n')
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return d


class PairDetection(unittest.TestCase):
    def test_detects_planted_pair(self):
        self.assertEqual(find_pairs(['alpha', 'alpha-channels']),
                         [('alpha', 'alpha-channels')])

    def test_unrelated_names_are_clean(self):
        # bond/bonny is the near-miss that looks dangerous and is not: the
        # names diverge at the 8th character, so neither is a prefix.
        self.assertEqual(find_pairs(['agent-bond', 'agent-bonny']), [])

    def test_pair_detection_is_symmetric_only_one_way(self):
        pairs = find_pairs(['x', 'xy'])
        self.assertEqual(pairs, [('x', 'xy')])
        self.assertNotIn(('xy', 'x'), pairs)


class Allowlist(unittest.TestCase):
    def test_sanctioned_pair_passes(self):
        names = ['marveen', 'marveen-channels']
        bad = unsanctioned(find_pairs(names), known_pairs('marveen'))
        self.assertEqual(bad, [])

    def test_allowlist_is_exact_not_a_pattern(self):
        # MUTATION: a third name that merely LOOKS like the sanctioned family.
        # A prefix- or regex-based exemption would swallow these; exact tuples
        # must not.
        names = ['marveen', 'marveen-channels', 'marveen-channels-2']
        bad = unsanctioned(find_pairs(names), known_pairs('marveen'))
        self.assertIn(('marveen', 'marveen-channels-2'), bad)
        self.assertIn(('marveen-channels', 'marveen-channels-2'), bad)
        self.assertNotIn(('marveen', 'marveen-channels'), bad)

    def test_allowlist_follows_a_renamed_main_agent(self):
        # The exemption is DERIVED, so renaming the fleet's main agent carries
        # it along instead of silently re-arming the hazard.
        sanctioned = known_pairs('noa')
        self.assertIn(('noa', 'noa-channels'), sanctioned)
        self.assertNotIn(('marveen', 'marveen-channels'), sanctioned)

    def test_every_allowlist_entry_carries_a_reason(self):
        for pair, reason in known_pairs('marveen').items():
            self.assertGreater(len(reason), 40, f'{pair} needs a real reason')
            self.assertIn('OPS-106', reason, f'{pair} needs an owner')


class ThirdOutcome(unittest.TestCase):
    """The bug that started this: 'could not measure' collapsing into 'pass'."""

    def _with_stub(self, body, fn):
        d = stub_tmux(body)
        old = os.environ['PATH']
        os.environ['PATH'] = d + os.pathsep + old
        try:
            return fn()
        finally:
            os.environ['PATH'] = old

    def test_tmux_failure_is_unmeasurable_not_clean(self):
        def run():
            with self.assertRaises(Unmeasurable):
                read_live_names()
        self._with_stub('echo "error connecting" >&2; exit 1', run)

    def test_zero_sessions_is_unmeasurable_not_clean(self):
        # rc=0 but empty output. On a live fleet the count is never zero, so an
        # empty result means the measurement failed.
        def run():
            with self.assertRaises(Unmeasurable):
                read_live_names()
        self._with_stub('exit 0', run)

    def test_missing_tmux_is_unmeasurable(self):
        with self.assertRaises(Unmeasurable):
            read_live_names(tmux='/nonexistent/tmux-does-not-exist')

    def test_detector_exits_2_on_stub_failure(self):
        d = stub_tmux('echo "error connecting" >&2; exit 1')
        env = dict(os.environ, PATH=d + os.pathsep + os.environ['PATH'])
        p = subprocess.run([sys.executable,
                            os.path.join(SCRIPTS, '_hb-session-prefix-detector.py')],
                           capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, EXIT_UNMEASURABLE,
                         f'expected exit 2, got {p.returncode}: {p.stdout}{p.stderr}')
        self.assertIn('UNMEASURABLE', p.stdout)

    def test_detector_exits_1_on_planted_live_violation(self):
        d = stub_tmux('printf "marveen\\nmarveen-channels\\nmarveen-worker\\n"')
        env = dict(os.environ, PATH=d + os.pathsep + os.environ['PATH'])
        p = subprocess.run([sys.executable,
                            os.path.join(SCRIPTS, '_hb-session-prefix-detector.py')],
                           capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, EXIT_VIOLATION, p.stdout)
        self.assertIn('marveen-worker', p.stdout)

    def test_detector_exits_0_on_planted_clean_state(self):
        d = stub_tmux('printf "marveen\\nmarveen-channels\\nagent-thor\\n"')
        env = dict(os.environ, PATH=d + os.pathsep + os.environ['PATH'])
        p = subprocess.run([sys.executable,
                            os.path.join(SCRIPTS, '_hb-session-prefix-detector.py')],
                           capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, EXIT_OK, p.stdout)


class WhitespaceNames(unittest.TestCase):
    """tmux permits spaces in session names; str.split() corrupts them."""

    def test_splitlines_preserves_spaced_names(self):
        d = stub_tmux('printf "my agent\\nmy agent-channels\\n"')
        old = os.environ['PATH']
        os.environ['PATH'] = d + os.pathsep + old
        try:
            names = read_live_names()
        finally:
            os.environ['PATH'] = old
        self.assertEqual(names, ['my agent', 'my agent-channels'])
        self.assertEqual(find_pairs(names), [('my agent', 'my agent-channels')])

    def test_split_would_have_been_wrong_in_both_directions(self):
        # Regression witness for the original bug: whitespace-splitting invents
        # a pair that does not exist AND loses the one that does.
        raw = 'my agent\nmy agent-channels\n'
        wrong = find_pairs(sorted(raw.split()))
        self.assertIn(('agent', 'agent-channels'), wrong, 'bogus pair invented')
        self.assertNotIn(('my agent', 'my agent-channels'), wrong, 'true pair lost')


class GlobNames(unittest.TestCase):
    def test_glob_characters_are_surfaced(self):
        self.assertEqual(glob_risky(['agent-thor', 'weird*name']), ['weird*name'])

    def test_plain_names_are_not_flagged(self):
        self.assertEqual(glob_risky(['agent-thor', 'marveen-channels']), [])


class SourceLint(unittest.TestCase):
    def test_derives_real_names_from_this_repo(self):
        origins = derive_source_names(ROOT)
        self.assertIn('marveen', origins)
        self.assertIn('marveen-channels', origins)
        self.assertTrue(any(n.startswith('agent-') for n in origins))

    def test_repo_source_has_no_unsanctioned_pair(self):
        origins = derive_source_names(ROOT)
        bad = unsanctioned(find_pairs(sorted(origins)), known_pairs('marveen'))
        self.assertEqual(bad, [], f'unsanctioned prefix pairs in source: {bad}')

    def test_mutated_source_set_is_caught(self):
        # MUTATION: the exact future mistake this lint exists to stop -- someone
        # adds a worker session named after the orchestrator.
        origins = dict(derive_source_names(ROOT))
        origins['marveen-worker'] = 'planted by test'
        bad = unsanctioned(find_pairs(sorted(origins)), known_pairs('marveen'))
        self.assertIn(('marveen', 'marveen-worker'), bad)

    def test_scanner_does_not_ingest_its_own_prose(self):
        # Regression witness. The first honest run of this lint reported a
        # "marveen-worker" collision that existed only inside the detector's
        # own docstring, where it is named as the example hazard. A measurement
        # that reads its own explanation reports the example as evidence.
        origins = derive_source_names(ROOT)
        self.assertNotIn('marveen-worker', origins,
                         'scanner picked up a name that only appears in prose')

    def test_lint_cli_exits_0_on_this_repo(self):
        p = subprocess.run([sys.executable,
                            os.path.join(SCRIPTS, 'session-name-prefix-lint.py'), ROOT],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, EXIT_OK, p.stdout + p.stderr)

    def test_lint_cli_exits_2_on_a_tree_with_no_agents(self):
        with tempfile.TemporaryDirectory() as empty:
            p = subprocess.run([sys.executable,
                                os.path.join(SCRIPTS, 'session-name-prefix-lint.py'), empty],
                               capture_output=True, text=True)
            self.assertEqual(p.returncode, EXIT_UNMEASURABLE, p.stdout)
            self.assertIn('UNMEASURABLE', p.stdout)


class ToolSeparation(unittest.TestCase):
    """F2: the two guards must not share an input, or the DoD lint is green in
    CI for a reason unrelated to the change under review."""

    def test_lint_does_not_read_live_sessions(self):
        src = open(os.path.join(SCRIPTS, 'session-name-prefix-lint.py')).read()
        self.assertNotIn('read_live_names', src)
        self.assertNotIn('list-sessions', src)

    def test_detector_does_not_read_source(self):
        src = open(os.path.join(SCRIPTS, '_hb-session-prefix-detector.py')).read()
        self.assertNotIn('derive_source_names', src)


if __name__ == '__main__':
    unittest.main(verbosity=2)
