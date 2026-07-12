#!/usr/bin/env python3
"""Unit tests for qa-run.py glue helpers (card d44c9c75).

Covers the pure, load-bearing pieces of the --post-ci path:
  - build_ci_payload : verdict -> /api/gate/ci payload (status mapping + int coercion)
  - parse_numstat    : `git diff --numstat base...head` -> file/insertion/deletion counts

Run: python3 scripts/test_qa_run.py
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("qa_run", os.path.join(_HERE, "qa-run.py"))
q = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(q)

SHA = "a" * 40


class BuildCiPayload(unittest.TestCase):
    def _payload(self, tsc_ok, failed, passed=100, skipped=2, **kw):
        vt = {"passed": passed, "failed": failed, "skipped": skipped}
        diff = {"diff_files": 3, "insertions": 40, "deletions": 5}
        return q.build_ci_payload(379, SHA, tsc_ok, vt, diff, **kw)

    def test_both_green_is_pass(self):
        p = self._payload(tsc_ok=True, failed=0)
        self.assertEqual(p["status"], "pass")

    def test_tsc_fail_is_fail(self):
        p = self._payload(tsc_ok=False, failed=0)
        self.assertEqual(p["status"], "fail")

    def test_vitest_fail_is_fail(self):
        p = self._payload(tsc_ok=True, failed=2)
        self.assertEqual(p["status"], "fail")

    def test_both_fail_is_fail(self):
        p = self._payload(tsc_ok=False, failed=3)
        self.assertEqual(p["status"], "fail")

    def test_tsc_ok_is_int_not_bool(self):
        # The /api/gate/ci endpoint's num() coerces only Number.isInteger values;
        # a JSON boolean would be dropped to null. tsc_ok must serialize as 1/0.
        p = self._payload(tsc_ok=True, failed=0)
        self.assertIsInstance(p["tsc_ok"], int)
        self.assertNotIsInstance(p["tsc_ok"], bool)
        self.assertEqual(p["tsc_ok"], 1)
        p0 = self._payload(tsc_ok=False, failed=0)
        self.assertEqual(p0["tsc_ok"], 0)

    def test_counts_mapped_from_vitest_and_diff(self):
        p = self._payload(tsc_ok=True, failed=0, passed=3457, skipped=6)
        self.assertEqual(p["tests_pass"], 3457)
        self.assertEqual(p["tests_fail"], 0)
        self.assertEqual(p["diff_files"], 3)
        self.assertEqual(p["insertions"], 40)
        self.assertEqual(p["deletions"], 5)

    def test_required_fields_present(self):
        p = self._payload(tsc_ok=True, failed=0)
        for k in ("pr_number", "head_sha", "status", "tsc_ok",
                  "tests_pass", "tests_fail", "diff_files",
                  "insertions", "deletions", "recorded_by"):
            self.assertIn(k, p)
        self.assertEqual(p["pr_number"], 379)
        self.assertEqual(p["head_sha"], SHA)

    def test_recorded_by_defaults_to_buster(self):
        p = self._payload(tsc_ok=True, failed=0)
        self.assertEqual(p["recorded_by"], "buster")

    def test_recorded_by_override(self):
        p = self._payload(tsc_ok=True, failed=0, recorded_by="dave")
        self.assertEqual(p["recorded_by"], "dave")

    def test_note_included_when_given(self):
        p = self._payload(tsc_ok=False, failed=1, note="tsc: 2 errors")
        self.assertEqual(p["note"], "tsc: 2 errors")


class ParseNumstat(unittest.TestCase):
    def test_basic_counts(self):
        out = "10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n0\t3\tsrc/c.ts\n"
        d = q.parse_numstat(out)
        self.assertEqual(d["diff_files"], 3)
        self.assertEqual(d["insertions"], 15)
        self.assertEqual(d["deletions"], 5)

    def test_binary_dashes_skipped_in_sums_but_counted_as_file(self):
        # Binary files render as "-\t-\t<path>"; they count as a changed file
        # but contribute no line counts.
        out = "-\t-\timg/logo.png\n4\t1\tsrc/x.ts\n"
        d = q.parse_numstat(out)
        self.assertEqual(d["diff_files"], 2)
        self.assertEqual(d["insertions"], 4)
        self.assertEqual(d["deletions"], 1)

    def test_empty_output_is_zero(self):
        d = q.parse_numstat("")
        self.assertEqual(d, {"diff_files": 0, "insertions": 0, "deletions": 0})

    def test_trailing_blank_lines_ignored(self):
        out = "3\t3\tsrc/a.ts\n\n\n"
        d = q.parse_numstat(out)
        self.assertEqual(d["diff_files"], 1)
        self.assertEqual(d["insertions"], 3)
        self.assertEqual(d["deletions"], 3)


class PostCiRouting(unittest.TestCase):
    """The I/O wrappers route to the right endpoints (no real network)."""

    def setUp(self):
        self.calls = []
        self._orig = q._api_post
        q._api_post = lambda path, body, token, base_url=q.DASHBOARD_URL: (
            self.calls.append((path, body, token, base_url)) or (201, "{}")
        )

    def tearDown(self):
        q._api_post = self._orig

    def test_post_ci_routes_to_gate_ci(self):
        payload = {"pr_number": 379, "head_sha": SHA, "status": "pass"}
        code, _ = q.post_ci(payload, "tok")
        self.assertEqual(code, 201)
        self.assertEqual(self.calls[0][0], "/api/gate/ci")
        self.assertEqual(self.calls[0][1], payload)

    def test_alert_forge_routes_to_messages_from_buster(self):
        q.alert_forge(379, SHA, "tsc FAIL; vitest 3p/2f/0s", "tok")
        path, body, _, _ = self.calls[0]
        self.assertEqual(path, "/api/messages")
        self.assertEqual(body["from"], "buster")
        self.assertEqual(body["to"], "forge")
        self.assertIn("379", body["content"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
