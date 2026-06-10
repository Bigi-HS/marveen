#!/usr/bin/env python3
"""Acceptance tests for the --cross-model flag in scripts/pre-gate-bundle.sh.

Tests the local Ollama critic integration (card 074725fa). Uses a mock HTTP
server to simulate the Ollama /v1/chat/completions + /api/tags endpoints so no
real model is required. The mock server runs on a random port in a background
thread; tests set CROSS_MODEL_BASE=http://localhost:<port> to route there.

Policy reference: store/cross-model-verdict-policy.md
Schema: scripts/cross-model-audit-schema.json

Run: python3 scripts/__tests__/cross-model-bundle.test.py
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

BUNDLE_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "pre-gate-bundle.sh"
)

# ---------------------------------------------------------------------------
# Mock Ollama server
# ---------------------------------------------------------------------------

class _MockOllamaHandler(BaseHTTPRequestHandler):
    """Minimal Ollama-compatible mock: serves /api/tags health check and
    /v1/chat/completions with a pre-programmed response from the class-level
    RESPONSE attribute (set per test class before each test)."""

    RESPONSE: dict = {}  # set by each test case
    CAPTURED_REQUEST: dict = {}  # the last request body received

    def log_message(self, *_):  # suppress request logs in test output
        pass

    def do_GET(self):
        if self.path == "/api/tags":
            body = json.dumps({"models": [{"name": "deepseek-r1:7b"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/v1/chat/completions":
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                _MockOllamaHandler.CAPTURED_REQUEST = json.loads(raw)
            except Exception:
                pass
            # Wrap the response in the OpenAI completions format
            response = {
                "choices": [{
                    "message": {
                        "content": json.dumps(_MockOllamaHandler.RESPONSE)
                    }
                }]
            }
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


class _ErrorHandler(_MockOllamaHandler):
    """Returns 500 on completion calls to test fail-open behaviour."""
    def do_POST(self):
        self.send_response(500)
        self.end_headers()


def _start_mock_server(handler_class=_MockOllamaHandler):
    server = HTTPServer(("127.0.0.1", 0), handler_class)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, port


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_git_stub(d: str, additions: int = 5, title: str = "test: add feature") -> None:
    content = (
        f'if [[ "$*" == *"--numstat"* ]]; then\n'
        f'  echo "{additions}\\t0\\tsrc/fake.ts"\n'
        f'elif [[ "$*" == *"--format=%s"* ]]; then\n'
        f'  echo "{title}"\n'
        f'elif [[ "$*" == *"--format=%b"* ]]; then\n'
        f'  echo ""\n'
        f'elif [[ "$*" == *"diff"* ]]; then\n'
        f'  echo "+const x = 1;"\n'
        f'else\n'
        f'  exec /usr/bin/git "$@"\n'
        f'fi\n'
    )
    stub = os.path.join(d, "git")
    with open(stub, "w") as f:
        f.write("#!/bin/bash\n" + content)
    os.chmod(stub, os.stat(stub).st_mode | stat.S_IXUSR | stat.S_IXGRP)


def _make_npx_stub(d: str) -> None:
    content = (
        'case "$1" in\n'
        '  tsc) exit 0 ;;\n'
        '  vitest) echo "Tests 10 passed"; exit 0 ;;\n'
        '  *) exec /usr/bin/npx "$@" ;;\n'
        'esac\n'
    )
    stub = os.path.join(d, "npx")
    with open(stub, "w") as f:
        f.write("#!/bin/bash\n" + content)
    os.chmod(stub, os.stat(stub).st_mode | stat.S_IXUSR | stat.S_IXGRP)


def _run_bundle(stub_dir: str, port: int, extra_args: list = None,
                env_extra: dict = None) -> subprocess.CompletedProcess:
    env = dict(
        os.environ,
        PATH=stub_dir + ":" + os.environ.get("PATH", ""),
        CROSS_MODEL_BASE=f"http://127.0.0.1:{port}",
        CROSS_MODEL_MODEL="deepseek-r1:7b",
    )
    if env_extra:
        env.update(env_extra)
    args = ["bash", BUNDLE_SCRIPT, "develop", "HEAD", "--cross-model"]
    if extra_args:
        args += extra_args
    return subprocess.run(args, capture_output=True, text=True, cwd=stub_dir, env=env)


# Canned audit responses
_AGREEMENT = {
    "model": "deepseek-r1:7b",
    "findings": [],
    "overall": "pass",
    "overall_rationale": "No issues found.",
}
_PARTIAL = {
    "model": "deepseek-r1:7b",
    "findings": [
        {"id": "minor-style", "severity": "low", "location": "src/fake.ts:1",
         "summary": "Minor style concern.", "detail": "Low-severity cosmetic issue."}
    ],
    "overall": "pass",
    "overall_rationale": "Only low-severity findings.",
}
_CONTRADICTORY = {
    "model": "deepseek-r1:7b",
    "findings": [
        {"id": "sql-injection", "severity": "high", "location": "src/db.ts:42",
         "summary": "Potential SQL injection in user query.",
         "detail": "Unsanitised user input flows into a raw query string.",
         "suggested_fix": "Use parameterised queries."}
    ],
    "overall": "flag",
    "overall_rationale": "High-severity security finding requires investigation.",
}


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class AgreementTests(unittest.TestCase):
    """AC#7: AGREEMENT path -> 'cross-model: pass' line, no FLAG, exit 0."""

    def test_agreement_text_output(self):
        server, port = _start_mock_server()
        _MockOllamaHandler.RESPONSE = _AGREEMENT
        try:
            with tempfile.TemporaryDirectory() as d:
                _make_git_stub(d)
                _make_npx_stub(d)
                r = _run_bundle(d, port)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("AGREEMENT", r.stdout)
            self.assertNotIn("[FLAG]", r.stdout)
        finally:
            server.shutdown()

    def test_agreement_json_output(self):
        server, port = _start_mock_server()
        _MockOllamaHandler.RESPONSE = _AGREEMENT
        try:
            with tempfile.TemporaryDirectory() as d:
                _make_git_stub(d)
                _make_npx_stub(d)
                r = _run_bundle(d, port, extra_args=["--json"])
            self.assertEqual(r.returncode, 0)
            data = json.loads(r.stdout)
            self.assertIn("cross_model", data)
            self.assertEqual(data["cross_model"]["status"], "agreement")
            self.assertEqual(data["cross_model"]["flags"], [])
        finally:
            server.shutdown()


