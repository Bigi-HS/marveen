#!/usr/bin/env python3
"""Unit tests for scripts/hooks/telemetry-emit.py (card 8b3b0408).

Tests: event building from hook JSON, PII safety (tool input never sent),
emit call mechanics, and the falsifying test (no event without emit).

Run: python3 scripts/__tests__/telemetry-emit.test.py
"""
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

_HOOK_PATH = Path(__file__).parent.parent / 'hooks' / 'telemetry-emit.py'


def _load_hook():
    spec = importlib.util.spec_from_file_location('telemetry_emit', _HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestBuildEvent(unittest.TestCase):
    """build_event: maps hook JSON -> event dict."""

    def _load(self):
        return _load_hook()

    def test_basic_tool_call(self):
        mod = self._load()
        with patch.dict(os.environ, {'GENESIS_AGENT_ID': 'dave'}, clear=False):
            event = mod.build_event({
                'tool_name': 'Bash',
                'session_id': 'sess-abc',
                'tool_response': {'output': 'ok'},
            })
        self.assertIsNotNone(event)
        self.assertEqual(event['actor'], 'dave')
        self.assertEqual(event['verb'], 'tool-call')
        self.assertEqual(event['object'], 'Bash')
        self.assertEqual(event['object_type'], 'tool')

    def test_missing_tool_name_returns_none(self):
        mod = self._load()
        self.assertIsNone(mod.build_event({}))
        self.assertIsNone(mod.build_event({'tool_name': ''}))

    def test_actor_defaults_to_unknown(self):
        mod = self._load()
        env = dict(os.environ)
        env.pop('GENESIS_AGENT_ID', None)
        with patch.dict(os.environ, env, clear=True):
            event = mod.build_event({'tool_name': 'Read'})
        self.assertEqual(event['actor'], 'unknown')

    def test_error_response_maps_to_error_status(self):
        mod = self._load()
        event = mod.build_event({
            'tool_name': 'Bash',
            'tool_response': {'error': 'command failed'},
        })
        self.assertEqual(event['status'], 'error')

    def test_success_response_maps_to_ok_status(self):
        mod = self._load()
        event = mod.build_event({'tool_name': 'Read', 'tool_response': {'content': '...'}})
        self.assertEqual(event['status'], 'ok')

    def test_session_id_in_meta(self):
        mod = self._load()
        with patch.dict(os.environ, {'GENESIS_AGENT_ID': 'dave'}, clear=False):
            event = mod.build_event({'tool_name': 'Bash', 'session_id': 'my-session'})
        self.assertEqual(event['meta']['session_id'], 'my-session')

    def test_no_raw_tool_input_in_event(self):
        """SECURITY: raw tool input (command body, file content) must NEVER be in event."""
        mod = self._load()
        event = mod.build_event({
            'tool_name': 'Bash',
            'tool_input': {'command': 'rm -rf /secret', 'description': 'dangerous command'},
            'tool_response': {},
        })
        event_str = json.dumps(event)
        self.assertNotIn('rm -rf', event_str)
        self.assertNotIn('dangerous command', event_str)
        self.assertNotIn('command', event_str)


class TestEmit(unittest.TestCase):
    """emit: HTTP POST mechanics."""

    def _load(self):
        return _load_hook()

    def test_posts_to_api_telemetry(self):
        mod = self._load()
        with patch.dict(os.environ, {
            'GENESIS_AGENT_ID': 'dave',
            'DASHBOARD_URL': 'http://localhost:3420',
        }, clear=False):
            with patch('urllib.request.urlopen') as mock_open:
                ctx = MagicMock()
                ctx.__enter__ = lambda s: s
                ctx.__exit__ = MagicMock(return_value=False)
                mock_open.return_value = ctx
                mod.emit({'actor': 'dave', 'verb': 'tool-call', 'object': 'Bash'})
            req = mock_open.call_args[0][0]
            self.assertIn('/api/telemetry', req.full_url)

    def test_no_emit_without_token(self):
        """emit is a no-op when no token is available."""
        mod = self._load()
        env = dict(os.environ)
        env.pop('GENESIS_AGENT_TOKEN', None)
        env.pop('BUSTER_CI_TOKEN', None)
        with patch.dict(os.environ, env, clear=True):
            with patch.object(mod, '_read_token', return_value=''):
                with patch('urllib.request.urlopen') as mock_open:
                    mod.emit({'actor': 'x', 'verb': 'tool-call'})
                mock_open.assert_not_called()

    def test_no_emit_to_non_loopback(self):
        """emit refuses to POST to a non-localhost DASHBOARD_URL."""
        mod = self._load()
        with patch.dict(os.environ, {
            'DASHBOARD_URL': 'https://external.example.com',
            'GENESIS_AGENT_TOKEN': 'some-token',
        }, clear=False):
            with patch('urllib.request.urlopen') as mock_open:
                mod.emit({'actor': 'x', 'verb': 'tool-call'})
            mock_open.assert_not_called()

    def test_emit_swallows_network_error(self):
        """A network failure in emit must NOT propagate (hook always exits 0)."""
        mod = self._load()
        with patch.dict(os.environ, {
            'GENESIS_AGENT_TOKEN': 'tok',
            'DASHBOARD_URL': 'http://localhost:3420',
        }, clear=False):
            with patch('urllib.request.urlopen', side_effect=OSError('connection refused')):
                mod.emit({'actor': 'dave', 'verb': 'tool-call'})
                # No exception raised -- test passes


class TestMain(unittest.TestCase):
    """main(): always exits 0, processes stdin hook JSON."""

    def _load(self):
        return _load_hook()

    def test_exits_zero_on_valid_hook_json(self):
        mod = self._load()
        hook_json = json.dumps({
            'tool_name': 'Bash',
            'session_id': 'sess',
            'tool_response': {},
        })
        import io
        with patch('sys.stdin', io.StringIO(hook_json)):
            with patch.object(mod, 'emit') as mock_emit:
                with self.assertRaises(SystemExit) as cm:
                    mod.main()
        self.assertEqual(cm.exception.code, 0)
        mock_emit.assert_called_once()

    def test_exits_zero_on_empty_stdin(self):
        mod = self._load()
        import io
        with patch('sys.stdin', io.StringIO('')):
            with self.assertRaises(SystemExit) as cm:
                mod.main()
        self.assertEqual(cm.exception.code, 0)

    def test_exits_zero_on_invalid_json(self):
        mod = self._load()
        import io
        with patch('sys.stdin', io.StringIO('not-json')):
            with self.assertRaises(SystemExit) as cm:
                mod.main()
        self.assertEqual(cm.exception.code, 0)


class TestFalsifying(unittest.TestCase):
    """FALSIFYING: when emit is bypassed, the absence of events is detected.

    DoD: "hívás emit nélkül -> gate-FAIL (falszifikáló teszt a hiányzó-emit oldalon)"

    These tests verify the detection mechanism works. When emit is disabled,
    no event is sent -> the hook produces no observable side effect. Any test
    that asserts a side effect (event count > 0) FAILS when emit is disabled.
    """

    def _load(self):
        return _load_hook()

    def test_emit_called_when_hook_fires_with_valid_tool(self):
        """FALSIFYING: main() MUST call emit for a valid tool-call hook JSON.
        If emit is removed from main(), this test fails (RED) -- gate-FAIL."""
        mod = self._load()
        hook_json = json.dumps({
            'tool_name': 'Bash',
            'session_id': 'test-session',
        })
        import io
        emit_calls = []

        def capture_emit(event):
            emit_calls.append(event)

        with patch('sys.stdin', io.StringIO(hook_json)):
            with patch.object(mod, 'emit', side_effect=capture_emit):
                with self.assertRaises(SystemExit):
                    mod.main()

        # FALSIFYING assertion: emit MUST have been called.
        # If you remove the emit() call in main(), this fails -> gate-FAIL (intended).
        self.assertEqual(len(emit_calls), 1,
            'emit was not called -- the hook is not emitting events. '
            'This is a gate-FAIL: the P0 telemetry bus requires emit on every tool call.')

    def test_no_tool_name_produces_no_emit(self):
        """Inverse: a hook JSON with no tool_name should NOT emit (not a tool-call)."""
        mod = self._load()
        hook_json = json.dumps({'session_id': 'x'})
        import io
        with patch('sys.stdin', io.StringIO(hook_json)):
            with patch.object(mod, 'emit') as mock_emit:
                with self.assertRaises(SystemExit):
                    mod.main()
        mock_emit.assert_not_called()


if __name__ == '__main__':
    if not _HOOK_PATH.exists():
        print(f'SKIP: {_HOOK_PATH} not found')
        sys.exit(0)
    unittest.main(verbosity=2)
