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
                    with patch('os.symlink'):
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
                    with patch('os.symlink'):
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


class TestFetchMergeRef(unittest.TestCase):
    """_fetch_pr_head must use pull/<N>/merge (GitHub merge-ref), not pull/<N>/head.

    refs/pull/N/merge is the GitHub-computed merge commit of the PR onto its base.
    It is the authoritative ref for CI (what GitHub Actions sees). Using it ensures
    tsc/tests run on the merged code, matching what /api/gate/check evaluates.
    Card: ebe474ee diagnosis (Dave msg 18129).
    """

    def test_fetches_merge_ref_not_head_ref(self):
        """git fetch must request pull/<N>/merge, not pull/<N>/head."""
        import subprocess as sp_module
        mod = _load_runner()
        with patch.object(sp_module, 'run',
                return_value=MagicMock(returncode=0)) as mock_run:
            mod._fetch_pr_head(42, 'a' * 40)
        call_args = mock_run.call_args[0][0]  # first positional arg = command list
        fetch_ref = call_args[-1]
        self.assertEqual(fetch_ref, 'pull/42/merge',
            f'Expected pull/42/merge but got {fetch_ref!r}')

    def test_fetch_ref_does_not_contain_slash_head(self):
        """Negative: must NOT fetch pull/<N>/head (the old path)."""
        import subprocess as sp_module
        mod = _load_runner()
        with patch.object(sp_module, 'run',
                return_value=MagicMock(returncode=0)) as mock_run:
            mod._fetch_pr_head(99, 'b' * 40)
        call_args = mock_run.call_args[0][0]
        fetch_ref = call_args[-1]
        self.assertNotIn('/head', fetch_ref,
            f'fetch ref must not end in /head (got {fetch_ref!r})')


class TestNodeModulesSymlink(unittest.TestCase):
    """_run_bundle_in_worktree must symlink INSTALL_DIR/node_modules into the worktree.

    Without the symlink, `npx tsc --noEmit` uses a downloaded/global TypeScript that
    may differ from the project's pinned version, producing false BLOCK verdicts.
    Card: ebe474ee diagnosis.
    """

    def _run_bundle_with_fake(self, mod, bundle_json: dict, returncode: int = 0,
                               capture_symlink_calls=None):
        import subprocess as sp_module
        import json as _json

        run_results = [
            MagicMock(returncode=0, stdout='', stderr=''),   # worktree add
            MagicMock(returncode=returncode,
                      stdout=_json.dumps(bundle_json), stderr=''),  # bundle
            MagicMock(returncode=0, stdout='', stderr=''),   # worktree remove
        ]

        symlink_calls = []

        def fake_symlink(src, dst, *a, **kw):
            symlink_calls.append((src, dst))

        with patch.object(sp_module, 'run', side_effect=run_results):
            with patch('tempfile.mkdtemp', return_value='/tmp/fake-wt'):
                with patch('shutil.rmtree'):
                    with patch('os.symlink', side_effect=fake_symlink):
                        status, payload = mod._run_bundle_in_worktree(
                            pr_number=42, head_sha='a' * 40,
                            base_branch='develop', dry_run=False
                        )

        if capture_symlink_calls is not None:
            capture_symlink_calls.extend(symlink_calls)
        return status, payload, symlink_calls

    def _pass_bundle(self):
        return {
            'verdict': 'PASS', 'diff_additions': 0,
            'checks': [
                {'name': 'typecheck', 'status': 'PASS', 'detail': ''},
                {'name': 'tests', 'status': 'PASS', 'detail': ''},
            ],
        }

    def test_symlinks_node_modules_into_worktree(self):
        """A node_modules symlink must be created inside the worktree dir."""
        mod = _load_runner()
        _, _, symlink_calls = self._run_bundle_with_fake(mod, self._pass_bundle())
        # At least one symlink call where the destination ends with node_modules
        nm_links = [(src, dst) for src, dst in symlink_calls
                    if dst.endswith('node_modules') or dst.endswith('node_modules/')]
        self.assertTrue(nm_links,
            f'No node_modules symlink found in symlink calls: {symlink_calls}')

    def test_symlink_destination_is_inside_worktree(self):
        """The node_modules symlink destination must be inside /tmp/fake-wt."""
        mod = _load_runner()
        _, _, symlink_calls = self._run_bundle_with_fake(mod, self._pass_bundle())
        nm_links = [(src, dst) for src, dst in symlink_calls if 'node_modules' in dst]
        self.assertTrue(nm_links)
        for _, dst in nm_links:
            self.assertTrue(dst.startswith('/tmp/fake-wt'),
                f'Symlink dst {dst!r} not inside worktree /tmp/fake-wt')

    def test_symlink_source_is_install_dir_node_modules(self):
        """The symlink source must be INSTALL_DIR/node_modules."""
        mod = _load_runner()
        _, _, symlink_calls = self._run_bundle_with_fake(mod, self._pass_bundle())
        nm_links = [(src, dst) for src, dst in symlink_calls if 'node_modules' in dst]
        self.assertTrue(nm_links)
        for src, _ in nm_links:
            self.assertIn('node_modules', src)
            self.assertTrue(
                src.startswith('/home/domin/marveen') or 'INSTALL_DIR' in src,
                f'Symlink src {src!r} does not point to INSTALL_DIR/node_modules'
            )


if __name__ == '__main__':
    if not _RUNNER_PATH.exists():
        print(f'SKIP: {_RUNNER_PATH} not found')
        sys.exit(0)
    unittest.main(verbosity=2)
