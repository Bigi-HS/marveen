#!/usr/bin/env python3
"""Tests for scripts/open-pr-fleet.py.

Pure: no real network, no real file I/O beyond mocking. Run:
  python3 -m pytest scripts/test_open_pr_fleet.py
"""
import importlib.util
import os
import sys
import unittest
from unittest.mock import MagicMock, mock_open, patch

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, 'open-pr-fleet.py')
_spec = importlib.util.spec_from_file_location('open_pr_fleet', _MOD_PATH)
opf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(opf)


class TestReadAgentToken(unittest.TestCase):
    def test_reads_first_line_only(self):
        """Token is the first line; expiry epoch on second line must be ignored."""
        with patch('builtins.open', mock_open(read_data='rawtoken\n1759276800\n')):
            tok = opf.read_agent_token('/fake/.genesis-token')
        self.assertEqual(tok, 'rawtoken')

    def test_strips_whitespace(self):
        with patch('builtins.open', mock_open(read_data='  mytoken  \n')):
            tok = opf.read_agent_token('/fake/.genesis-token')
        self.assertEqual(tok, 'mytoken')

    def test_raises_on_missing_file(self):
        with patch('builtins.open', side_effect=OSError('no such file')):
            with self.assertRaises(SystemExit):
                opf.read_agent_token('/fake/.genesis-token')

    def test_raises_on_empty_token(self):
        with patch('builtins.open', mock_open(read_data='\n1759276800\n')):
            with self.assertRaises(SystemExit):
                opf.read_agent_token('/fake/.genesis-token')


class TestOpenPr(unittest.TestCase):
    def _mock_resp(self, status=201, body=None):
        if body is None:
            body = json_body = b'{"number":99,"html_url":"https://github.com/Bigi-HS/marveen/pull/99","head":"feat/foo","base":"develop","recorded_author":"dave"}'
        r = MagicMock()
        r.status = status
        r.read.return_value = body
        return r

    def test_posts_to_fleet_endpoint(self):
        captured = []

        def fake_urlopen(req, timeout=None):
            captured.append(req.full_url)
            return self._mock_resp()

        with patch('urllib.request.urlopen', side_effect=fake_urlopen):
            result = opf.open_pr('tok', head='feat/foo', base='develop', title='T', body='B')

        self.assertEqual(len(captured), 1)
        self.assertIn('/api/github/pr', captured[0])

    def test_sends_head_base_title_body(self):
        import json
        captured = []

        def fake_urlopen(req, timeout=None):
            captured.append(json.loads(req.data.decode()))
            return self._mock_resp()

        with patch('urllib.request.urlopen', side_effect=fake_urlopen):
            opf.open_pr('tok', head='feat/bar', base='develop', title='My title', body='My body')

        payload = captured[0]
        self.assertEqual(payload['head'], 'feat/bar')
        self.assertEqual(payload['base'], 'develop')
        self.assertEqual(payload['title'], 'My title')
        self.assertEqual(payload['body'], 'My body')

    def test_returns_pr_info(self):
        with patch('urllib.request.urlopen', return_value=self._mock_resp()):
            result = opf.open_pr('tok', head='feat/x', base='develop', title='T', body='')

        self.assertEqual(result['number'], 99)
        self.assertIn('html_url', result)

    def test_exits_on_401(self):
        import urllib.error
        err = urllib.error.HTTPError(url='', code=401, msg='Unauthorized', hdrs={}, fp=None)
        with patch('urllib.request.urlopen', side_effect=err):
            with self.assertRaises(SystemExit):
                opf.open_pr('expired-tok', head='feat/x', base='develop', title='T', body='')

    def test_default_base_is_develop(self):
        import json
        captured = []

        def fake_urlopen(req, timeout=None):
            captured.append(json.loads(req.data.decode()))
            return self._mock_resp()

        with patch('urllib.request.urlopen', side_effect=fake_urlopen):
            opf.open_pr('tok', head='feat/y', base=None, title='T', body='')

        self.assertEqual(captured[0].get('base'), 'develop')


if __name__ == '__main__':
    unittest.main()
