#!/usr/bin/env python3
"""Tests for Medic's log-scan probe -- stable signature codes, never raw text.

Run: python3 scripts/test_medic_probe_logscan.py

Fully synthetic: glob is monkeypatched to a fixed path list and the Executor is a
fake mapping path -> canned text, so no real log file is ever touched.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import probe_logscan  # noqa: E402
from medic.types import ExecResult  # noqa: E402


class FakeExecutor:
    """Executor backed by an in-memory {path: text} map. Records every read so a
    test can assert the probe only reads (never runs / writes)."""

    def __init__(self, files):
        self.files = dict(files)
        self.reads = []
        self.runs = []
        self.writes = []

    def run(self, argv, timeout=30.0):
        self.runs.append(list(argv))
        return ExecResult(0, "", "")

    def read_text(self, path):
        self.reads.append(path)
        return self.files.get(path)

    def write_text(self, path, content, mode=0o600):
        self.writes.append(path)
        return True

    def path_mtime(self, path):
        return None

    def query(self, sql, params=()):
        return []

    def now(self):
        return 1780916754.0


class LogScanProbeTests(unittest.TestCase):
    def setUp(self):
        # Snapshot + monkeypatch glob.glob inside the module so discovery is
        # deterministic and never hits the real store/ directory.
        self._orig_glob = probe_logscan.glob.glob

    def tearDown(self):
        probe_logscan.glob.glob = self._orig_glob

    def _run(self, files):
        paths = list(files.keys())
        probe_logscan.glob.glob = lambda pattern: list(paths)
        ex = FakeExecutor(files)
        return probe_logscan.collect(ex), ex

    # -- shape ------------------------------------------------------------- #
    def test_returns_log_errors_key_as_list(self):
        out, _ = self._run({})
        self.assertIn("log_errors", out)
        self.assertIsInstance(out["log_errors"], list)
        self.assertEqual(out["log_errors"], [])

    def test_no_logs_present(self):
        probe_logscan.glob.glob = lambda pattern: []
        out = probe_logscan.collect(FakeExecutor({}))
        self.assertEqual(out, {"log_errors": []})

    # -- each signature code matches its markers --------------------------- #
    def test_oauth_expired_signature(self):
        out, _ = self._run({"/s/token.log": "2026 ERROR Invalid bearer token, please re-authenticate\n"})
        self.assertEqual(out["log_errors"], ["oauth_expired"])

    def test_usage_limit_signature(self):
        out, _ = self._run({"/s/a.log": "hit usage limit -- wait for reset menu shown\n"})
        self.assertEqual(out["log_errors"], ["usage_limit"])

    def test_pipe_closed_signature(self):
        out, _ = self._run({"/s/mcp.log": "MCP transport closed: connection closed by peer\n"})
        self.assertEqual(out["log_errors"], ["pipe_closed"])

    def test_session_crash_signature(self):
        out, _ = self._run({"/s/sup.log": "Traceback (most recent call last):\n  ...\n"})
        self.assertEqual(out["log_errors"], ["session_crash"])

    def test_case_insensitive_match(self):
        out, _ = self._run({"/s/a.log": "CONNECTION CLOSED\n"})
        self.assertEqual(out["log_errors"], ["pipe_closed"])

    # -- dedup + sort + multi-file ----------------------------------------- #
    def test_codes_deduplicated_and_sorted(self):
        files = {
            "/s/1.log": "connection closed\nconnection closed again\n",
            "/s/2.log": "broken pipe\n",                       # also pipe_closed
            "/s/3.log": "OAuth token expired\n",               # oauth_expired
            "/s/4.log": "approaching usage limit\n",           # usage_limit
        }
        out, _ = self._run(files)
        self.assertEqual(out["log_errors"], ["oauth_expired", "pipe_closed", "usage_limit"])

    def test_clean_logs_yield_no_codes(self):
        out, _ = self._run({"/s/ok.log": "supervisor tick ok\nall agents alive\n"})
        self.assertEqual(out["log_errors"], [])

    # -- never leaks raw text ---------------------------------------------- #
    def test_never_returns_raw_log_text(self):
        secret = "SUPER_SECRET_abc123 connection closed token expired usage limit"
        out, _ = self._run({"/s/x.log": secret + "\n"})
        for code in out["log_errors"]:
            self.assertIn(code, {"oauth_expired", "usage_limit", "pipe_closed", "session_crash"})
            self.assertNotIn("SUPER_SECRET", code)
            self.assertNotIn("abc123", code)

    # -- read-only contract ------------------------------------------------ #
    def test_probe_is_read_only(self):
        _, ex = self._run({"/s/a.log": "connection closed\n"})
        self.assertEqual(ex.runs, [])     # never executes a process
        self.assertEqual(ex.writes, [])   # never writes
        self.assertTrue(ex.reads)         # but does read

    def test_content_read_through_executor_only(self):
        # The probe must obtain content via ex.read_text, not by opening files
        # itself -- so a fake executor fully controls what it sees.
        files = {"/s/a.log": "OAuth token expired\n", "/s/b.log": "broken pipe\n"}
        out, ex = self._run(files)
        self.assertEqual(set(ex.reads), set(files.keys()))
        self.assertEqual(out["log_errors"], ["oauth_expired", "pipe_closed"])

    # -- bounded tail ------------------------------------------------------ #
    def test_only_tail_is_scanned(self):
        # A marker buried before the last TAIL_BYTES window is NOT seen; one
        # inside the window IS. Proves the scan is bounded to the tail.
        pad = "x\n" * (probe_logscan.TAIL_BYTES)  # well over the byte budget
        early = "connection closed\n" + pad        # marker before the window
        out_early, _ = self._run({"/s/big.log": early})
        self.assertEqual(out_early["log_errors"], [])

        late = pad + "connection closed\n"         # marker inside the window
        out_late, _ = self._run({"/s/big.log": late})
        self.assertEqual(out_late["log_errors"], ["pipe_closed"])

    def test_unreadable_log_skipped(self):
        # read_text returns None (missing/unreadable) for one file; the other
        # still contributes. Must not raise.
        files = {"/s/gone.log": None, "/s/ok.log": "usage limit\n"}
        out, _ = self._run(files)
        self.assertEqual(out["log_errors"], ["usage_limit"])

    def test_at_most_max_logs_read(self):
        many = {f"/s/{i}.log": "connection closed\n" for i in range(probe_logscan.MAX_LOGS + 25)}
        _, ex = self._run(many)
        self.assertLessEqual(len(ex.reads), probe_logscan.MAX_LOGS)


class LogScanSymlinkContainmentTests(unittest.TestCase):
    """Chad PR#84 low-finding (card eac0423a): glob.glob follows symlinks, so a
    symlinked *.log under store/ could leak content from OUTSIDE store/. The probe
    must skip any symlink whose real target escapes store/, while still reading
    legitimate in-store logs."""

    def setUp(self):
        import shutil
        import tempfile
        self._orig_glob = probe_logscan.glob.glob
        self._orig_store = probe_logscan.STORE_DIR
        self.tmp = tempfile.mkdtemp()
        self.store = os.path.join(self.tmp, "store")
        os.makedirs(self.store)
        probe_logscan.STORE_DIR = self.store
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.addCleanup(setattr, probe_logscan, "STORE_DIR", self._orig_store)
        self.addCleanup(setattr, probe_logscan.glob, "glob", self._orig_glob)

    def test_symlink_escaping_store_is_skipped(self):
        # A secret file OUTSIDE store/, surfaced via a symlinked *.log inside store/.
        outside = os.path.join(self.tmp, "secret.txt")
        with open(outside, "w", encoding="utf-8") as fh:
            fh.write("connection closed\n")  # would match pipe_closed if read
        link = os.path.join(self.store, "evil.log")
        os.symlink(outside, link)
        real_log = os.path.join(self.store, "real.log")
        with open(real_log, "w", encoding="utf-8") as fh:
            fh.write("usage limit\n")

        probe_logscan.glob.glob = lambda pattern: [real_log, link]
        # FakeExecutor would happily return the symlink's text -- prove the probe
        # filters it BEFORE the read, so the leak never reaches read_text.
        ex = FakeExecutor({real_log: "usage limit\n", link: "connection closed\n"})
        out = probe_logscan.collect(ex)
        self.assertNotIn(link, ex.reads)              # escaping symlink never read
        self.assertIn(real_log, ex.reads)             # in-store log still read
        self.assertEqual(out["log_errors"], ["usage_limit"])  # no leaked pipe_closed

    def test_symlink_within_store_is_read(self):
        # A symlink that stays inside store/ is benign and must still be scanned.
        target = os.path.join(self.store, "target.log")
        with open(target, "w", encoding="utf-8") as fh:
            fh.write("usage limit\n")
        link = os.path.join(self.store, "alias.log")
        os.symlink(target, link)
        probe_logscan.glob.glob = lambda pattern: [link]
        ex = FakeExecutor({link: "usage limit\n"})
        out = probe_logscan.collect(ex)
        self.assertIn(link, ex.reads)
        self.assertEqual(out["log_errors"], ["usage_limit"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
