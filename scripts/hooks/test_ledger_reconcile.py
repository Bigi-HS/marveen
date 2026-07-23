#!/usr/bin/env python3
"""Unit tests for the durable ledger inbound reconcile (card 75fe1e5d).

The live UserPromptSubmit hook (ledger-capture.py) does NOT fire for a message
injected mid-turn into a BUSY channels session, so ~43% of inbound is silently
lost during busy windows. ledger-reconcile.py heals the gap idempotently by
reading the authoritative session transcripts and INSERT-OR-IGNOREing the missing
inbound rows -- with created_at taken from the REAL transcript ts (via
calendar.timegm, UTC, NOT time.mktime which introduces a 1h DST error).

Plain unittest (no pytest); run directly:  python3 test_ledger_reconcile.py
Isolated with LEDGER_DB_PATH (tempfile DB) + a tempdir of fixture .jsonl files.
"""
import calendar
import json
import os
import sys
import tempfile
import time
import unittest

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.dirname(HOOKS_DIR)
sys.path.insert(0, HOOKS_DIR)
sys.path.insert(0, SCRIPTS_DIR)

import ledger_lib  # noqa: E402

# scripts/ledger-reconcile.py -> import as a module despite the hyphen.
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "ledger_reconcile", os.path.join(SCRIPTS_DIR, "ledger-reconcile.py")
)
reconcile_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reconcile_mod)


def _channel_tag(chat_id, message_id, ts, text):
    attrs = ""
    if chat_id is not None:
        attrs += f' chat_id="{chat_id}"'
    if message_id is not None:
        attrs += f' message_id="{message_id}"'
    if ts is not None:
        attrs += f' ts="{ts}"'
    return (
        f'<channel source="plugin:telegram:telegram"{attrs}>'
        f"{text}</channel>"
    )


def _jsonl_line(tag):
    """A realistic transcript line: the channel tag buried inside a nested
    message.content structure, JSON-escaped exactly like a real *.jsonl row."""
    obj = {
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": tag}]},
    }
    return json.dumps(obj) + "\n"


class ReconcileTestBase(unittest.TestCase):
    AGENT = "marveen"

    def setUp(self):
        self._saved_ledger = os.environ.get("LEDGER_DB_PATH")
        self._dbfile = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self._dbfile.close()
        os.environ["LEDGER_DB_PATH"] = self._dbfile.name
        self._sessdir = tempfile.mkdtemp()

    def tearDown(self):
        if self._saved_ledger is None:
            os.environ.pop("LEDGER_DB_PATH", None)
        else:
            os.environ["LEDGER_DB_PATH"] = self._saved_ledger
        try:
            os.unlink(self._dbfile.name)
        except OSError:
            pass

    def write_transcript(self, name, tags):
        path = os.path.join(self._sessdir, name)
        with open(path, "w") as f:
            for tag in tags:
                f.write(_jsonl_line(tag))
        return path

    def rows(self):
        con = ledger_lib.connect()
        try:
            return con.execute(
                "SELECT chat_id, message_id, text, ts, created_at, direction"
                " FROM conversation_log ORDER BY id"
            ).fetchall()
        finally:
            con.close()

    def reconcile(self, **kw):
        kw.setdefault("agent_id", self.AGENT)
        kw.setdefault("sess_dir", self._sessdir)
        return reconcile_mod.reconcile(**kw)


class RealTsCreatedAtTest(ReconcileTestBase):
    def test_created_at_is_real_ts_not_run_time(self):
        ts = "2026-07-19T12:00:39.000Z"
        self.write_transcript("s1.jsonl", [_channel_tag("111", "5001", ts, "hello")])
        before = int(time.time())
        summary = self.reconcile()
        self.assertEqual(summary["inserted"], 1)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        chat_id, message_id, text, row_ts, created_at, direction = rows[0]
        expected = calendar.timegm(time.strptime("2026-07-19T12:00:39", "%Y-%m-%dT%H:%M:%S"))
        self.assertEqual(created_at, expected)
        # And decisively NOT the reconcile-run time.
        self.assertLess(created_at, before)
        self.assertEqual(direction, "in")
        self.assertEqual(message_id, "5001")
        self.assertEqual(chat_id, "111")
        self.assertEqual(text, "hello")


class DstGuardTest(ReconcileTestBase):
    def test_dst_boundary_uses_timegm_not_mktime(self):
        # Europe/Budapest sprang forward 2026-03-29 (CET->CEST). A ts on that date
        # is where naive time.mktime(strptime) drifts by an hour vs UTC timegm.
        ts = "2026-03-29T02:30:00.000Z"
        self.write_transcript("dst.jsonl", [_channel_tag("222", "6001", ts, "spring")])
        self.reconcile()
        (_, _, _, _, created_at, _) = self.rows()[0]
        st = time.strptime("2026-03-29T02:30:00", "%Y-%m-%dT%H:%M:%S")
        expected = calendar.timegm(st)
        self.assertEqual(created_at, expected)
        # Prove the mktime bug is avoided: mktime interprets struct_time as LOCAL,
        # so on a machine with a non-UTC/DST tz it differs from the UTC value.
        mktime_val = int(time.mktime(st))
        if mktime_val != expected:
            self.assertNotEqual(created_at, mktime_val)


