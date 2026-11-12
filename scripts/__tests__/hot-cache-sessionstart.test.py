#!/usr/bin/env python3
"""Tests for scripts/hooks/hot-cache-sessionstart.py (card 847237f4 F3).

Policy:
  - startup + stateless agent (thor, gauge): skip (no output)
  - startup + context-sensitive agent (dave, quill): mini hot-cache
  - resume/clear: full hot-cache for any agent
  - no hot-cache file: no-op always
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).parent.parent / "hooks" / "hot-cache-sessionstart.py"
INSTALL_DIR = Path(__file__).parent.parent.parent


def run_hook(
    source: str,
    agent_id: str,
    hot_cache_content: str | None = "Test hot-cache content",
    roster: bool = False,
) -> dict:
    if agent_id == "marveen":
        cwd = str(INSTALL_DIR)
        cache_path = INSTALL_DIR / ".claude" / "hot-cache.md"
    else:
        cwd = str(INSTALL_DIR / "agents" / agent_id)
        cache_path = INSTALL_DIR / "agents" / agent_id / ".claude" / "hot-cache.md"

    if hot_cache_content is not None:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(hot_cache_content, encoding="utf-8")
    elif cache_path.exists():
        cache_path.unlink()

    payload = json.dumps({"cwd": cwd, "source": source})
    # Test the inject-policy in isolation: disable the Phase 2b SessionStart
    # refresh (card 6485f301) so the hook reads the fixture verbatim instead of
    # regenerating it from the live DBs (which would also clobber real caches).
    # Refresh has its own coverage in hot-cache-sessionstart-refresh.test.ts.
    # Roster append (card aeea36ee) is OFF by default here so the policy tests
    # are not perturbed by the real roster file; the roster tests opt in.
    env = {
        **os.environ,
        "HOT_CACHE_SESSIONSTART_REFRESH": "0",
        "HOT_CACHE_SESSIONSTART_ROSTER": "1" if roster else "0",
    }
    result = subprocess.run(
        [sys.executable, str(HOOK)], input=payload, capture_output=True, text=True, env=env
    )

    # Cleanup
    if hot_cache_content is not None and cache_path.exists():
        cache_path.unlink()

    if result.returncode != 0 or not result.stdout.strip():
        return {}
    try:
        return json.loads(result.stdout)
    except Exception:
        return {}


LONG_CONTENT = "Last task: testing\n" + "word " * 200  # ~1000 chars


class TestHotCacheF3Policy(unittest.TestCase):

    def test_startup_skipped_for_thor(self):
        """Thor is stateless -> no inject on startup."""
        result = run_hook("startup", "thor", hot_cache_content=LONG_CONTENT)
        self.assertEqual(result, {})

    def test_startup_skipped_for_gauge(self):
        result = run_hook("startup", "gauge", hot_cache_content=LONG_CONTENT)
        self.assertEqual(result, {})

    def test_startup_mini_for_dave(self):
        """Dave gets a mini hot-cache on startup (not full)."""
        full = run_hook("resume", "dave", hot_cache_content=LONG_CONTENT)
        mini = run_hook("startup", "dave", hot_cache_content=LONG_CONTENT)
        full_ctx = full.get("hookSpecificOutput", {}).get("additionalContext", "")
        mini_ctx = mini.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertGreater(len(mini_ctx), 0, "Dave should get some context on startup")
        self.assertLess(len(mini_ctx), len(full_ctx), "Mini must be shorter than full")

    def test_startup_mini_for_quill(self):
        result = run_hook("startup", "quill", hot_cache_content=LONG_CONTENT)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertGreater(len(ctx), 0)

    def test_resume_full_for_dave(self):
        result = run_hook("resume", "dave", hot_cache_content=LONG_CONTENT)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertGreater(len(ctx), 0)

    def test_resume_full_for_thor(self):
        """Even stateless agents get full hot-cache on resume."""
        result = run_hook("resume", "thor", hot_cache_content=LONG_CONTENT)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertGreater(len(ctx), 0)

    def test_clear_full_inject(self):
        result = run_hook("clear", "dave", hot_cache_content=LONG_CONTENT)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertGreater(len(ctx), 0)

    def test_no_file_is_noop(self):
        for source in ["startup", "resume", "clear"]:
            with self.subTest(source=source):
                result = run_hook(source, "dave", hot_cache_content=None)
                self.assertEqual(result, {})


ROSTER_PATH = INSTALL_DIR / "store" / "fleet-roster-registry.md"
ROSTER_MARKER = "Genesis Fleet -- Kanonikus Roster"


class TestFleetRosterAppend(unittest.TestCase):
    """Part B wiring (card aeea36ee): the SessionStart inject also carries the
    canonical fleet roster, defensively (missing file -> graceful skip)."""

    def setUp(self):
        # Preserve any existing roster so the test never clobbers real state.
        self._backup = ROSTER_PATH.read_bytes() if ROSTER_PATH.exists() else None
        ROSTER_PATH.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        if self._backup is not None:
            ROSTER_PATH.write_bytes(self._backup)
        elif ROSTER_PATH.exists():
            ROSTER_PATH.unlink()

    def _ctx(self, result):
        return result.get("hookSpecificOutput", {}).get("additionalContext", "")

    def test_roster_appended_when_present(self):
        ROSTER_PATH.write_text(
            "# " + ROSTER_MARKER + "\n\n| agent_id | Display |\n|---|---|\n| dave | Dave |\n",
            encoding="utf-8",
        )
        result = run_hook("resume", "dave", hot_cache_content=LONG_CONTENT, roster=True)
        ctx = self._ctx(result)
        self.assertIn(ROSTER_MARKER, ctx)
        self.assertIn("FLEET ROSTER", ctx)

    def test_roster_absent_graceful_skip(self):
        if ROSTER_PATH.exists():
            ROSTER_PATH.unlink()
        result = run_hook("resume", "dave", hot_cache_content=LONG_CONTENT, roster=True)
        ctx = self._ctx(result)
        # Hot-cache still injected, roster simply omitted -- no crash, no marker.
        self.assertGreater(len(ctx), 0)
        self.assertNotIn(ROSTER_MARKER, ctx)

    def test_roster_flag_off_omits_roster(self):
        ROSTER_PATH.write_text("# " + ROSTER_MARKER + "\n", encoding="utf-8")
        result = run_hook("resume", "dave", hot_cache_content=LONG_CONTENT, roster=False)
        ctx = self._ctx(result)
        self.assertGreater(len(ctx), 0)
        self.assertNotIn(ROSTER_MARKER, ctx)

    def test_no_hot_cache_no_roster_still_noop(self):
        # Even with a roster present, no hot-cache file -> whole hook no-ops
        # (roster append happens only after a hot-cache block is produced).
        ROSTER_PATH.write_text("# " + ROSTER_MARKER + "\n", encoding="utf-8")
        result = run_hook("resume", "dave", hot_cache_content=None, roster=True)
        self.assertEqual(result, {})


if __name__ == "__main__":
    unittest.main()
