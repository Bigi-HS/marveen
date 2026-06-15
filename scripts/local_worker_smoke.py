#!/usr/bin/env python3
"""Buster-c12 smoke for the PATH B local-worker poller (card 6006f513, spec v2/v3).

Exercises the 5 acceptance scenarios end-to-end over real HTTP against a hermetic
mock Ollama + mock dashboard (stdlib http.server, ephemeral ports). No live
daemon, no real DB, no cloud creds -- so it is safe to run anywhere and proves
the advisory invariant deterministically.

Scenarios (store/ollama-pathb-spec.md):
  1. Ollama-down no-op  -> cycle skipped, 0 suggestions, no crash.
  2. Classify + advisory log -> jsonl gets a VALID suggested_category, and the
     poller issues ZERO writes to the dashboard (DB category provably untouched
     -- GAP2 explicit verification, not a mock-implicit assertion).
  3. think-strip -> a <think>..</think>-wrapped JSON still yields the category.
  4. Bad ollama response -> PARSE_FAIL recorded, no crash, still zero writes.
  5. Cloud-token fuse -> ANTHROPIC_API_KEY set => process aborts non-zero.

Run: python3 scripts/local_worker_smoke.py    (exit 0 iff all 5 pass)
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import local_worker as lw  # noqa: E402

LOCAL_WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_worker.py")


class _MockOllama(BaseHTTPRequestHandler):
    """/api/tags advertises qwen3:4b; /api/chat returns a scripted content string."""

    serve_model = True
    chat_content = '{"category": "cold"}'

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/tags"):
            models = [{"name": "qwen3:4b"}] if _MockOllama.serve_model else []
            self._send(200, {"models": models})
        else:
            self._send(404, {})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        if self.path.startswith("/api/chat"):
            self._send(200, {"message": {"content": _MockOllama.chat_content}})
        else:
            self._send(404, {})


class _MockDashboard(BaseHTTPRequestHandler):
    """Serves a fixed memory list on GET; records ANY non-GET as a forbidden write."""

    memories = []
    writes = []

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/memories"):
            self._send(200, _MockDashboard.memories)
        else:
            self._send(404, {})

    def _record_write(self):
        _MockDashboard.writes.append((self.command, self.path))
        self._send(200, {"ok": True})

    do_POST = _record_write
    do_PUT = _record_write
    do_PATCH = _record_write
    do_DELETE = _record_write


def _serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


class _Rng:
    def shuffle(self, seq):
        pass


def main():
    results = {}
    tmp = tempfile.mkdtemp(prefix="lw-smoke-")
    lw.SUGGESTIONS_PATH = os.path.join(tmp, "suggestions.jsonl")
    lw.LOG_PATH = os.path.join(tmp, "worker.log")

    ollama_srv, ollama_url = _serve(_MockOllama)
    dash_srv, dash_url = _serve(_MockDashboard)
    rng = _Rng()
    _MockDashboard.memories = [
        {"id": 101, "content": "deploy drift discovered, dist is stale", "category": "warm", "keywords": "deploy"}
    ]

    def reset():
        _MockDashboard.writes = []
        open(lw.SUGGESTIONS_PATH, "w").close()

    def last_record():
        with open(lw.SUGGESTIONS_PATH, encoding="utf-8") as f:
            lines = [l for l in f if l.strip()]
        return json.loads(lines[-1]) if lines else None

    try:
        # 1. Ollama-down no-op (model not served -> health-check fails fast)
        reset()
        _MockOllama.serve_model = False
        summary = lw.run_cycle(ollama_url, dash_url, "qwen3:4b", "marveen", "tok", rng,
                               health_retries=1, health_wait=0)
        results["1_ollama_down_noop"] = (
            summary["skipped"] is True and summary["suggested"] == 0
            and not _MockDashboard.writes and last_record() is None
        )

        # 2. Classify + advisory log, zero DB writes
        reset()
        _MockOllama.serve_model = True
        _MockOllama.chat_content = '{"category": "cold"}'
        summary = lw.run_cycle(ollama_url, dash_url, "qwen3:4b", "marveen", "tok", rng,
                               health_retries=1, health_wait=0)
        rec = last_record()
        results["2_classify_advisory_no_write"] = (
            summary["suggested"] == 1 and rec is not None
            and rec["suggested_category"] == "cold"
            and rec["current_category"] == "warm"
            and not _MockDashboard.writes  # GAP2: provably no PATCH/POST -> DB untouched
        )

        # 3. think-strip
        reset()
        _MockOllama.chat_content = '<think>this memory is old, archive it</think>{"category": "warm"}'
        lw.run_cycle(ollama_url, dash_url, "qwen3:4b", "marveen", "tok", rng,
                     health_retries=1, health_wait=0)
        rec = last_record()
        results["3_think_strip"] = rec is not None and rec["suggested_category"] == "warm"

        # 4. Bad ollama response -> PARSE_FAIL, no crash, no writes
        reset()
        _MockOllama.chat_content = "this is not json at all"
        summary = lw.run_cycle(ollama_url, dash_url, "qwen3:4b", "marveen", "tok", rng,
                               health_retries=1, health_wait=0)
        rec = last_record()
        results["4_parse_fail_safe"] = (
            summary["parse_fail"] == 1 and rec is not None
            and rec["suggested_category"] == "PARSE_FAIL" and not _MockDashboard.writes
        )

        # 5. Cloud-token fuse -> non-zero exit
        proc = subprocess.run(
            [sys.executable, LOCAL_WORKER, "--once", "--ollama-url", ollama_url,
             "--dashboard-url", dash_url],
            env={**os.environ, "ANTHROPIC_API_KEY": "test-should-abort"},
            capture_output=True, text=True, timeout=30,
        )
        results["5_cloud_token_fuse"] = (
            proc.returncode != 0 and "cloud credential" in (proc.stderr + proc.stdout).lower()
        )
    finally:
        ollama_srv.shutdown()
        dash_srv.shutdown()

    verdict = "pass" if all(results.values()) else "fail"
    print(json.dumps({"verdict": verdict, "scenarios": results}, indent=2))
    return 0 if verdict == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
