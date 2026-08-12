#!/usr/bin/env python3
"""Tests for the SessionStart / UserPromptSubmit enforcement bundle
(session_enforce_lib.py + session-start-enforce.py + prompt-freshness-nudge.py;
cards 03a4f57d + 705381e3).

Run: python3 scripts/hooks/test_session_enforce.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_INSTALL = os.path.dirname(os.path.dirname(_HERE))
_START_HOOK = os.path.join(_HERE, "session-start-enforce.py")
_NUDGE_HOOK = os.path.join(_HERE, "prompt-freshness-nudge.py")

_spec = importlib.util.spec_from_file_location(
    "session_enforce_lib", os.path.join(_HERE, "session_enforce_lib.py")
)
lib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lib)

CFG = lib.DEFAULT_NUDGE_CONFIG


# --- SessionStart per-agent checks (03a4f57d) --------------------------------

class SessionStartReminderTests(unittest.TestCase):
    def test_hibiki_gets_inbox_check(self):
        r = lib.sessionstart_reminder("hibiki")
        self.assertIsNotNone(r)
        self.assertIn("INBOX-CHECK", r)

    def test_claudia_gets_email_ask_first(self):
        r = lib.sessionstart_reminder("claudia")
        self.assertIsNotNone(r)
        self.assertIn("ASK-FIRST", r)

    def test_unlisted_agents_get_nothing(self):
        for a in ("dave", "thor", "marveen", "forge", ""):
            self.assertIsNone(lib.sessionstart_reminder(a))


# --- should_nudge gate (705381e3, pure) --------------------------------------

class ShouldNudgeTests(unittest.TestCase):
    def _entry(self, first_seen, last_nudge=0.0):
        return {"first_seen": first_seen, "last_nudge": last_nudge}

    def test_fresh_short_session_does_not_fire(self):
        now = 1_000_000.0
        e = self._entry(now)  # age 0, small transcript
        self.assertFalse(lib.should_nudge(e, now, 1000, CFG))

    def test_old_but_small_session_does_not_fire(self):
        # The exact case Boss is complaining about: a long-lived 24/7 agent whose
        # transcript is small. Age is no longer a trigger (Boss 2026-08-12), so
        # this must stay quiet even though the session is very old and the cooldown
        # has trivially elapsed.
        now = 1_000_000.0
        e = self._entry(now - CFG["age_threshold_s"] * 100, last_nudge=0.0)
        self.assertFalse(lib.should_nudge(e, now, CFG["transcript_bytes_threshold"] - 1, CFG))

    def test_bloated_transcript_fires_even_when_young(self):
        now = 1_000_000.0
        e = self._entry(now - 10)  # very young, but genuinely large transcript
        self.assertTrue(lib.should_nudge(e, now, CFG["transcript_bytes_threshold"], CFG))

    def test_short_session_small_transcript_stays_quiet(self):
        # Guards the threshold gate: a normal turn must NOT nudge even though the
        # cooldown has trivially elapsed (last_nudge=0).
        now = 1_000_000.0
        e = self._entry(now - 60, last_nudge=0.0)
        self.assertFalse(lib.should_nudge(e, now, 1234, CFG))

    def test_cooldown_suppresses_repeat(self):
        # A genuinely-bloated session that was just nudged must stay quiet within
        # the cooldown window. (Bloat is the only trigger now, so drive with a
        # large transcript rather than age.)
        now = 1_000_000.0
        e = self._entry(now - 10, last_nudge=now - 1)
        self.assertFalse(lib.should_nudge(e, now, CFG["transcript_bytes_threshold"], CFG))

    def test_cooldown_elapsed_re_arms(self):
        now = 1_000_000.0
        e = self._entry(now - 10, last_nudge=now - CFG["cooldown_s"] - 1)
        self.assertTrue(lib.should_nudge(e, now, CFG["transcript_bytes_threshold"], CFG))

    def test_none_transcript_does_not_fire(self):
        # transcript_bytes unknown (None) -> fail-quiet, never fire, regardless of
        # age (Boss 2026-08-12: age is no longer a trigger).
        now = 1_000_000.0
        young = self._entry(now - 10)
        self.assertFalse(lib.should_nudge(young, now, None, CFG))
        old = self._entry(now - CFG["age_threshold_s"] * 100)
        self.assertFalse(lib.should_nudge(old, now, None, CFG))


# --- session-state helpers ---------------------------------------------------

class SessionStateTests(unittest.TestCase):
    def test_new_session_records_first_seen(self):
        state = {}
        e = lib.get_session_entry(state, "s1", 500.0)
        self.assertEqual(e["first_seen"], 500.0)
        self.assertIn("s1", state)

    def test_existing_session_first_seen_preserved(self):
        state = {"s1": {"first_seen": 100.0, "last_nudge": 0.0}}
        e = lib.get_session_entry(state, "s1", 999.0)
        self.assertEqual(e["first_seen"], 100.0)

    def test_malformed_entry_is_reseeded(self):
        state = {"s1": "garbage"}
        e = lib.get_session_entry(state, "s1", 42.0)
        self.assertEqual(e["first_seen"], 42.0)

    def test_prune_drops_old_sessions_keeps_fresh(self):
        now = 1_000_000.0
        state = {
            "old": {"first_seen": now - CFG["session_prune_s"] - 1, "last_nudge": 0.0},
            "fresh": {"first_seen": now - 10, "last_nudge": 0.0},
        }
        lib.prune_sessions(state, now, CFG["session_prune_s"])
        self.assertNotIn("old", state)
        self.assertIn("fresh", state)


class StateIOTests(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "sub", "hibiki.json")
            lib.save_state(p, {"s1": {"first_seen": 1.0, "last_nudge": 2.0}})
            self.assertEqual(lib.load_state(p)["s1"]["first_seen"], 1.0)

    def test_missing_file_returns_empty(self):
        self.assertEqual(lib.load_state("/no/such/path.json"), {})

    def test_corrupt_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "bad.json")
            with open(p, "w") as f:
                f.write("{not json")
            self.assertEqual(lib.load_state(p), {})


class NudgeTextTests(unittest.TestCase):
    def test_contains_both_signals(self):
        t = lib.build_longsession_nudge()
        self.assertIn("VALODI user-utasitas", t)   # (a) anti-TG3000
        self.assertIn("LIVE board", t)             # (b) verify live state


# --- hook integration (subprocess) -------------------------------------------

def _run(hook, payload, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(
        [sys.executable, hook],
        input=json.dumps(payload),
        capture_output=True, text=True, env=env,
    )
    return p


class SessionStartHookTests(unittest.TestCase):
    def test_hibiki_cwd_emits_inbox_reminder(self):
        cwd = os.path.join(_INSTALL, "agents", "hibiki")
        p = _run(_START_HOOK, {"cwd": cwd, "source": "startup"})
        self.assertEqual(p.returncode, 0)
        out = json.loads(p.stdout)
        self.assertIn("INBOX-CHECK", out["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SessionStart")

    def test_unlisted_agent_emits_nothing(self):
        cwd = os.path.join(_INSTALL, "agents", "thor")
        p = _run(_START_HOOK, {"cwd": cwd, "source": "startup"})
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")

    def test_malformed_stdin_exits_zero(self):
        p = subprocess.run([sys.executable, _START_HOOK], input="not json",
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")


class NudgeHookTests(unittest.TestCase):
    def test_fresh_session_no_nudge_but_persists_state(self):
        with tempfile.TemporaryDirectory() as d:
            cwd = os.path.join(_INSTALL, "agents", "hibiki")
            p = _run(_NUDGE_HOOK, {"cwd": cwd, "session_id": "sfresh"},
                     {"SESSION_ENFORCE_INSTALL_DIR": d})
            self.assertEqual(p.returncode, 0)
            self.assertEqual(p.stdout.strip(), "")
            statef = lib.state_path(d, "hibiki")
            self.assertIn("sfresh", lib.load_state(statef))

    def _bloated_transcript(self, d):
        # Write a transcript file at/above the bloat threshold so the hook stats a
        # genuinely-large session (bloat is the only trigger now, Boss 2026-08-12).
        tp = os.path.join(d, "transcript.jsonl")
        with open(tp, "wb") as f:
            f.truncate(CFG["transcript_bytes_threshold"])
        return tp

    def test_old_small_session_does_not_nudge(self):
        # The Boss-reported case: a long-lived 24/7 agent with a small transcript
        # must NOT nudge. Pre-seed an ancient first_seen but pass no (small)
        # transcript_path -> stays quiet.
        with tempfile.TemporaryDirectory() as d:
            cwd = os.path.join(_INSTALL, "agents", "hibiki")
            statef = lib.state_path(d, "hibiki")
            old_first = __import__("time").time() - CFG["age_threshold_s"] * 100
            lib.save_state(statef, {"sold": {"first_seen": old_first, "last_nudge": 0.0}})
            p = _run(_NUDGE_HOOK, {"cwd": cwd, "session_id": "sold"},
                     {"SESSION_ENFORCE_INSTALL_DIR": d})
            self.assertEqual(p.returncode, 0)
            self.assertEqual(p.stdout.strip(), "")

    def test_bloated_session_nudges(self):
        with tempfile.TemporaryDirectory() as d:
            cwd = os.path.join(_INSTALL, "agents", "hibiki")
            statef = lib.state_path(d, "hibiki")
            tp = self._bloated_transcript(d)
            p = _run(_NUDGE_HOOK, {"cwd": cwd, "session_id": "sbloat", "transcript_path": tp},
                     {"SESSION_ENFORCE_INSTALL_DIR": d})
            self.assertEqual(p.returncode, 0)
            out = json.loads(p.stdout)
            self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
            self.assertIn("VALODI user-utasitas", out["hookSpecificOutput"]["additionalContext"])
            # last_nudge must be stamped so the cooldown now suppresses a repeat.
            self.assertGreater(lib.load_state(statef)["sbloat"]["last_nudge"], 0.0)

    def test_bloated_session_within_cooldown_stays_quiet(self):
        with tempfile.TemporaryDirectory() as d:
            cwd = os.path.join(_INSTALL, "agents", "hibiki")
            statef = lib.state_path(d, "hibiki")
            tp = self._bloated_transcript(d)
            now = __import__("time").time()
            lib.save_state(statef, {"sbloat": {
                "first_seen": now - 10,
                "last_nudge": now - 1,  # just nudged
            }})
            p = _run(_NUDGE_HOOK, {"cwd": cwd, "session_id": "sbloat", "transcript_path": tp},
                     {"SESSION_ENFORCE_INSTALL_DIR": d})
            self.assertEqual(p.returncode, 0)
            self.assertEqual(p.stdout.strip(), "")

    def test_malformed_stdin_exits_zero(self):
        p = subprocess.run([sys.executable, _NUDGE_HOOK], input="not json",
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
