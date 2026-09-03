#!/usr/bin/env python3
"""Tests for the OPS-166 immediate heal-webhook trigger in
pipe-watchdog-staleness-check.py.

Covers the pure decision function `should_fire_heal` (who/when qualifies) and
`fire_heal_webhook` (the n8n POST) with a mocked HTTP layer -- no live n8n, no
live pipe. Also an end-to-end main() run proving a first-dead marveen state
fires exactly one webhook while a forge-only dead state does not.

Run: python3 scripts/test_pipe_watchdog_heal_webhook.py
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))

# The module filename is hyphenated -> load it explicitly.
_spec = importlib.util.spec_from_file_location(
    "pipe_watchdog_staleness_check",
    os.path.join(HERE, "pipe-watchdog-staleness-check.py"),
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

NOW_S = 1_780_000_000


class ShouldFireHeal(unittest.TestCase):
    def test_marveen_first_dead_fires(self):
        self.assertTrue(mod.should_fire_heal("telegram", 1, NOW_S, {}))

    def test_marveen_sustained_dead_also_fires(self):
        self.assertTrue(mod.should_fire_heal("telegram", 3, NOW_S, {}))

    def test_healthy_does_not_fire(self):
        self.assertFalse(mod.should_fire_heal("telegram", 0, NOW_S, {}))

    def test_forge_pipe_out_of_scope(self):
        # Only the marveen main (telegram) pipe drives the heal webhook.
        self.assertFalse(mod.should_fire_heal("forge", 2, NOW_S, {}))

    def test_within_suppress_window_skips(self):
        suppress = {"heal:telegram": NOW_S - 60}  # 1 min ago, window is 6 min
        self.assertFalse(mod.should_fire_heal("telegram", 1, NOW_S, suppress))

    def test_after_suppress_window_refires(self):
        suppress = {"heal:telegram": NOW_S - (mod.HEAL_WEBHOOK_SUPPRESS_SECONDS + 1)}
        self.assertTrue(mod.should_fire_heal("telegram", 1, NOW_S, suppress))


class _FakeResp:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FireHealWebhook(unittest.TestCase):
    def test_posts_to_correct_url_and_returns_status(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["body"] = req.data
            captured["ctype"] = req.get_header("Content-type")
            return _FakeResp(200)

        orig = mod.urllib.request.urlopen
        mod.urllib.request.urlopen = fake_urlopen
        try:
            status = mod.fire_heal_webhook()
        finally:
            mod.urllib.request.urlopen = orig

        self.assertEqual(status, 200)
        self.assertEqual(captured["url"], mod.HEAL_WEBHOOK_URL)
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["ctype"], "application/json")
        payload = json.loads(captured["body"].decode())
        # Distinct detection source so n8n logs separate it from the watchdog.
        self.assertEqual(payload.get("source"), "staleness-check")


class MainEndToEnd(unittest.TestCase):
    """main() with real state files + mocked webhook/inter-agent layer."""

    def _write_state(self, store, name, consecutive_dead, now_ms):
        (store / name).write_text(json.dumps({
            "lastHealthyTs": now_ms - 30_000,
            "lastCheckedTs": now_ms - 30_000,  # fresh -> not skipped
            "consecutiveDead": consecutive_dead,
        }))

    def _run(self, states, now_ms, dry_run=False):
        fires = []
        orig_fire = mod.fire_heal_webhook
        orig_send = mod.send_inter_agent
        mod.fire_heal_webhook = lambda *a, **k: (fires.append(True) or 200)
        mod.send_inter_agent = lambda *a, **k: 200
        with tempfile.TemporaryDirectory() as d:
            store = Path(d)
            for name, cd in states.items():
                self._write_state(store, name, cd, now_ms)
            token_file = store / "token"
            token_file.write_text("dummy-token")
            argv = ["--store", str(store), "--state", str(store / "supp.json"),
                    "--token-file", str(token_file), "--now-ms", str(now_ms)]
            if dry_run:
                argv.append("--dry-run")
            try:
                rc = mod.main(argv)
            finally:
                mod.fire_heal_webhook = orig_fire
                mod.send_inter_agent = orig_send
        return rc, len(fires)

    def test_marveen_first_dead_fires_one_webhook(self):
        now_ms = NOW_S * 1000
        rc, n = self._run({"telegram-pipe-watchdog.state.json": 1}, now_ms)
        self.assertEqual(rc, 0)
        self.assertEqual(n, 1)

    def test_forge_only_dead_does_not_fire(self):
        now_ms = NOW_S * 1000
        rc, n = self._run({"pipe-watchdog.forge.state.json": 2}, now_ms)
        self.assertEqual(n, 0)

    def test_all_healthy_no_fire(self):
        now_ms = NOW_S * 1000
        rc, n = self._run({"telegram-pipe-watchdog.state.json": 0}, now_ms)
        self.assertEqual(rc, 0)
        self.assertEqual(n, 0)

    def test_dry_run_does_not_fire(self):
        now_ms = NOW_S * 1000
        rc, n = self._run({"telegram-pipe-watchdog.state.json": 1}, now_ms, dry_run=True)
        self.assertEqual(n, 0)


if __name__ == "__main__":
    unittest.main()