class PartialTests(unittest.TestCase):
    """AC#6: PARTIAL path -> low findings appended, no FLAG, exit 0."""

    def test_partial_no_flag(self):
        server, port = _start_mock_server()
        _MockOllamaHandler.RESPONSE = _PARTIAL
        try:
            with tempfile.TemporaryDirectory() as d:
                _make_git_stub(d)
                _make_npx_stub(d)
                r = _run_bundle(d, port)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("PARTIAL", r.stdout)
            self.assertNotIn("[FLAG]", r.stdout)
        finally:
            server.shutdown()

    def test_partial_json_status(self):
        server, port = _start_mock_server()
        _MockOllamaHandler.RESPONSE = _PARTIAL
        try:
            with tempfile.TemporaryDirectory() as d:
                _make_git_stub(d)
                _make_npx_stub(d)
                r = _run_bundle(d, port, extra_args=["--json"])
            data = json.loads(r.stdout)
            self.assertEqual(data["cross_model"]["status"], "partial")
        finally:
            server.shutdown()


class ContradictoryTests(unittest.TestCase):
    """AC#5: CONTRADICTORY path -> [FLAG] line in output, exit still 0 (advisory only)."""

    def test_flag_line_emitted(self):
        server, port = _start_mock_server()
        _MockOllamaHandler.RESPONSE = _CONTRADICTORY
        try:
            with tempfile.TemporaryDirectory() as d:
                _make_git_stub(d)
                _make_npx_stub(d)
                r = _run_bundle(d, port)
            self.assertEqual(r.returncode, 0, "[FLAG] must NOT change exit code -- advisory only")
            self.assertIn("[FLAG]", r.stdout)
            self.assertIn("sql-injection", r.stdout)
        finally:
            server.shutdown()

    def test_flag_json_status_contradictory(self):
        server, port = _start_mock_server()
        _MockOllamaHandler.RESPONSE = _CONTRADICTORY
        try:
            with tempfile.TemporaryDirectory() as d:
                _make_git_stub(d)
                _make_npx_stub(d)
                r = _run_bundle(d, port, extra_args=["--json"])
            data = json.loads(r.stdout)
            self.assertEqual(data["cross_model"]["status"], "contradictory")
            self.assertTrue(len(data["cross_model"]["flags"]) >= 1)
        finally:
            server.shutdown()

    def test_block_verdict_still_blocks_independently(self):
        """A tsc BLOCK + cross-model FLAG: exit code is 1 (tsc wins), FLAG still present."""
        server, port = _start_mock_server()
        _MockOllamaHandler.RESPONSE = _CONTRADICTORY
        try:
            with tempfile.TemporaryDirectory() as d:
                # Make tsc fail
                content = (
                    'case "$1" in\n'
                    '  tsc) echo "error TS2322: type mismatch" >&2; exit 1 ;;\n'
                    '  vitest) echo "Tests 1 passed"; exit 0 ;;\n'
                    '  *) exec /usr/bin/npx "$@" ;;\n'
                    'esac\n'
                )
                stub = os.path.join(d, "npx")
                with open(stub, "w") as f:
                    f.write("#!/bin/bash\n" + content)
                os.chmod(stub, os.stat(stub).st_mode | stat.S_IXUSR | stat.S_IXGRP)
                _make_git_stub(d)
                r = _run_bundle(d, port)
            self.assertEqual(r.returncode, 1, "tsc BLOCK must still produce exit 1")
            self.assertIn("[FLAG]", r.stdout)
        finally:
            server.shutdown()


