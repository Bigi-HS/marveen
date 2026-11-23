#!/usr/bin/env python3
"""TDD tests for scripts/apply-telemetry-hook.py (card e810151f).

Tests written RED-first (before implementation exists).
Covers:
  - presence-verify fail-closed: missing telemetry-emit.py -> no hook write
  - idempotency: already_patched(patch(x)) == True
  - CLAUDE_PROJECT_DIR uniform: missing dir -> skip with warning, not crash
  - telemetry-emit.py has model_tier and task_level fields

Run: python3 -m pytest scripts/__tests__/test-apply-telemetry-hook.py -v
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).parent.parent.parent
PATCHER_PATH = REPO_ROOT / "scripts" / "apply-telemetry-hook.py"
HOOK_PATH = REPO_ROOT / "scripts" / "hooks" / "telemetry-emit.py"


def _load_patcher():
    spec = importlib.util.spec_from_file_location("apply_telemetry_hook", PATCHER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_hook():
    spec = importlib.util.spec_from_file_location("telemetry_emit", HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _make_minimal_settings():
    """Return a minimal valid settings.json dict."""
    return {"hooks": {}}


# ---------------------------------------------------------------------------
# 1. presence-verify: telemetry-emit.py must exist before any hook write
# ---------------------------------------------------------------------------

class TestPresenceVerifyFailClosed(unittest.TestCase):
    """If telemetry-emit.py is absent at the agent path -> no settings write."""

    def test_patch_aborted_when_hook_script_missing(self):
        """When telemetry-emit.py does not exist in the agent path, patch() must
        return False (or raise) without modifying settings.json."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as agent_dir:
            # Agent dir has no scripts/hooks/telemetry-emit.py
            settings_path = Path(agent_dir) / ".claude" / "settings.json"
            settings_path.parent.mkdir(parents=True)
            settings_path.write_text(json.dumps(_make_minimal_settings()))

            # presence_verify should fail -> return False / exit non-zero
            result = mod.presence_verify(agent_dir)
            self.assertFalse(result,
                "presence_verify must return False when telemetry-emit.py is missing")

    def test_patch_not_called_when_presence_verify_fails(self):
        """patch_agent() must NOT write to settings.json if presence_verify fails."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as agent_dir:
            settings_path = Path(agent_dir) / ".claude" / "settings.json"
            settings_path.parent.mkdir(parents=True)
            original = json.dumps(_make_minimal_settings())
            settings_path.write_text(original)

            # patch_agent returns False and does NOT write if presence fails
            result = mod.patch_agent(agent_dir)
            self.assertFalse(result)
            # settings unchanged
            self.assertEqual(settings_path.read_text(), original)

    def test_presence_verify_passes_when_script_exists(self):
        """presence_verify returns True when telemetry-emit.py IS present."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as agent_dir:
            hook_dir = Path(agent_dir) / "scripts" / "hooks"
            hook_dir.mkdir(parents=True)
            (hook_dir / "telemetry-emit.py").write_text("# stub")

            result = mod.presence_verify(agent_dir)
            self.assertTrue(result)


# ---------------------------------------------------------------------------
# 2. idempotency: running patch twice produces the same settings
# ---------------------------------------------------------------------------

