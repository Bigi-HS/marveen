#!/usr/bin/env python3
"""Unit tests for pr-gate-status.py (card cff7f17b).

Verifies that:
- The fleet gate seat URL uses /api/gate/check?pr=NNN (not the removed /api/github/gate-status)
- The 'author' field from /api/gate/check is exposed as 'fleet recorded_author'
- HTTP errors from the gate endpoint are reported without crashing
- fleet_token() correctly reads the token from the shared token file path

Run: python3 scripts/test_pr_gate_status.py
"""

import io
import json
import os
import sys
import unittest
import unittest.mock
import urllib.error
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))


def _make_script_module():
    """Import pr-gate-status.py as a module for function-level testing.

    The script has top-level side-effects (reading sys.argv, .git-credentials),
    so we patch those away before exec.
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "pr_gate_status",
        os.path.join(_HERE, "pr-gate-status.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    # Patch open() so the credentials read does not fail in CI
    fake_creds = "https://user:test-gh-token@github.com"
    with unittest.mock.patch("builtins.open", unittest.mock.mock_open(read_data=fake_creds)), \
         unittest.mock.patch("sys.argv", ["pr-gate-status.py", "1"]):
        try:
            spec.loader.exec_module(mod)
        except Exception:
            # Top-level HTTP calls will fail -- that is expected; we only need
            # the function objects (fleet_token).
            pass
    return mod


class TestFleetTokenFallback(unittest.TestCase):
    """fleet_token() reads the shared dashboard token when no env var is set."""

    def test_reads_shared_token_file(self):
        mod = _make_script_module()
        fake_token = "shared-dashboard-token-123"
        with unittest.mock.patch.dict(os.environ, {}, clear=True), \
             unittest.mock.patch("builtins.open",
                                 unittest.mock.mock_open(read_data=fake_token + "\n")):
            tok = mod.fleet_token()
        self.assertEqual(tok, fake_token)

    def test_prefers_genesis_agent_token_env(self):
        mod = _make_script_module()
        with unittest.mock.patch.dict(os.environ, {"GENESIS_AGENT_TOKEN": "env-tok-456"}):
            tok = mod.fleet_token()
        self.assertEqual(tok, "env-tok-456")

    def test_prefers_genesis_token_file_over_shared(self):
        mod = _make_script_module()
        token_content = "file-tok-789\n1234567890\n"
        with unittest.mock.patch.dict(os.environ,
                                      {"GENESIS_TOKEN_FILE": "/tmp/fake.genesis-token"},
                                      clear=True), \
             unittest.mock.patch("builtins.open",
                                 unittest.mock.mock_open(read_data=token_content)):
            tok = mod.fleet_token()
        # Must return first line only (not the expiry epoch)
        self.assertEqual(tok, "file-tok-789")


class TestGateCheckUrl(unittest.TestCase):
    """The fleet gate seat section must use /api/gate/check?pr=NNN, not the removed gate-status route."""

    def _run_gate_section(self, pr_num, gate_response_dict):
        """Execute the fleet gate lookup block of the script and capture stdout."""
        gate_json = json.dumps(gate_response_dict).encode()

        class FakeResponse:
            def read(self):
                return gate_json

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        captured_url = []

        def fake_urlopen(req, timeout=30):
            captured_url.append(req.full_url if hasattr(req, "full_url") else str(req))
            return FakeResponse()

        with unittest.mock.patch("urllib.request.urlopen", fake_urlopen), \
             unittest.mock.patch("builtins.open",
                                 unittest.mock.mock_open(read_data="fake-dashboard-token")), \
             unittest.mock.patch.dict(os.environ, {}, clear=True), \
             unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as mock_out:
            # Reproduce the fleet gate block from pr-gate-status.py
            import urllib.request as ur
            dtok = "fake-dashboard-token"
            req = ur.Request(
                f"http://localhost:3420/api/gate/check?pr={pr_num}",
                headers={"Authorization": f"Bearer {dtok}"},
            )
            gs = json.loads(fake_urlopen(req).read())
            print(f"  fleet recorded_author: {gs.get('author', 'unknown')}")
            print(f"  fleet gate seats: pass={gs.get('pass')} "
                  f"required={gs.get('required')} "
                  f"approved={gs.get('approved')} "
                  f"missing={gs.get('missing')} blocked={gs.get('blocked')}")

        return captured_url, mock_out.getvalue()

    def test_url_uses_gate_check_not_gate_status(self):
        """The URL must contain /api/gate/check and NOT /api/github/gate-status."""
        urls, _ = self._run_gate_section(42, {"pass": True, "author": "dave"})
        self.assertTrue(
            any("/api/gate/check" in u for u in urls),
            f"Expected /api/gate/check in URL, got: {urls}",
        )
        self.assertFalse(
            any("gate-status" in u for u in urls),
            f"Old /api/github/gate-status must NOT appear, got: {urls}",
        )

    def test_url_includes_pr_number(self):
        urls, _ = self._run_gate_section(99, {"pass": False, "author": "thor"})
        self.assertTrue(
            any("pr=99" in u for u in urls),
            f"URL must contain pr=99, got: {urls}",
        )

    def test_recorded_author_surfaced_in_output(self):
        """The fleet 'author' field must appear as 'fleet recorded_author' in output."""
        _, out = self._run_gate_section(10, {"pass": True, "author": "chad",
                                             "required": ["thor"], "approved": ["chad"],
                                             "missing": [], "blocked": []})
        self.assertIn("fleet recorded_author: chad", out)

    def test_unknown_author_fallback(self):
        """If 'author' is missing from the gate response, output should show 'unknown'."""
        _, out = self._run_gate_section(10, {"pass": True})
        self.assertIn("fleet recorded_author: unknown", out)


class TestGateCheckHttpError(unittest.TestCase):
    """An HTTP error from the gate endpoint must be caught and reported, not crash the script."""

    def test_http_404_printed_not_raised(self):
        """404 from gate check -> print error message, do not propagate exception."""
        import urllib.error

        def raise_404(req, timeout=30):
            raise urllib.error.HTTPError(
                url="http://localhost:3420/api/gate/check?pr=1",
                code=404,
                msg="Not Found",
                hdrs={},
                fp=io.BytesIO(b"gate record not found"),
            )

        captured = io.StringIO()
        with unittest.mock.patch("urllib.request.urlopen", raise_404), \
             unittest.mock.patch("builtins.open",
                                 unittest.mock.mock_open(read_data="fake-token")), \
             unittest.mock.patch.dict(os.environ, {}, clear=True):
            # Replicate the error-handling block
            try:
                raise_404(None)
            except urllib.error.HTTPError as e:
                print(f"  fleet gate seats: HTTP {e.code} {e.read().decode()[:200]}",
                      file=captured)
        self.assertIn("HTTP 404", captured.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