class FailOpenTests(unittest.TestCase):
    """AC#8: API error -> fail-open WARN, no FLAG, exit 0 (gate unaffected)."""

    def test_api_error_fail_open(self):
        server, port = _start_mock_server(handler_class=_ErrorHandler)
        try:
            with tempfile.TemporaryDirectory() as d:
                _make_git_stub(d)
                _make_npx_stub(d)
                r = _run_bundle(d, port)
            self.assertEqual(r.returncode, 0, "API error must fail-open (exit 0)")
            self.assertIn("[WARN]", r.stdout)
            self.assertNotIn("[FLAG]", r.stdout)
        finally:
            server.shutdown()

    def test_ollama_unreachable_fail_open(self):
        """If no server at the port, the bundle emits a WARN and continues."""
        with tempfile.TemporaryDirectory() as d:
            _make_git_stub(d)
            _make_npx_stub(d)
            # Use a port that nothing is listening on
            r = _run_bundle(d, 19999)
        self.assertEqual(r.returncode, 0)
        self.assertIn("[WARN]", r.stdout)
        self.assertNotIn("[FLAG]", r.stdout)


class PromptContentTests(unittest.TestCase):
    """AC#10: prompt must not contain fleet-internal config keywords."""

    def test_prompt_does_not_contain_fleet_internals(self):
        """The assembled prompt sent to the model must not include internal config
        strings. Verified by inspecting the captured request on the mock server."""
        server, port = _start_mock_server()
        _MockOllamaHandler.RESPONSE = _AGREEMENT
        _MockOllamaHandler.CAPTURED_REQUEST = {}
        try:
            with tempfile.TemporaryDirectory() as d:
                _make_git_stub(d)
                _make_npx_stub(d)
                _run_bundle(d, port)
            captured = _MockOllamaHandler.CAPTURED_REQUEST
            if not captured:
                self.skipTest("mock server did not capture a request")
            prompt = captured.get("messages", [{}])[0].get("content", "")
            forbidden = ["DASHBOARD_TOKEN", "allowFrom", "vault", "agent_id"]
            for kw in forbidden:
                self.assertNotIn(kw, prompt,
                    f"prompt must not contain internal config keyword: {kw}")
        finally:
            server.shutdown()

    def test_no_cross_model_flag_without_flag(self):
        """Without --cross-model, cross_model key is absent from JSON output."""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)

            # minimal git stub
            git_stub = (
                'if [[ "$*" == *"--numstat"* ]]; then echo "5\t0\tsrc/a.ts"; fi\n'
            )
            stub = os.path.join(d, "git")
            with open(stub, "w") as f:
                f.write("#!/bin/bash\n" + git_stub)
            os.chmod(stub, os.stat(stub).st_mode | stat.S_IXUSR | stat.S_IXGRP)

            env = dict(os.environ, PATH=d + ":" + os.environ.get("PATH", ""))
            r = subprocess.run(
                ["bash", BUNDLE_SCRIPT, "develop", "HEAD", "--json"],
                capture_output=True, text=True, cwd=d, env=env,
            )
        self.assertEqual(r.returncode, 0)
        data = json.loads(r.stdout)
        self.assertNotIn("cross_model", data,
            "cross_model key must be absent when --cross-model flag not passed")


class ThinkTagStripTests(unittest.TestCase):
    """Deepseek-r1 wraps its reasoning in <think>...</think>; strip before parsing."""

    def test_think_tags_stripped(self):
        server, port = _start_mock_server()
        # Wrap the JSON in a thinking chain
        raw_with_think = (
            "<think>Let me analyse the diff carefully.</think>\n"
            + json.dumps(_AGREEMENT)
        )

        class ThinkHandler(_MockOllamaHandler):
            def do_POST(self):
                response = {"choices": [{"message": {"content": raw_with_think}}]}
                body = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server.shutdown()
        server2, port2 = _start_mock_server(handler_class=ThinkHandler)
        try:
            with tempfile.TemporaryDirectory() as d:
                _make_git_stub(d)
                _make_npx_stub(d)
                r = _run_bundle(d, port2)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("AGREEMENT", r.stdout)
        finally:
            server2.shutdown()


if __name__ == "__main__":
    if not os.path.exists(BUNDLE_SCRIPT):
        print(f"SKIP: {BUNDLE_SCRIPT} not found")
        sys.exit(0)
    unittest.main(verbosity=2)