class TestIdempotency(unittest.TestCase):
    """already_patched(patch(x)) == True -- running twice is a no-op."""

    def test_already_patched_after_patch(self):
        """After patch(), already_patched() must return True."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        settings = _make_minimal_settings()
        patched = mod.patch(settings)
        self.assertTrue(mod.already_patched(patched),
            "already_patched(patch(x)) must be True")

    def test_patch_twice_is_idempotent(self):
        """Calling patch() twice produces the same JSON as calling it once."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        settings = _make_minimal_settings()
        once = mod.patch(settings)
        twice = mod.patch(json.loads(json.dumps(once)))  # deep copy via JSON round-trip

        # Count PostToolUse hook entries -- must be the same
        once_pt = once.get("hooks", {}).get("PostToolUse", [])
        twice_pt = twice.get("hooks", {}).get("PostToolUse", [])
        self.assertEqual(
            json.dumps(once_pt, sort_keys=True),
            json.dumps(twice_pt, sort_keys=True),
            "patch() twice must produce the same PostToolUse as patch() once",
        )

    def test_idempotency_guard_is_struct_check_not_string_marker(self):
        """already_patched() must check the actual command fragment in the JSON
        struct, NOT a fragile string marker injected into the file."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        # Build a settings that already contains the hook entry (simulate already-patched)
        settings = _make_minimal_settings()
        patched = mod.patch(settings)

        # already_patched must work on the in-memory dict, not by reading a file
        result = mod.already_patched(patched)
        self.assertTrue(result, "already_patched should detect the hook via struct check")

        # And on a fresh settings dict it must return False
        fresh = _make_minimal_settings()
        self.assertFalse(mod.already_patched(fresh),
            "already_patched on fresh settings must return False")


# ---------------------------------------------------------------------------
# 3. CLAUDE_PROJECT_DIR uniform: missing dir -> skip with warning, no crash
# ---------------------------------------------------------------------------

class TestClaudeProjectDirUniform(unittest.TestCase):
    """If an agent dir does not have CLAUDE_PROJECT_DIR, skip with warning."""

    def test_missing_agent_dir_is_skipped_not_crashed(self):
        """patch_agent() with a nonexistent dir must return False gracefully."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        result = mod.patch_agent("/nonexistent/agent/dir/xyz")
        self.assertFalse(result,
            "patch_agent on nonexistent dir must return False (skip), not raise")

    def test_missing_settings_json_is_skipped_not_crashed(self):
        """patch_agent() where settings.json is absent must return False gracefully."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as agent_dir:
            # Has scripts/hooks/telemetry-emit.py but NO .claude/settings.json
            hook_dir = Path(agent_dir) / "scripts" / "hooks"
            hook_dir.mkdir(parents=True)
            (hook_dir / "telemetry-emit.py").write_text("# stub")

            result = mod.patch_agent(agent_dir)
            self.assertFalse(result,
                "patch_agent without settings.json must return False (skip), not raise")

    def test_patch_all_skips_agents_without_settings(self):
        """patch_all() with a mix of valid/invalid agents only patches valid ones."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)

            # Valid agent: has scripts/hooks/telemetry-emit.py AND .claude/settings.json
            valid = root_path / "agents" / "alice"
            (valid / "scripts" / "hooks").mkdir(parents=True)
            (valid / "scripts" / "hooks" / "telemetry-emit.py").write_text("# stub")
            (valid / ".claude").mkdir()
            (valid / ".claude" / "settings.json").write_text(
                json.dumps(_make_minimal_settings())
            )

            # Invalid agent: missing settings.json
            invalid = root_path / "agents" / "bob"
            invalid.mkdir(parents=True)

            results = mod.patch_all([str(valid), str(invalid)])
            # results is a dict: {agent_dir: bool}
            self.assertTrue(results[str(valid)],
                "valid agent must be patched successfully")
            self.assertFalse(results[str(invalid)],
                "invalid agent must be skipped (False), not cause a crash")


# ---------------------------------------------------------------------------
# 4. telemetry-emit.py has model_tier and task_level fields
# ---------------------------------------------------------------------------

