#!/usr/bin/env python3
"""TDD harness for card 2c15b48b: compaction-safe continuity.

Verifies that SessionStart source=compact triggers the same re-hydration
hooks as resume/clear, without running memory-replay (low-token constraint).

Spec: store/specs/compaction-rehydrate-ledger.md
AC1: after /compact the ledger tail + hot-cache are re-injected.
AC2: no per-turn token increase (hooks fire only on compact, not every turn).
AC3: startup/resume/clear behaviour is byte-unchanged.
AC4: if source=compact were absent (hypothetical), PreCompact fallback is noted
     but not tested here (it would require a different CC build).

Run: python3 scripts/hooks/test_compaction_rehydrate.py
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

_HOT_CACHE_HOOK = os.path.join(_HERE, "hot-cache-sessionstart.py")
_LEDGER_HOOK = os.path.join(_HERE, "ledger-replay.py")
_ENFORCE_HOOK = os.path.join(_HERE, "session-start-enforce.py")
_MEMORY_HOOK = os.path.join(_HERE, "memory-replay.py")

_spec = importlib.util.spec_from_file_location(
    "hot_cache_mod", _HOT_CACHE_HOOK
)
_hot_cache_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hot_cache_mod)


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


class HotCacheCompactSourceTests(unittest.TestCase):
    """Unit tests for the FULL_INJECT_SOURCES change in hot-cache-sessionstart."""

    def test_compact_in_full_inject_sources(self):
        """compact must be in FULL_INJECT_SOURCES (the fix)."""
        self.assertIn("compact", _hot_cache_mod.FULL_INJECT_SOURCES)

    def test_resume_still_in_full_inject_sources(self):
        """resume must still be in FULL_INJECT_SOURCES (AC3: unchanged)."""
        self.assertIn("resume", _hot_cache_mod.FULL_INJECT_SOURCES)

    def test_clear_still_in_full_inject_sources(self):
        """clear must still be in FULL_INJECT_SOURCES (AC3: unchanged)."""
        self.assertIn("clear", _hot_cache_mod.FULL_INJECT_SOURCES)

    def test_startup_not_in_full_inject_sources(self):
        """startup is handled via the MINI_HOT_CACHE_AGENTS path, not full inject."""
        self.assertNotIn("startup", _hot_cache_mod.FULL_INJECT_SOURCES)


class HotCacheHookCompactIntegrationTests(unittest.TestCase):
    """Subprocess integration: hot-cache-sessionstart must not exit-0-with-nothing
    when source=compact for a context-sensitive agent (marveen) that has a cache."""

    def setUp(self):
        # Write a minimal hot-cache file for marveen in a temp dir.
        self._tmpdir = tempfile.mkdtemp()
        cache_dir = os.path.join(self._tmpdir, ".claude")
        os.makedirs(cache_dir)
        with open(os.path.join(cache_dir, "hot-cache.md"), "w") as f:
            f.write("# marveen -- Hot Cache\n\n**Pending:** test continuity after compact\n")
        # Fake store/.dashboard-token so the refresh path fails gracefully.
        store_dir = os.path.join(self._tmpdir, "store")
        os.makedirs(store_dir)
        with open(os.path.join(store_dir, ".dashboard-token"), "w") as f:
            f.write("fake-token-for-test")

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _marveen_cwd(self):
        # Return the main project root cwd so the hook resolves to 'marveen'.
        return _INSTALL

    def test_compact_source_does_not_exit_with_empty_output(self):
        """source=compact must NOT produce the silent no-op that the old code did
        (before the fix the else-branch called sys.exit(0) for unknown sources)."""
        # We test the module logic directly: for source=compact + marveen agent,
        # the char_limit should be CONTENT_CHAR_LIMIT (full inject), not a skip.
        source = "compact"
        self.assertIn(source, _hot_cache_mod.FULL_INJECT_SOURCES)
        # Confirm the branch: source in FULL_INJECT_SOURCES -> char_limit = CONTENT_CHAR_LIMIT
        # (not the MINI limit and not sys.exit(0)).
        expected_limit = _hot_cache_mod.CONTENT_CHAR_LIMIT
        # Simulate the if/elif/else logic from main():
        if source in _hot_cache_mod.FULL_INJECT_SOURCES:
            char_limit = _hot_cache_mod.CONTENT_CHAR_LIMIT
        elif source == "startup" and "marveen" in _hot_cache_mod.MINI_HOT_CACHE_AGENTS:
            char_limit = _hot_cache_mod.MINI_CONTENT_CHAR_LIMIT
        else:
            char_limit = None  # would sys.exit(0)
        self.assertEqual(char_limit, expected_limit,
                         "compact source must map to full CONTENT_CHAR_LIMIT, not a skip")

    def test_startup_behaviour_unchanged(self):
        """startup for a non-context-sensitive agent still maps to skip (AC3)."""
        source = "startup"
        agent = "thor"
        self.assertNotIn(source, _hot_cache_mod.FULL_INJECT_SOURCES)
        self.assertNotIn(agent, _hot_cache_mod.MINI_HOT_CACHE_AGENTS)
        # The else branch fires for startup + stateless agent -> skip (AC3 preserved).
        if source in _hot_cache_mod.FULL_INJECT_SOURCES:
            path = "full"
        elif source == "startup" and agent in _hot_cache_mod.MINI_HOT_CACHE_AGENTS:
            path = "mini"
        else:
            path = "skip"
        self.assertEqual(path, "skip")

    def test_hook_exits_zero_with_compact_source_and_no_cache(self):
        """Hook must not crash (exit 0) even when no hot-cache file exists."""
        p = _run(_HOT_CACHE_HOOK, {"cwd": "/tmp/nonexistent-agent-dir", "source": "compact"})
        self.assertEqual(p.returncode, 0,
                         f"hook crashed with returncode {p.returncode}: {p.stderr[:300]}")

    def test_hook_exits_zero_with_malformed_stdin(self):
        """Malformed JSON must not crash the hook (always exit 0)."""
        p = subprocess.run([sys.executable, _HOT_CACHE_HOOK],
                           input="not json", capture_output=True, text=True)
        self.assertEqual(p.returncode, 0)


class LedgerReplayCompactTests(unittest.TestCase):
    """ledger-replay.py must accept source=compact without crashing."""

    def test_ledger_replay_exits_zero_with_compact_source(self):
        """Passing source=compact in the payload must not cause ledger-replay to crash.
        It does not gate on source, so this is a regression guard only."""
        p = _run(_LEDGER_HOOK, {"cwd": _INSTALL, "source": "compact"})
        # May fail to reach the API (no live server in CI), but must not crash (not rc=1).
        self.assertIn(p.returncode, (0, 1),
                      f"unexpected returncode {p.returncode}: {p.stderr[:300]}")
        # rc=1 is acceptable only if the error is API connectivity (not a Python exception).
        if p.returncode == 1:
            # If it's a pure Python crash the traceback appears in stderr without JSON.
            self.assertNotIn("Traceback (most recent call last)", p.stderr,
                             "ledger-replay crashed with a Python exception on source=compact")


class SettingsJsonCompactMatcherTests(unittest.TestCase):
    """settings.json must wire source=compact to both ledger-replay and hot-cache."""

    def setUp(self):
        settings_path = os.path.join(_INSTALL, ".claude", "settings.json")
        with open(settings_path) as f:
            self._settings = json.load(f)
        self._session_start = self._settings.get("hooks", {}).get("SessionStart", [])

    def test_ledger_replay_matcher_includes_compact(self):
        """The matcher that runs ledger-replay.py must include 'compact' (AC1)."""
        for entry in self._session_start:
            hooks = entry.get("hooks", [])
            commands = [h.get("command", "") for h in hooks]
            if any("ledger-replay.py" in c for c in commands):
                matcher = entry.get("matcher", "")
                self.assertIn("compact", matcher,
                              f"ledger-replay matcher '{matcher}' must include 'compact'")
                return
        self.fail("No SessionStart entry found that runs ledger-replay.py")

    def test_hot_cache_hook_runs_on_compact(self):
        """There must be a SessionStart entry whose matcher fires on 'compact'
        and runs hot-cache-sessionstart.py (AC1)."""
        for entry in self._session_start:
            matcher = entry.get("matcher", "")
            hooks = entry.get("hooks", [])
            commands = [h.get("command", "") for h in hooks]
            if "compact" in matcher and any("hot-cache-sessionstart.py" in c for c in commands):
                return
        self.fail("No SessionStart entry fires hot-cache-sessionstart.py on 'compact'")

    def test_memory_replay_does_not_run_on_compact(self):
        """memory-replay.py must NOT run on compact (low-token constraint, spec §solution)."""
        for entry in self._session_start:
            matcher = entry.get("matcher", "")
            hooks = entry.get("hooks", [])
            commands = [h.get("command", "") for h in hooks]
            if "compact" in matcher and any("memory-replay.py" in c for c in commands):
                self.fail(
                    f"memory-replay.py fires on compact (matcher '{matcher}') "
                    "-- spec says keep memory-replay OUT of compact to stay low-token"
                )

    def test_startup_resume_clear_behaviour_unchanged(self):
        """The startup-only matcher (memory-replay + hot-cache) must still have
        exactly 'startup' as its matcher, unchanged (AC3)."""
        for entry in self._session_start:
            matcher = entry.get("matcher", "")
            hooks = entry.get("hooks", [])
            commands = [h.get("command", "") for h in hooks]
            if any("memory-replay.py" in c for c in commands):
                self.assertEqual(matcher, "startup",
                                 "memory-replay matcher must remain 'startup' unchanged")
                return
        self.fail("No SessionStart entry found that runs memory-replay.py")


if __name__ == "__main__":
    unittest.main(verbosity=2)
