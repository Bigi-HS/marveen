#!/usr/bin/env python3
"""Tests for guard_watchdog.py (card 3ceab75a).

Scenario: .guard/guardrail-permission-rules.py disappears (e.g. git stash --all).
The watchdog detects it, copies the source from scripts/hooks/, sends an alert.
"""
import hashlib
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch, call

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import scripts.guard_watchdog as gw


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        fh.write(content)


def _sha256(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


class TestCheckGuardFile(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.mkdtemp()
        self.guard_dir = os.path.join(self.td, '.guard')
        self.source_dir = os.path.join(self.td, 'scripts', 'hooks')
        os.makedirs(self.guard_dir)
        os.makedirs(self.source_dir)

    def _check(self, name='guardrail-permission-rules.py'):
        return gw.check_guard_file(name, repo_root=self.td,
                                   guard_dir=self.guard_dir,
                                   source_dir=self.source_dir)

    def test_ok_when_live_matches_source(self):
        content = '# guard content\nprint("ok")\n'
        _write(os.path.join(self.source_dir, 'guardrail-permission-rules.py'), content)
        _write(os.path.join(self.guard_dir, 'guardrail-permission-rules.py'), content)
        result = self._check()
        self.assertEqual(result['status'], 'ok')
        self.assertFalse(result['recovered'])
        self.assertFalse(result['drifted'])

    def test_missing_live_triggers_recovery(self):
        content = '# source guard\nprint("guard")\n'
        _write(os.path.join(self.source_dir, 'guardrail-permission-rules.py'), content)
        # live file intentionally absent
        result = self._check()
        self.assertEqual(result['status'], 'recovered')
        self.assertTrue(result['recovered'])
        live = os.path.join(self.guard_dir, 'guardrail-permission-rules.py')
        self.assertTrue(os.path.isfile(live))
        with open(live) as fh:
            self.assertEqual(fh.read(), content)

    def test_recovery_preserves_exact_bytes(self):
        content = b'\xef\xbb\xbf# utf-8 bom guard\n'
        src_path = os.path.join(self.source_dir, 'guardrail-permission-rules.py')
        with open(src_path, 'wb') as fh:
            fh.write(content)
        self._check()
        live = os.path.join(self.guard_dir, 'guardrail-permission-rules.py')
        with open(live, 'rb') as fh:
            self.assertEqual(fh.read(), content)

    def test_drifted_live_no_overwrite(self):
        """Live exists but differs from source -- alert only, no overwrite."""
        _write(os.path.join(self.source_dir, 'guardrail-permission-rules.py'),
               '# new source\n')
        _write(os.path.join(self.guard_dir, 'guardrail-permission-rules.py'),
               '# old live\n')
        result = self._check()
        self.assertEqual(result['status'], 'drifted')
        self.assertFalse(result['recovered'])
        self.assertTrue(result['drifted'])
        # live must NOT be overwritten
        with open(os.path.join(self.guard_dir, 'guardrail-permission-rules.py')) as fh:
            self.assertEqual(fh.read(), '# old live\n')

    def test_missing_source_raises(self):
        """No source file in scripts/hooks/ -- watchdog can't recover."""
        with self.assertRaises(gw.GuardSourceMissing):
            self._check()

    def test_missing_guard_dir_created_on_recovery(self):
        """If .guard/ itself was wiped, the directory is recreated."""
        import shutil
        shutil.rmtree(self.guard_dir)
        content = '# guard\n'
        _write(os.path.join(self.source_dir, 'guardrail-permission-rules.py'), content)
        result = self._check()
        self.assertEqual(result['status'], 'recovered')
        live = os.path.join(self.guard_dir, 'guardrail-permission-rules.py')
        self.assertTrue(os.path.isfile(live))


class TestRunWatchdog(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.mkdtemp()
        self.guard_dir = os.path.join(self.td, '.guard')
        self.source_dir = os.path.join(self.td, 'scripts', 'hooks')
        os.makedirs(self.guard_dir)
        os.makedirs(self.source_dir)

    def _run(self, guards=None, api_url=None, token=None):
        return gw.run_watchdog(
            guards or ['guardrail-permission-rules.py'],
            repo_root=self.td,
            guard_dir=self.guard_dir,
            source_dir=self.source_dir,
            api_url=api_url or 'http://localhost:3420',
            token=token or 'test-token',
        )

    def test_all_ok_returns_empty_alerts(self):
        content = '# guard\n'
        _write(os.path.join(self.source_dir, 'guardrail-permission-rules.py'), content)
        _write(os.path.join(self.guard_dir, 'guardrail-permission-rules.py'), content)
        with patch.object(gw, '_send_alert') as mock_alert:
            results = self._run()
        mock_alert.assert_not_called()
        self.assertEqual(results[0]['status'], 'ok')

    def test_missing_live_sends_alert(self):
        _write(os.path.join(self.source_dir, 'guardrail-permission-rules.py'), '# guard\n')
        with patch.object(gw, '_send_alert') as mock_alert:
            results = self._run()
        self.assertTrue(results[0]['recovered'])
        mock_alert.assert_called_once()
        alert_call = mock_alert.call_args
        # alert must mention the guard name
        self.assertIn('guardrail-permission-rules.py', str(alert_call))

    def test_drifted_live_sends_alert_without_recovery(self):
        _write(os.path.join(self.source_dir, 'guardrail-permission-rules.py'), '# new\n')
        _write(os.path.join(self.guard_dir, 'guardrail-permission-rules.py'), '# old\n')
        with patch.object(gw, '_send_alert') as mock_alert:
            results = self._run()
        self.assertTrue(results[0]['drifted'])
        mock_alert.assert_called_once()

    def test_missing_source_sends_alert_and_does_not_crash(self):
        """No source available -- alert fires, watchdog continues."""
        with patch.object(gw, '_send_alert') as mock_alert:
            results = self._run()
        self.assertEqual(results[0]['status'], 'error')
        mock_alert.assert_called_once()

    def test_send_alert_failure_does_not_crash_watchdog(self):
        _write(os.path.join(self.source_dir, 'guardrail-permission-rules.py'), '# guard\n')
        # live missing → recovery triggered → alert attempted
        with patch.object(gw, '_send_alert', side_effect=Exception('network down')):
            results = self._run()
        # must not raise; result still reflects recovery
        self.assertTrue(results[0]['recovered'])


if __name__ == '__main__':
    unittest.main()
