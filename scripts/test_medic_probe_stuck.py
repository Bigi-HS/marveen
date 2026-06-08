#!/usr/bin/env python3
"""Tests for Medic's probe_stuck -- the stuck-inter-agent-message health probe.

Run: python3 scripts/test_medic_probe_stuck.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import probe_stuck  # noqa: E402
from medic.types import ExecResult  # noqa: E402

NOW = 1780916754.0


class RecordingExecutor:
    """Fake Executor that records the SQL + params it is handed and returns a
    canned query result. Never touches the real system."""

    def __init__(self, query_result=None, raise_on_query=False, now=NOW):
        self.query_result = query_result if query_result is not None else []
        self.raise_on_query = raise_on_query
        self._now = now
        self.queries = []  # list of (sql, params)

    def run(self, argv, timeout=30.0):
        return ExecResult(0, "", "")

    def read_text(self, path):
        return None

    def write_text(self, path, content, mode=0o600):
        return True

    def path_mtime(self, path):
        return None

    def query(self, sql, params=()):
        self.queries.append((sql, tuple(params)))
        if self.raise_on_query:
            raise RuntimeError("db unavailable")
        return self.query_result

    def now(self):
        return self._now


class CollectTests(unittest.TestCase):
    def test_counts_stuck_messages(self):
        ex = RecordingExecutor(query_result=[(7,)])
        self.assertEqual(probe_stuck.collect(ex), {"stuck_messages": 7})

    def test_zero_when_empty(self):
        ex = RecordingExecutor(query_result=[(0,)])
        self.assertEqual(probe_stuck.collect(ex), {"stuck_messages": 0})

    def test_zero_on_empty_rowset(self):
        # COUNT(*) normally returns one row, but tolerate a degenerate empty set.
        ex = RecordingExecutor(query_result=[])
        self.assertEqual(probe_stuck.collect(ex), {"stuck_messages": 0})

    def test_zero_on_query_error(self):
        ex = RecordingExecutor(raise_on_query=True)
        # A broken probe must degrade gracefully, never raise.
        self.assertEqual(probe_stuck.collect(ex), {"stuck_messages": 0})


class ContractTests(unittest.TestCase):
    def test_query_is_parameterised(self):
        ex = RecordingExecutor(query_result=[(3,)])
        probe_stuck.collect(ex)
        self.assertEqual(len(ex.queries), 1)
        sql, params = ex.queries[0]
        # Exactly one bound parameter -- the grace cutoff, never inlined.
        self.assertEqual(sql.count("?"), 1)
        self.assertEqual(len(params), 1)

    def test_cutoff_uses_now_minus_grace(self):
        ex = RecordingExecutor(query_result=[(0,)])
        probe_stuck.collect(ex)
        _, params = ex.queries[0]
        self.assertAlmostEqual(params[0], NOW - probe_stuck.GRACE_SEC)

    def test_query_filters_null_delivered_and_age(self):
        ex = RecordingExecutor(query_result=[(0,)])
        probe_stuck.collect(ex)
        sql = ex.queries[0][0].lower()
        self.assertIn("agent_messages", sql)
        self.assertIn("delivered_at is null", sql)
        self.assertIn("created_at <", sql)
        self.assertIn("count(*)", sql)

    def test_no_value_string_formatted_into_sql(self):
        # The cutoff value must not appear inlined in the SQL text.
        ex = RecordingExecutor(query_result=[(0,)])
        probe_stuck.collect(ex)
        sql = ex.queries[0][0]
        self.assertNotIn(str(NOW), sql)
        self.assertNotIn(str(NOW - probe_stuck.GRACE_SEC), sql)

    def test_result_count_is_int(self):
        # A DB driver might hand back a non-int (e.g. str) -- coerce defensively.
        ex = RecordingExecutor(query_result=[("5",)])
        out = probe_stuck.collect(ex)
        self.assertEqual(out, {"stuck_messages": 5})
        self.assertIsInstance(out["stuck_messages"], int)


if __name__ == "__main__":
    unittest.main(verbosity=2)
