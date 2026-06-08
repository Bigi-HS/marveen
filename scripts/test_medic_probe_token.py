#!/usr/bin/env python3
"""Tests for Medic's token probe -- numeric-only, read-only OAuth expiry/age.

Run: python3 scripts/test_medic_probe_token.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from medic import probe_token  # noqa: E402


# A fixed "now" so age math is deterministic.
NOW = 1780916754.0
SECRET = "sk-ant-oat01-THIS-MUST-NEVER-LEAK"


class FakeExecutor:
    """Minimal read-only Executor for the token probe.

    Serves a synthetic credentials.json for CRED_PATH (and only that path), and
    records every path it is asked to read/stat so a test can assert the probe
    never touches anything else. run/write/query are tripwires: the probe is
    read-only and must never call them.
    """

    def __init__(self, cred_text=None, cred_mtime=None, now=NOW):
        self.cred_text = cred_text
        self.cred_mtime = cred_mtime
        self._now = now
        self.read_paths = []
        self.mtime_paths = []
        self.ran = []
        self.wrote = []

    def run(self, argv, timeout=30.0):  # pragma: no cover - tripwire
        self.ran.append(list(argv))
        raise AssertionError("probe_token must not run a process")

    def read_text(self, path):
        self.read_paths.append(path)
        if path == probe_token.CRED_PATH:
            return self.cred_text
        return None

    def write_text(self, path, content, mode=0o600):  # pragma: no cover - tripwire
        self.wrote.append(path)
        raise AssertionError("probe_token must not write (read-only)")

    def path_mtime(self, path):
        self.mtime_paths.append(path)
        if path == probe_token.CRED_PATH:
            return self.cred_mtime
        return None

    def query(self, sql, params=()):  # pragma: no cover - tripwire
        raise AssertionError("probe_token must not query the DB")

    def now(self):
        return self._now


def creds(expires_ms):
    return json.dumps({"claudeAiOauth": {"accessToken": SECRET,
                                         "refreshToken": SECRET,
                                         "expiresAt": expires_ms}})


class HappyPathTests(unittest.TestCase):
    def test_expiry_ms_converted_to_epoch_seconds(self):
        expires_ms = 1780920000000  # ms
        ex = FakeExecutor(cred_text=creds(expires_ms), cred_mtime=NOW - 120.0)
        out = probe_token.collect(ex)
        self.assertEqual(out["token_expires_at"], expires_ms / 1000.0)

    def test_refresh_age_is_now_minus_mtime(self):
        ex = FakeExecutor(cred_text=creds(1780920000000), cred_mtime=NOW - 3600.0)
        out = probe_token.collect(ex)
        self.assertEqual(out["token_refreshed_age_sec"], 3600.0)

    def test_returns_only_the_two_owned_fields(self):
        ex = FakeExecutor(cred_text=creds(1780920000000), cred_mtime=NOW - 1.0)
        out = probe_token.collect(ex)
        self.assertEqual(set(out.keys()), {"token_expires_at", "token_refreshed_age_sec"})

    def test_float_expiry_also_accepted(self):
        ex = FakeExecutor(cred_text=creds(1780920000000.0), cred_mtime=NOW)
        out = probe_token.collect(ex)
        self.assertEqual(out["token_expires_at"], 1780920000.0)


class NeverLeaksTokenTests(unittest.TestCase):
    def test_no_field_value_is_a_string_or_contains_the_secret(self):
        ex = FakeExecutor(cred_text=creds(1780920000000), cred_mtime=NOW - 5.0)
        out = probe_token.collect(ex)
        for k, v in out.items():
            self.assertIsInstance(v, float, k)  # numeric only
            self.assertNotIn(SECRET, str(v), k)

    def test_reads_only_the_credential_path(self):
        ex = FakeExecutor(cred_text=creds(1780920000000), cred_mtime=NOW)
        probe_token.collect(ex)
        self.assertEqual(set(ex.read_paths), {probe_token.CRED_PATH})
        self.assertEqual(set(ex.mtime_paths), {probe_token.CRED_PATH})


class ReadOnlyTests(unittest.TestCase):
    def test_no_run_write_or_query(self):
        ex = FakeExecutor(cred_text=creds(1780920000000), cred_mtime=NOW)
        probe_token.collect(ex)
        self.assertEqual(ex.ran, [])
        self.assertEqual(ex.wrote, [])


class GracefulDegradationTests(unittest.TestCase):
    def test_missing_file_yields_empty(self):
        ex = FakeExecutor(cred_text=None, cred_mtime=None)
        self.assertEqual(probe_token.collect(ex), {})

    def test_malformed_json_drops_expiry_but_keeps_age(self):
        ex = FakeExecutor(cred_text="{not valid json", cred_mtime=NOW - 10.0)
        out = probe_token.collect(ex)
        self.assertNotIn("token_expires_at", out)
        self.assertEqual(out["token_refreshed_age_sec"], 10.0)

    def test_missing_expiresat_key_drops_expiry(self):
        ex = FakeExecutor(cred_text=json.dumps({"claudeAiOauth": {"accessToken": SECRET}}),
                          cred_mtime=NOW - 2.0)
        out = probe_token.collect(ex)
        self.assertNotIn("token_expires_at", out)
        self.assertEqual(out["token_refreshed_age_sec"], 2.0)

    def test_missing_oauth_block_drops_expiry(self):
        ex = FakeExecutor(cred_text=json.dumps({"other": 1}), cred_mtime=NOW)
        self.assertNotIn("token_expires_at", probe_token.collect(ex))

    def test_non_numeric_expiry_dropped(self):
        ex = FakeExecutor(cred_text=creds("soon"), cred_mtime=NOW)
        self.assertNotIn("token_expires_at", probe_token.collect(ex))

    def test_bool_expiry_rejected(self):
        # bool is an int subclass; must not slip through as a numeric expiry.
        ex = FakeExecutor(cred_text=creds(True), cred_mtime=NOW)
        self.assertNotIn("token_expires_at", probe_token.collect(ex))

    def test_no_mtime_drops_age_but_keeps_expiry(self):
        ex = FakeExecutor(cred_text=creds(1780920000000), cred_mtime=None)
        out = probe_token.collect(ex)
        self.assertEqual(out["token_expires_at"], 1780920000.0)
        self.assertNotIn("token_refreshed_age_sec", out)


class ContractShapeTests(unittest.TestCase):
    def test_result_merges_into_health_snapshot(self):
        # The fields the probe owns must be real HealthSnapshot attributes, so
        # health.collect()'s hasattr-gated merge actually applies them.
        from medic.types import HealthSnapshot
        snap = HealthSnapshot(now=NOW)
        ex = FakeExecutor(cred_text=creds(1780920000000), cred_mtime=NOW - 7.0)
        out = probe_token.collect(ex)
        for key, value in out.items():
            self.assertTrue(hasattr(snap, key), key)
            setattr(snap, key, value)
        self.assertEqual(snap.token_expires_at, 1780920000.0)
        self.assertEqual(snap.token_refreshed_age_sec, 7.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
