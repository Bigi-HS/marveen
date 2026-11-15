#!/usr/bin/env python3
"""Unit tests for ci-local.py (card 24b12610): the generalized local CI-parity
runner. Covers only the pure, side-effect-free helpers -- arg parsing, the
PGB verdict mappings (reused, not re-encoded), the --compare-live drift
computation, and the evidence-sheet formatter. The worktree git-plumbing is a
thin shell over subprocess (mirroring buster-ci-runner.py's inline copy) and is
exercised end-to-end by the author before the gate.

Run: python3 scripts/__tests__/ci-local.test.py
"""
import importlib.util
import os
import unittest
from pathlib import Path

_MOD_PATH = Path(__file__).parent.parent / 'ci-local.py'


def _load():
    spec = importlib.util.spec_from_file_location('ci_local', _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


c = _load()


class TestParseArgs(unittest.TestCase):
    def test_defaults(self):
        a = c.parse_args([])
        self.assertEqual(a['base'], 'develop')
        self.assertEqual(a['head'], 'HEAD')
        self.assertEqual(a['agent'], 'dave')
        self.assertIsNone(a['pr'])
        self.assertFalse(a['compare_live'])
        self.assertFalse(a['json_out'])
        self.assertFalse(a['dry_run'])

    def test_pr_mode(self):
        a = c.parse_args(['--pr', '996'])
        self.assertEqual(a['pr'], 996)

    def test_agent_override_generalized(self):
        # The runner is generalized (NoA Q2): any agent can run its own parity check.
        a = c.parse_args(['--agent', 'thor'])
        self.assertEqual(a['agent'], 'thor')

    def test_base_head_override(self):
        a = c.parse_args(['--base', 'main', '--head', 'abc1234'])
        self.assertEqual(a['base'], 'main')
        self.assertEqual(a['head'], 'abc1234')

    def test_flags(self):
        a = c.parse_args(['--compare-live', '--json', '--dry-run'])
        self.assertTrue(a['compare_live'])
        self.assertTrue(a['json_out'])
        self.assertTrue(a['dry_run'])


class TestVerdictMapping(unittest.TestCase):
    """Parity with pre-gate-bundle.sh / buster-ci-runner: PASS|WARN -> pass,
    BLOCK -> fail; exit 1 only on BLOCK."""

    def test_ci_status_pass_warn(self):
        self.assertEqual(c.verdict_to_ci_status('PASS'), 'pass')
        self.assertEqual(c.verdict_to_ci_status('WARN'), 'pass')

    def test_ci_status_block(self):
        self.assertEqual(c.verdict_to_ci_status('BLOCK'), 'fail')

    def test_ci_status_unknown_is_fail(self):
        # Fail-closed: an unparseable verdict must not read as green.
        self.assertEqual(c.verdict_to_ci_status('???'), 'fail')

    def test_exit_code_parity(self):
        self.assertEqual(c.verdict_to_exit('PASS'), 0)
        self.assertEqual(c.verdict_to_exit('WARN'), 0)
        self.assertEqual(c.verdict_to_exit('BLOCK'), 1)
        self.assertEqual(c.verdict_to_exit('???'), 1)


class TestComputeDrift(unittest.TestCase):
    """--compare-live: local verdict vs the posted ci_status. Read-only alarm."""

    def test_no_live_yet(self):
        d = c.compute_drift('PASS', 'none')
        self.assertFalse(d['drift'])
        self.assertIn('none', d['message'])

    def test_agree_pass(self):
        d = c.compute_drift('WARN', 'pass')
        self.assertFalse(d['drift'])

    def test_agree_fail(self):
        d = c.compute_drift('BLOCK', 'fail')
        self.assertFalse(d['drift'])

    def test_drift_local_pass_live_fail(self):
        d = c.compute_drift('PASS', 'fail')
        self.assertTrue(d['drift'])
        self.assertIn('DRIFT', d['message'])

    def test_drift_local_fail_live_pass(self):
        # Stale-live case: local BLOCK but the board still says pass.
        d = c.compute_drift('BLOCK', 'pass')
        self.assertTrue(d['drift'])


class TestFormatEvidence(unittest.TestCase):
    def setUp(self):
        self.bundle = {
            'verdict': 'WARN',
            'diff_additions': 42,
            'diff_files': 3,
            'checks': [
                {'name': 'typecheck', 'status': 'PASS', 'detail': 'no type errors'},
                {'name': 'tests', 'status': 'PASS', 'detail': '6078 pass'},
                {'name': 'diff-size', 'status': 'WARN', 'detail': '42 additions'},
            ],
        }

    def test_contains_agent_and_verdict(self):
        sheet = c.format_evidence(self.bundle, 'armorer')
        self.assertIn('armorer', sheet)
        self.assertIn('WARN', sheet)

    def test_lists_every_check(self):
        sheet = c.format_evidence(self.bundle, 'dave')
        for name in ('typecheck', 'tests', 'diff-size'):
            self.assertIn(name, sheet)
        self.assertIn('no type errors', sheet)

    def test_empty_bundle_safe(self):
        # A missing/unparseable bundle must not crash the formatter.
        sheet = c.format_evidence({}, 'dave')
        self.assertIn('dave', sheet)

    def test_head_sha_provenance(self):
        # The checked commit SHA is recorded for provenance when provided.
        sheet = c.format_evidence(self.bundle, 'dave', head_sha='abc1234def')
        self.assertIn('abc1234def', sheet)

    def test_no_head_sha_omits_checked_line(self):
        # Backward-compatible: no SHA -> no 'checked:' line, no crash.
        sheet = c.format_evidence(self.bundle, 'dave')
        self.assertNotIn('checked:', sheet)


if __name__ == '__main__':
    unittest.main()
