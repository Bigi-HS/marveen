#!/usr/bin/env python3
"""Tests for todo-freshness-check.py evaluate() -- need-aware false-alarm guard.

Card 24e1829c (OPS-343): the freshness monitor was a pure write-recency threshold
(MAX(updated_at) on todo_items). On an EMPTY calendar day the daily todo-write task
runs, finds nothing to write, and correctly skips -- yet the recency crosses the
threshold and a false FRESHNESS ALERT fires (incident 2026-11-18: claudia 37h stale
while the 07:00 task fired with verdict=submitted, just an empty day). A healthy but
quiet agent on an empty day ALSO has no outbound fleet activity for 18h+, so the
liveness layer (card cbaa66fa) does not save it either.

The fix is need-aware: a stale todo write is only an outage if the WRITE PIPELINE
failed. The pipeline is the owner's daily `todo-write-<owner>` scheduled task. If that
task fired recently (last_run within a cycle + result='fired' + active), the agent woke
and ran it; a missing write is by-design (empty valid day) and must NOT alert. Only when
the write-task itself stopped firing (stale last_run / inactive / budget-paused / absent)
does the monitor fall through to the liveness check and then to a genuine 'stale' alert.

Run: python3 -m pytest scripts/test_todo_freshness_evaluate.py
"""
import importlib.util
import os
import sqlite3
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, "todo-freshness-check.py")
_spec = importlib.util.spec_from_file_location("todo_freshness_check", _MOD_PATH)
fresh = importlib.util.module_from_spec(_spec)
_saved_noa_db = os.environ.pop("NOA_DB_PATH", None)
_spec.loader.exec_module(fresh)
if _saved_noa_db is not None:
    os.environ["NOA_DB_PATH"] = _saved_noa_db

NOW = 2_000_000_000  # fixed reference epoch (seconds)
HOUR = 3600


def _make_db():
    """In-memory DB with the minimal schema evaluate() touches."""
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE todo_items (owner TEXT, updated_at INTEGER);
        CREATE TABLE agent_messages (from_agent TEXT, created_at INTEGER);
        CREATE TABLE conversation_log (agent_id TEXT, created_at INTEGER);
        CREATE TABLE scheduled_tasks (
            id TEXT, agent TEXT, status TEXT,
            last_run INTEGER, last_result TEXT, description TEXT
        );
        """
    )
    return conn


def _set_todo(conn, owner, ago_s):
    conn.execute("INSERT INTO todo_items(owner, updated_at) VALUES (?, ?)", (owner, NOW - ago_s))


def _set_activity(conn, owner, ago_s):
    conn.execute(
        "INSERT INTO agent_messages(from_agent, created_at) VALUES (?, ?)", (owner, NOW - ago_s)
    )


def _set_write_task(conn, owner, last_run_ago_s, result="fired", status="active", tid=None, desc=None):
    conn.execute(
        "INSERT INTO scheduled_tasks(id, agent, status, last_run, last_result, description) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            tid or f"todo-write-{owner}",
            owner,
            status,
            None if last_run_ago_s is None else NOW - last_run_ago_s,
            result,
            desc or f"Daily To-Do widget write ({owner}) -- FS/DM-AC",
        ),
    )


def _verdict(conn, owner):
    for v in fresh.evaluate(conn, NOW, fresh.THRESHOLD_SECONDS):
        if v["owner"] == owner:
            return v
    raise AssertionError(f"no verdict for {owner}")


class EvaluateNeedAwareTests(unittest.TestCase):
    def setUp(self):
        self.conn = _make_db()

    def tearDown(self):
        self.conn.close()

    # --- baseline existing behaviour (must stay green) ---

    def test_fresh_write_is_ok(self):
        _set_todo(self.conn, "claudia", 1 * HOUR)
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "ok")

    def test_no_rows_when_absent(self):
        # claudia has no todo rows at all
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "no-rows")

    def test_liveness_still_suppresses_active_agent(self):
        # stale write, no write-task row, but agent sent a message recently -> ok-alive
        _set_todo(self.conn, "claudia", 40 * HOUR)
        _set_activity(self.conn, "claudia", 2 * HOUR)
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "ok-alive")

    # --- the false-alarm this card fixes (RED before the fix) ---

    def test_empty_valid_day_suppressed_by_task_fired(self):
        # stale write (40h) AND no recent fleet activity (quiet empty day),
        # but the daily write-task fired 18h ago with result='fired' -> empty valid day.
        _set_todo(self.conn, "claudia", 40 * HOUR)
        # no agent_messages -> liveness would be None (stale) under the old code
        _set_write_task(self.conn, "claudia", 18 * HOUR)
        v = _verdict(self.conn, "claudia")
        self.assertEqual(v["state"], "ok-empty-day")
        self.assertIn("task_fired_ago", v)

    # --- adversarial: genuine outage must STILL alert ---

    def test_genuine_outage_when_task_not_firing(self):
        # stale write AND no liveness AND the write-task has not fired in days -> stale
        _set_todo(self.conn, "claudia", 50 * HOUR)
        _set_write_task(self.conn, "claudia", 72 * HOUR)  # last fired 72h ago (stale)
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "stale")

    def test_budget_paused_task_does_not_suppress(self):
        # task last_run is recent but it was budget-paused (did NOT actually run) -> stale
        _set_todo(self.conn, "claudia", 40 * HOUR)
        _set_write_task(self.conn, "claudia", 2 * HOUR, result="budget-paused")
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "stale")

    def test_inactive_task_does_not_suppress(self):
        _set_todo(self.conn, "claudia", 40 * HOUR)
        _set_write_task(self.conn, "claudia", 2 * HOUR, status="paused")
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "stale")

    def test_missing_task_does_not_suppress(self):
        # no todo-write task row, no liveness -> stale (cannot prove the pipeline ran)
        _set_todo(self.conn, "claudia", 40 * HOUR)
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "stale")

    def test_never_ran_task_does_not_suppress(self):
        _set_todo(self.conn, "claudia", 40 * HOUR)
        _set_write_task(self.conn, "claudia", None)  # last_run NULL
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "stale")

    # --- robust task lookup: description fallback when id convention differs ---

    def test_task_found_via_description_fallback(self):
        _set_todo(self.conn, "claudia", 40 * HOUR)
        _set_write_task(
            self.conn, "claudia", 18 * HOUR, tid="custom-renamed-id",
            desc="Daily To-Do widget write (claudia) -- FS/DM-AC",
        )
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "ok-empty-day")

    def test_other_owner_task_does_not_suppress(self):
        # a fired write-task belonging to a DIFFERENT owner must not suppress claudia
        _set_todo(self.conn, "claudia", 40 * HOUR)
        _set_write_task(self.conn, "hibiki", 2 * HOUR)  # hibiki's task, not claudia's
        self.assertEqual(_verdict(self.conn, "claudia")["state"], "stale")


if __name__ == "__main__":
    unittest.main()
