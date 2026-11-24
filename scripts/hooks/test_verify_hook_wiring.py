#!/usr/bin/env python3
"""TDD suite for verify-hook-wiring.py (card 828fd3ad, SEC-119 rollout-order hardening).

Run: python3 scripts/hooks/test_verify_hook_wiring.py

The guard enforces land-script-first: before any patcher touches a settings.json,
it statically resolves EVERY hook `command` script path across all event sections
(PreToolUse/PostToolUse/SessionStart/...) and REFUSES if any referenced script does
not exist on disk. This prevents the 2026-11-22 silent-fleet-brick where a
mcp__.*|Bash matcher was wired to egress-pii-scan.py BEFORE the script landed ->
PreToolUse hook with a missing script fails-closed and bricks both Bash and MCP with
no escalation channel.

Cases covered (card AC):
  1. script-present  -> PASS (verify_hook_wiring returns ok, missing == [])
  2. script-missing  -> REFUSE (ok False, the missing path reported)
  3. broad-matcher (mcp__.*|Bash) + missing script = the exact 1122 brick class
     (flagged as high-severity brick_risk)
  4. relative vs $CLAUDE_PROJECT_DIR path resolution both work
  5. fallback-no-op: degrade helper rewrites a missing-script hook to a benign
     no-op reference rather than a hard brick.
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD = os.path.join(_HERE, 'verify-hook-wiring.py')

_spec = importlib.util.spec_from_file_location('verify_hook_wiring', _MOD)
vhw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vhw)


def _settings(matcher, command, event="PreToolUse"):
    return {
        "hooks": {
            event: [
                {
                    "matcher": matcher,
                    "hooks": [{"type": "command", "command": command, "timeout": 5}],
                }
            ]
        }
    }


class ResolveScriptPathTests(unittest.TestCase):
    """The command-string -> script-path resolver (static, no shell)."""

    def test_quoted_project_dir_token(self):
        cmd = 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/egress-pii-scan.py"'
        p = vhw.resolve_script_path(cmd, project_root="/root")
        self.assertEqual(p, "/root/scripts/hooks/egress-pii-scan.py")

    def test_relative_path(self):
        cmd = 'python3 scripts/hooks/foo.py'
        p = vhw.resolve_script_path(cmd, project_root="/root")
        self.assertEqual(p, "/root/scripts/hooks/foo.py")

    def test_absolute_path(self):
        cmd = 'python3 "/abs/scripts/hooks/bar.py"'
        p = vhw.resolve_script_path(cmd, project_root="/root")
        self.assertEqual(p, "/abs/scripts/hooks/bar.py")

    def test_no_script_returns_none(self):
        # A command with no .py/.sh script token (e.g. a pure shell builtin).
        cmd = 'echo hello'
        self.assertIsNone(vhw.resolve_script_path(cmd, project_root="/root"))


class ScriptPresentPasses(unittest.TestCase):
    def test_present_script_passes(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root) / "scripts" / "hooks" / "present.py"
            script.parent.mkdir(parents=True)
            script.write_text("# real\n")
            s = _settings("Bash", 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/present.py"')
            res = vhw.verify_hook_wiring(s, project_root=root)
            self.assertTrue(res.ok, res.missing)
            self.assertEqual(res.missing, [])
            self.assertEqual(res.brick_risk, [])


class ScriptMissingRefuses(unittest.TestCase):
    def test_missing_script_refuses(self):
        with tempfile.TemporaryDirectory() as root:
            s = _settings("Write", 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/ghost.py"')
            res = vhw.verify_hook_wiring(s, project_root=root)
            self.assertFalse(res.ok)
            self.assertIn(
                os.path.join(root, "scripts/hooks/ghost.py"),
                [m.script for m in res.missing],
            )

    def test_relative_missing_also_refuses(self):
        with tempfile.TemporaryDirectory() as root:
            s = _settings("Edit", 'python3 scripts/hooks/ghost-rel.py')
            res = vhw.verify_hook_wiring(s, project_root=root)
            self.assertFalse(res.ok)


class BrickClass1122(unittest.TestCase):
    """mcp__.*|Bash matcher + missing script = the exact 2026-11-22 brick class."""

    def test_broad_matcher_missing_script_is_brick_risk(self):
        with tempfile.TemporaryDirectory() as root:
            s = _settings(
                "mcp__.*|Bash",
                'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/egress-pii-scan.py"',
                event="PreToolUse",
            )
            res = vhw.verify_hook_wiring(s, project_root=root)
            self.assertFalse(res.ok)
            # The missing script under a Bash+MCP-covering PreToolUse matcher is the
            # fleet-brick class: it must be flagged at the highest severity.
            self.assertTrue(res.brick_risk, "broad-matcher miss must be brick_risk")
            self.assertTrue(
                any("egress-pii-scan.py" in m.script for m in res.brick_risk)
            )

    def test_narrow_matcher_missing_is_refuse_but_not_brick(self):
        # A missing script behind a narrow, non-tool-blocking matcher still REFUSES
        # (land-script-first) but is NOT the fleet-brick class.
        with tempfile.TemporaryDirectory() as root:
            s = _settings(
                "mcp__plugin.telegram.telegram__reply",
                'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/ghost.py"',
                event="PreToolUse",
            )
            res = vhw.verify_hook_wiring(s, project_root=root)
            self.assertFalse(res.ok)
            self.assertEqual(res.brick_risk, [])


class MatcherCoversBashOrMcp(unittest.TestCase):
    def test_broad_regex_covers_bash(self):
        self.assertTrue(vhw.matcher_can_block_tools("mcp__.*|Bash"))
        self.assertTrue(vhw.matcher_can_block_tools(".*"))
        self.assertTrue(vhw.matcher_can_block_tools("Bash|Write|Edit"))

    def test_narrow_matcher_does_not_block_core_tools(self):
        self.assertFalse(
            vhw.matcher_can_block_tools("mcp__plugin.telegram.telegram__reply")
        )


class FallbackNoOp(unittest.TestCase):
    """Degrade-to-no-op: rather than hard-brick, rewrite missing-script hooks."""

    def test_degrade_rewrites_missing_to_noop(self):
        with tempfile.TemporaryDirectory() as root:
            s = _settings("Bash", 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/ghost.py"')
            degraded = vhw.degrade_to_noop(s, project_root=root)
            cmd = degraded["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            self.assertIn(vhw.NOOP_COMMAND, cmd)
            # After degrade, verification passes (no missing scripts, no brick risk).
            res = vhw.verify_hook_wiring(degraded, project_root=root)
            self.assertTrue(res.ok, res.missing)

    def test_degrade_leaves_present_scripts_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root) / "scripts" / "hooks" / "present.py"
            script.parent.mkdir(parents=True)
            script.write_text("# real\n")
            orig_cmd = 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/present.py"'
            s = _settings("Bash", orig_cmd)
            degraded = vhw.degrade_to_noop(s, project_root=root)
            cmd = degraded["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            self.assertEqual(cmd, orig_cmd)


class AssertGuardRaises(unittest.TestCase):
    """The patcher-facing guard raises on refusal (importable barrier)."""

    def test_assert_raises_on_missing(self):
        with tempfile.TemporaryDirectory() as root:
            s = _settings("Bash", 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/ghost.py"')
            with self.assertRaises(vhw.HookWiringError):
                vhw.assert_scripts_present(s, project_root=root)

    def test_assert_passes_on_present(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root) / "scripts" / "hooks" / "present.py"
            script.parent.mkdir(parents=True)
            script.write_text("# real\n")
            s = _settings("Bash", 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/present.py"')
            # Should not raise.
            vhw.assert_scripts_present(s, project_root=root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