class TestTelemetryEmitFieldsPresent(unittest.TestCase):
    """build_event() in telemetry-emit.py must include model_tier and task_level."""

    def test_model_tier_in_event(self):
        """build_event must include model_tier in the returned dict."""
        if not HOOK_PATH.exists():
            self.skipTest("telemetry-emit.py not found")
        mod = _load_hook()
        with patch.dict(os.environ, {
            "CLAUDE_MODEL_TIER": "L1",
            "GENESIS_AGENT_ID": "dave",
        }, clear=False):
            event = mod.build_event({
                "tool_name": "Bash",
                "session_id": "sess-x",
            })
        self.assertIsNotNone(event)
        self.assertIn("model_tier", event,
            "build_event must include model_tier field")
        self.assertEqual(event["model_tier"], "L1")

    def test_task_level_in_event(self):
        """build_event must include task_level in the returned dict."""
        if not HOOK_PATH.exists():
            self.skipTest("telemetry-emit.py not found")
        mod = _load_hook()
        with patch.dict(os.environ, {
            "CLAUDE_TASK_LEVEL": "subtask",
            "GENESIS_AGENT_ID": "dave",
        }, clear=False):
            event = mod.build_event({
                "tool_name": "Read",
                "session_id": "sess-y",
            })
        self.assertIsNotNone(event)
        self.assertIn("task_level", event,
            "build_event must include task_level field")
        self.assertEqual(event["task_level"], "subtask")

    def test_model_tier_defaults_to_unknown_when_env_absent(self):
        """model_tier defaults to 'unknown' when CLAUDE_MODEL_TIER is not set."""
        if not HOOK_PATH.exists():
            self.skipTest("telemetry-emit.py not found")
        mod = _load_hook()
        env = dict(os.environ)
        env.pop("CLAUDE_MODEL_TIER", None)
        with patch.dict(os.environ, env, clear=True):
            event = mod.build_event({"tool_name": "Bash"})
        self.assertIsNotNone(event)
        self.assertEqual(event.get("model_tier"), "unknown",
            "model_tier must default to 'unknown' when env var is absent")

    def test_task_level_defaults_to_unknown_when_env_absent(self):
        """task_level defaults to 'unknown' when CLAUDE_TASK_LEVEL is not set."""
        if not HOOK_PATH.exists():
            self.skipTest("telemetry-emit.py not found")
        mod = _load_hook()
        env = dict(os.environ)
        env.pop("CLAUDE_TASK_LEVEL", None)
        with patch.dict(os.environ, env, clear=True):
            event = mod.build_event({"tool_name": "Bash"})
        self.assertIsNotNone(event)
        self.assertEqual(event.get("task_level"), "unknown",
            "task_level must default to 'unknown' when env var is absent")

    def test_new_fields_do_not_break_existing_fields(self):
        """Adding model_tier/task_level must not remove existing fields."""
        if not HOOK_PATH.exists():
            self.skipTest("telemetry-emit.py not found")
        mod = _load_hook()
        with patch.dict(os.environ, {
            "GENESIS_AGENT_ID": "dave",
            "CLAUDE_MODEL_TIER": "L0",
            "CLAUDE_TASK_LEVEL": "top",
        }, clear=False):
            event = mod.build_event({
                "tool_name": "Edit",
                "session_id": "sess-z",
                "tool_response": {"content": "ok"},
            })
        # All original fields must still be present
        for field in ("actor", "verb", "object", "object_type", "status"):
            self.assertIn(field, event, f"Original field '{field}' must still be present")


# ---------------------------------------------------------------------------
# 5. patch() produces a structurally valid PostToolUse hook entry
# ---------------------------------------------------------------------------

