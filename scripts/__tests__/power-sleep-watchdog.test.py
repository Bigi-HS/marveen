#!/usr/bin/env python3
"""
Unit tests for power-sleep-watchdog.py (card cf507699 nit-3).

Verifies the exit-code contract:
  exit 0  -- AC STANDBYIDLE == 0x00000000 (OK, no drift)
  exit 1  -- error (powershell missing / timeout / parse failure)
  exit 2  -- drift detected (non-zero STANDBYIDLE value)

Run: python3 scripts/__tests__/power-sleep-watchdog.test.py
"""
import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_SCRIPT_PATH = Path(__file__).parent.parent.parent / 'scripts' / 'power-sleep-watchdog.py'


def _load_module():
    spec = importlib.util.spec_from_file_location('power_sleep_watchdog', _SCRIPT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestExitContracts(unittest.TestCase):
    """Exit-code contract: 0=ok, 1=error, 2=drift."""

    def setUp(self):
        self.mod = _load_module()

    def _run_main(self):
        with self.assertRaises(SystemExit) as cm:
            self.mod.main()
        return cm.exception.code

    def test_exit_0_when_standbyidle_disabled(self):
        """exit 0 when AC STANDBYIDLE is 0x00000000 (no drift)."""
        fake_output = (
            "Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e\n"
            "  GUID Alias: SCHEME_CURRENT\n"
            "  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20\n"
            "    GUID Alias: SUB_SLEEP\n"
            "    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da\n"
            "      GUID Alias: STANDBYIDLE\n"
            "      Current AC Power Setting Index: 0x00000000\n"
        )
        mock_result = MagicMock()
        mock_result.stdout = fake_output
        with patch('os.path.exists', return_value=True), \
             patch('subprocess.run', return_value=mock_result), \
             patch.object(self.mod, 'log'):
            code = self._run_main()
        self.assertEqual(code, 0)

    def test_exit_2_on_drift(self):
        """exit 2 when AC STANDBYIDLE is non-zero (drift detected)."""
        fake_output = (
            "      Current AC Power Setting Index: 0x00000384\n"
        )
        mock_result = MagicMock()
        mock_result.stdout = fake_output
        with patch('os.path.exists', return_value=True), \
             patch('subprocess.run', return_value=mock_result), \
             patch.object(self.mod, 'log'), \
             patch('urllib.request.urlopen', side_effect=Exception('mock')):
            code = self._run_main()
        self.assertEqual(code, 2)

    def test_exit_1_when_powershell_missing(self):
        """exit 1 when powershell.exe not found."""
        with patch('os.path.exists', return_value=False), \
             patch.object(self.mod, 'log'):
            code = self._run_main()
        self.assertEqual(code, 1)

    def test_exit_1_on_timeout(self):
        """exit 1 when powercfg times out (TimeoutExpired -> None -> exit 1)."""
        with patch('os.path.exists', return_value=True), \
             patch('subprocess.run', side_effect=subprocess.TimeoutExpired(cmd='powercfg', timeout=15)), \
             patch.object(self.mod, 'log'):
            code = self._run_main()
        self.assertEqual(code, 1)

    def test_exit_1_when_parse_fails(self):
        """exit 1 when powercfg output has no recognisable index line."""
        mock_result = MagicMock()
        mock_result.stdout = "unexpected output with no index line\n"
        with patch('os.path.exists', return_value=True), \
             patch('subprocess.run', return_value=mock_result), \
             patch.object(self.mod, 'log'):
            code = self._run_main()
        self.assertEqual(code, 1)

    def test_split_limit_handles_colon_in_value(self):
        """split(':', 1) correctly handles a value string that itself contains ':'."""
        fake_output = "      Current AC Power Setting Index: 0x00:00:00\n"
        mock_result = MagicMock()
        mock_result.stdout = fake_output
        with patch('os.path.exists', return_value=True), \
             patch('subprocess.run', return_value=mock_result), \
             patch.object(self.mod, 'log'), \
             patch('urllib.request.urlopen', side_effect=Exception('mock')):
            code = self._run_main()
        # value "0x00:00:00" != "0x00000000" -> drift -> exit 2
        self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()