class IdempotencyTest(ReconcileTestBase):
    def test_second_run_inserts_zero(self):
        ts = "2026-07-19T12:00:39.000Z"
        self.write_transcript(
            "s.jsonl",
            [
                _channel_tag("111", "7001", ts, "a"),
                _channel_tag("111", "7002", ts, "b"),
            ],
        )
        first = self.reconcile()
        self.assertEqual(first["inserted"], 2)
        second = self.reconcile()
        self.assertEqual(second["inserted"], 0)
        self.assertEqual(second["already"], 2)
        self.assertEqual(len(self.rows()), 2)


class HookDedupTest(ReconcileTestBase):
    def test_preinserted_hook_row_not_duplicated(self):
        ts = "2026-07-19T12:00:39.000Z"
        # Simulate the live hook already having captured this message.
        ledger_lib.log_inbound(self.AGENT, "111", "8001", "already here", ts)
        self.write_transcript("s.jsonl", [_channel_tag("111", "8001", ts, "already here")])
        summary = self.reconcile()
        self.assertEqual(summary["inserted"], 0)
        self.assertEqual(len(self.rows()), 1)


class TsParsingTest(ReconcileTestBase):
    def test_fractional_and_plain_z_both_parse(self):
        self.write_transcript(
            "s.jsonl",
            [
                _channel_tag("111", "9001", "2026-07-19T12:00:39.000Z", "frac"),
                _channel_tag("111", "9002", "2026-07-19T12:00:40Z", "plain"),
            ],
        )
        self.reconcile()
        by_mid = {r[1]: r[4] for r in self.rows()}
        self.assertEqual(
            by_mid["9001"],
            calendar.timegm(time.strptime("2026-07-19T12:00:39", "%Y-%m-%dT%H:%M:%S")),
        )
        self.assertEqual(
            by_mid["9002"],
            calendar.timegm(time.strptime("2026-07-19T12:00:40", "%Y-%m-%dT%H:%M:%S")),
        )


class MultipleChatIdsTest(ReconcileTestBase):
    def test_two_chat_ids_keyed_independently(self):
        ts = "2026-07-19T12:00:39.000Z"
        self.write_transcript(
            "s.jsonl",
            [
                _channel_tag("111", "100", ts, "from-a"),
                _channel_tag("222", "100", ts, "from-b"),  # same message_id, other chat
            ],
        )
        summary = self.reconcile()
        self.assertEqual(summary["inserted"], 2)
        keys = {(r[0], r[1]) for r in self.rows()}
        self.assertEqual(keys, {("111", "100"), ("222", "100")})


class LogInboundBackCompatTest(ReconcileTestBase):
    def test_five_arg_uses_now(self):
        before = int(time.time())
        ledger_lib.log_inbound(self.AGENT, "111", "200", "x", "2020-01-01T00:00:00Z")
        after = int(time.time())
        (_, _, _, _, created_at, _) = self.rows()[0]
        self.assertGreaterEqual(created_at, before)
        self.assertLessEqual(created_at, after)

    def test_six_arg_uses_passed_created_at(self):
        ledger_lib.log_inbound(self.AGENT, "111", "201", "x", "2020-01-01T00:00:00Z", 1577836800)
        (_, _, _, _, created_at, _) = self.rows()[0]
        self.assertEqual(created_at, 1577836800)


class NoMessageIdSkipTest(ReconcileTestBase):
    def test_tag_without_message_id_is_skipped(self):
        ts = "2026-07-19T12:00:39.000Z"
        self.write_transcript(
            "s.jsonl",
            [
                _channel_tag("111", None, ts, "no-mid"),
                _channel_tag("111", "300", ts, "has-mid"),
            ],
        )
        summary = self.reconcile()
        self.assertEqual(summary["inserted"], 1)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], "300")

    def test_tag_without_chat_id_is_skipped(self):
        ts = "2026-07-19T12:00:39.000Z"
        self.write_transcript(
            "s.jsonl",
            [
                _channel_tag(None, "400", ts, "no-chat"),
                _channel_tag("111", "401", ts, "has-chat"),
            ],
        )
        summary = self.reconcile()
        self.assertEqual(summary["inserted"], 1)
        self.assertEqual(self.rows()[0][1], "401")


class DryRunTest(ReconcileTestBase):
    def test_dry_run_reports_but_does_not_insert(self):
        ts = "2026-07-19T12:00:39.000Z"
        self.write_transcript("s.jsonl", [_channel_tag("111", "500", ts, "x")])
        summary = self.reconcile(write=False)
        self.assertEqual(summary["found"], 1)
        self.assertEqual(summary["inserted"], 0)
        self.assertEqual(len(self.rows()), 0)


class WindowFilterTest(ReconcileTestBase):
    def test_old_transcript_outside_window_is_skipped(self):
        ts = "2026-07-19T12:00:39.000Z"
        path = self.write_transcript("old.jsonl", [_channel_tag("111", "600", ts, "old")])
        old_mtime = time.time() - 48 * 3600
        os.utime(path, (old_mtime, old_mtime))
        summary = self.reconcile(window_hours=24)
        self.assertEqual(summary["found"], 0)
        self.assertEqual(len(self.rows()), 0)


class NeverTouchesOutboundTest(ReconcileTestBase):
    def test_outbound_rows_untouched(self):
        ledger_lib.log_outbound(self.AGENT, "111", "a reply")
        ts = "2026-07-19T12:00:39.000Z"
        self.write_transcript("s.jsonl", [_channel_tag("111", "700", ts, "q")])
        self.reconcile()
        dirs = [r[5] for r in self.rows()]
        self.assertEqual(dirs.count("out"), 1)
        self.assertEqual(dirs.count("in"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