class TestPatchStructure(unittest.TestCase):
    """patch() output has the correct PostToolUse structure."""

    def test_post_tool_use_hook_added(self):
        """patch() must add a PostToolUse hook entry for telemetry-emit.py."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        settings = _make_minimal_settings()
        patched = mod.patch(settings)

        pt = patched.get("hooks", {}).get("PostToolUse", [])
        self.assertGreater(len(pt), 0, "PostToolUse must have at least one entry")

    def test_hook_entry_references_telemetry_emit(self):
        """The added hook entry's command must reference telemetry-emit.py."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        settings = _make_minimal_settings()
        patched = mod.patch(settings)

        pt = patched.get("hooks", {}).get("PostToolUse", [])
        commands = [
            h.get("command", "")
            for entry in pt
            for h in entry.get("hooks", [])
        ]
        self.assertTrue(
            any("telemetry-emit.py" in cmd for cmd in commands),
            "At least one PostToolUse hook command must reference telemetry-emit.py",
        )

    def test_hook_entry_has_timeout(self):
        """Each hook entry must specify a timeout."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        settings = _make_minimal_settings()
        patched = mod.patch(settings)

        pt = patched.get("hooks", {}).get("PostToolUse", [])
        for entry in pt:
            for h in entry.get("hooks", []):
                if "telemetry-emit.py" in h.get("command", ""):
                    self.assertIn("timeout", h,
                        "telemetry-emit hook entry must specify a timeout")


# ---------------------------------------------------------------------------
# 6. compact-matcher wiring for MINI_HOT_CACHE_AGENTS (dave, quill)
# ---------------------------------------------------------------------------

def _make_full_agent_fixture(tmp_root: Path, agent_id: str) -> Path:
    """Create a minimal agent dir with both required hook scripts + settings.json."""
    agent_dir = tmp_root / "agents" / agent_id
    hook_dir = agent_dir / "scripts" / "hooks"
    hook_dir.mkdir(parents=True)
    (hook_dir / "telemetry-emit.py").write_text("# stub")
    (hook_dir / "hot-cache-sessionstart.py").write_text("# stub")
    claude_dir = agent_dir / ".claude"
    claude_dir.mkdir()
    (claude_dir / "settings.json").write_text(json.dumps(_make_minimal_settings()))
    return agent_dir


class TestCompactMatcherWiring(unittest.TestCase):
    """apply-telemetry-hook.py must wire SessionStart hot-cache-sessionstart.py
    for MINI_HOT_CACHE_AGENTS (dave, quill) only."""

    def test_compact_matcher_wired_for_dave(self):
        """patch_agent on 'dave' adds SessionStart hot-cache-sessionstart entry."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as root:
            agent_dir = _make_full_agent_fixture(Path(root), "dave")
            settings_path = agent_dir / ".claude" / "settings.json"

            result = mod.patch_agent(str(agent_dir))
            self.assertTrue(result, "patch_agent must succeed for dave")

            settings = json.loads(settings_path.read_text())
            ss_hooks = settings.get("hooks", {}).get("SessionStart", [])
            ss_commands = [
                h.get("command", "")
                for entry in ss_hooks
                for h in entry.get("hooks", [])
            ]
            self.assertTrue(
                any("hot-cache-sessionstart.py" in cmd for cmd in ss_commands),
                "dave must have hot-cache-sessionstart.py wired in SessionStart",
            )

    def test_compact_matcher_wired_for_quill(self):
        """patch_agent on 'quill' adds SessionStart hot-cache-sessionstart entry."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as root:
            agent_dir = _make_full_agent_fixture(Path(root), "quill")
            settings_path = agent_dir / ".claude" / "settings.json"

            mod.patch_agent(str(agent_dir))
            settings = json.loads(settings_path.read_text())
            ss_hooks = settings.get("hooks", {}).get("SessionStart", [])
            ss_commands = [
                h.get("command", "")
                for entry in ss_hooks
                for h in entry.get("hooks", [])
            ]
            self.assertTrue(
                any("hot-cache-sessionstart.py" in cmd for cmd in ss_commands),
                "quill must have hot-cache-sessionstart.py wired in SessionStart",
            )

    def test_compact_matcher_NOT_wired_for_forge(self):
        """patch_agent on 'forge' (not a MINI_HOT_CACHE_AGENT) must NOT add compact entry."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as root:
            agent_dir = _make_full_agent_fixture(Path(root), "forge")
            settings_path = agent_dir / ".claude" / "settings.json"

            mod.patch_agent(str(agent_dir))
            settings = json.loads(settings_path.read_text())
            ss_hooks = settings.get("hooks", {}).get("SessionStart", [])
            ss_commands = [
                h.get("command", "")
                for entry in ss_hooks
                for h in entry.get("hooks", [])
            ]
            self.assertFalse(
                any("hot-cache-sessionstart.py" in cmd for cmd in ss_commands),
                "forge must NOT have hot-cache-sessionstart.py in SessionStart",
            )

    def test_compact_matcher_idempotent(self):
        """Running patch_agent twice must not duplicate SessionStart entries."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as root:
            agent_dir = _make_full_agent_fixture(Path(root), "dave")
            settings_path = agent_dir / ".claude" / "settings.json"

            mod.patch_agent(str(agent_dir))
            mod.patch_agent(str(agent_dir))  # second run

            settings = json.loads(settings_path.read_text())
            ss_hooks = settings.get("hooks", {}).get("SessionStart", [])
            compact_entries = [
                entry for entry in ss_hooks
                if any("hot-cache-sessionstart.py" in h.get("command", "")
                       for h in entry.get("hooks", []))
            ]
            self.assertEqual(len(compact_entries), 1,
                "hot-cache-sessionstart.py must appear exactly once in SessionStart")

    def test_compact_matcher_presence_verify_hot_cache_script(self):
        """If hot-cache-sessionstart.py is absent, compact-matcher is NOT wired."""
        if not PATCHER_PATH.exists():
            self.skipTest("apply-telemetry-hook.py not yet implemented")
        mod = _load_patcher()

        with tempfile.TemporaryDirectory() as root:
            agent_dir = Path(root) / "agents" / "dave"
            hook_dir = agent_dir / "scripts" / "hooks"
            hook_dir.mkdir(parents=True)
            # Only telemetry-emit.py present, NOT hot-cache-sessionstart.py
            (hook_dir / "telemetry-emit.py").write_text("# stub")
            claude_dir = agent_dir / ".claude"
            claude_dir.mkdir()
            (claude_dir / "settings.json").write_text(json.dumps(_make_minimal_settings()))

            mod.patch_agent(str(agent_dir))
            settings = json.loads((claude_dir / "settings.json").read_text())
            ss_hooks = settings.get("hooks", {}).get("SessionStart", [])
            ss_commands = [
                h.get("command", "")
                for entry in ss_hooks
                for h in entry.get("hooks", [])
            ]
            self.assertFalse(
                any("hot-cache-sessionstart.py" in cmd for cmd in ss_commands),
                "compact-matcher must NOT be wired if hot-cache-sessionstart.py is missing",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
