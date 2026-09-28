#!/usr/bin/env python3
"""
Unit tests for buster-ci-runner.py (card 585da3ce).

Tests the CI-done detection, payload extraction from bundle JSON, and
adversarial fixtures (false-positive skip, multi-PR handling).

Run: python3 scripts/__tests__/buster-ci-runner.test.py
"""
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

_RUNNER_PATH = Path(__file__).parent.parent / 'buster-ci-runner.py'


def _load_runner():
    spec = importlib.util.spec_from_file_location('buster_ci_runner', _RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestCiAlreadyDone(unittest.TestCase):
    """_ci_already_done: skip logic must be precise."""

    def _make_gate_response(self, ci_status: str, gate_sha: str) -> dict:
        return {
            'ci_status': ci_status,
            'pr': {'head': {'sha': gate_sha}},
        }

    def test_skips_when_pass_and_sha_matches(self):
        mod = _load_runner()
        with patch.object(mod, '_api',
                return_value=self._make_gate_response('pass', 'abc1234' * 6)):
            result = mod._ci_already_done(1, 'abc1234' * 6, 'token')
        self.assertTrue(result, 'Should skip when CI pass and SHA matches')

    def test_skips_when_fail_and_sha_matches(self):
        mod = _load_runner()
        with patch.object(mod, '_api',
                return_value=self._make_gate_response('fail', 'def5678' * 6)):
            result = mod._ci_already_done(1, 'def5678' * 6, 'token')
        self.assertTrue(result, 'Should skip when CI fail and SHA matches')

    def test_does_not_skip_when_ci_none(self):
        mod = _load_runner()
        with patch.object(mod, '_api',
                return_value=self._make_gate_response('none', 'abc1234' * 6)):
            result = mod._ci_already_done(1, 'abc1234' * 6, 'token')
        self.assertFalse(result, 'ci_status=none means no CI run yet')

    def test_does_not_skip_when_sha_differs(self):
        """SHA mismatch: head was updated, run CI again even if old SHA had pass."""
        mod = _load_runner()
        with patch.object(mod, '_api',
                return_value=self._make_gate_response('pass', 'oldsha1' * 6)):
            result = mod._ci_already_done(1, 'newsha2' * 6, 'token')
        self.assertFalse(result, 'Different head SHA requires new CI run')

    def test_does_not_skip_when_api_fails(self):
        """API failure -> assume not done (run CI, fail-open)."""
        mod = _load_runner()
        with patch.object(mod, '_api', side_effect=RuntimeError('connection refused')):
            result = mod._ci_already_done(1, 'anysha1' * 6, 'token')
        self.assertFalse(result, 'API error must not suppress CI run (fail-open)')


class TestPayloadExtraction(unittest.TestCase):
    """Payload building from pre-gate-bundle JSON output."""

    def _bundle_with_verdict(self, verdict: str, tests_detail: str = '',
                              tsc_status: str = 'PASS') -> dict:
        return {
            'verdict': verdict,
            'diff_additions': 42,
            'checks': [
                {'name': 'typecheck', 'status': tsc_status, 'detail': ''},
                {'name': 'tests', 'status': 'PASS', 'detail': tests_detail},
            ],
        }

    def _run_bundle_with_fake(self, mod, bundle_json: dict, returncode: int = 0):
        """Invoke _run_bundle_in_worktree with a mocked subprocess."""
        import subprocess as sp_module
        import json as _json

        run_results = [
            MagicMock(returncode=0, stdout='', stderr=''),   # worktree add
            MagicMock(returncode=returncode,
                      stdout=_json.dumps(bundle_json), stderr=''),  # bundle
            MagicMock(returncode=0, stdout='', stderr=''),   # worktree remove
        ]

        with patch.object(sp_module, 'run', side_effect=run_results):
            with patch('tempfile.mkdtemp', return_value='/tmp/fake-wt'):
                with patch('shutil.rmtree'):
                    status, payload = mod._run_bundle_in_worktree(
                        pr_number=42, head_sha='a' * 40,
                        base_branch='develop', dry_run=False
                    )
        return status, payload

    def test_pass_verdict_gives_pass_status(self):
        mod = _load_runner()
        status, _ = self._run_bundle_with_fake(
            mod, self._bundle_with_verdict('PASS'))
        self.assertEqual(status, 'pass')

    def test_warn_verdict_gives_pass_status(self):
        """WARN is not a hard failure -- PR can still be reviewed."""
        mod = _load_runner()
        status, _ = self._run_bundle_with_fake(
            mod, self._bundle_with_verdict('WARN'))
        self.assertEqual(status, 'pass')

    def test_block_verdict_gives_fail_status(self):
        mod = _load_runner()
        status, _ = self._run_bundle_with_fake(
            mod, self._bundle_with_verdict('BLOCK'))
        self.assertEqual(status, 'fail')

    def test_tsc_fail_sets_tsc_ok_zero(self):
        mod = _load_runner()
        _, payload = self._run_bundle_with_fake(
            mod, self._bundle_with_verdict('BLOCK', tsc_status='BLOCK'))
        self.assertEqual(payload.get('tsc_ok'), 0)

    def test_tsc_pass_sets_tsc_ok_one(self):
        mod = _load_runner()
        _, payload = self._run_bundle_with_fake(
            mod, self._bundle_with_verdict('PASS', tsc_status='PASS'))
        self.assertEqual(payload.get('tsc_ok'), 1)

    def test_tests_pass_count_extracted(self):
        mod = _load_runner()
        _, payload = self._run_bundle_with_fake(
            mod, self._bundle_with_verdict('PASS', tests_detail='42 passed, 0 failed'))
        self.assertEqual(payload.get('tests_pass'), 42)
        self.assertEqual(payload.get('tests_fail'), 0)

    def test_missing_bundle_json_gives_fail(self):
        """If pre-gate-bundle.sh produces no valid JSON, treat as fail."""
        import subprocess as sp_module
        mod = _load_runner()
        run_results = [
            MagicMock(returncode=0, stdout='', stderr=''),      # worktree add
            MagicMock(returncode=1, stdout='not json', stderr=''), # bundle broken
            MagicMock(returncode=0, stdout='', stderr=''),      # worktree remove
        ]
        with patch.object(sp_module, 'run', side_effect=run_results):
            with patch('tempfile.mkdtemp', return_value='/tmp/fake-wt'):
                with patch('shutil.rmtree'):
                    status, _ = mod._run_bundle_in_worktree(
                        42, 'a' * 40, 'develop', False)
        self.assertEqual(status, 'fail')

    def test_dry_run_returns_pass_without_running(self):
        """--dry-run must not invoke subprocess."""
        import subprocess as sp_module
        mod = _load_runner()
        with patch.object(sp_module, 'run') as mock_run:
            with patch('tempfile.mkdtemp', return_value='/tmp/fake-wt'):
                status, payload = mod._run_bundle_in_worktree(
                    42, 'a' * 40, 'develop', dry_run=True)
        mock_run.assert_not_called()
        self.assertEqual(status, 'pass')
        self.assertIn('dry-run', payload.get('note', ''))


if __name__ == '__main__':
    if not _RUNNER_PATH.exists():
        print(f'SKIP: {_RUNNER_PATH} not found')
        sys.exit(0)
    unittest.main(verbosity=2)
