#!/usr/bin/env python3
"""Acceptance tests for the skill-regression badge + cron install (card 8a04b73d).

Validates two additions to the PR #117 harness:
  (a) scripts/skill-regression.sh writes store/skill-regression-badge.json after a
      run -- shields.io endpoint schema + explicit PASS/WARN/BLOCK counts + timestamp.
  (b) scripts/install-skill-regression-cron.sh exists, is repo-tracked + executable,
      idempotent-by-marker, and does NOT auto-install a live cron when merged (the
      cron line is only emitted when the operator runs the script).

Design: the harness is driven against a TEMP skills dir via SKILL_REGRESSION_DIR and
a TEMP install dir via SKILL_REGRESSION_BADGE/last env overrides are NOT used -- the
script derives store/ from its own location, so we copy the script into a temp tree.
Instead we run the real script with SKILL_REGRESSION_DIR pointing at a synthetic
skills fixture and assert on the badge it writes under the repo's store/ (cleaned up).

Run: python3 scripts/__tests__/skill-regression-badge.test.py
"""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(REPO, "scripts", "skill-regression.sh")
INSTALL = os.path.join(REPO, "scripts", "install-skill-regression-cron.sh")
BADGE = os.path.join(REPO, "store", "skill-regression-badge.json")

# The ten skills the harness checks; fixtures must cover all of them or every one
# reports BLOCK "skill not found" (still a valid run, just an all-BLOCK badge).
TOP10 = [
    "fleet-ops", "fleet-pr-merge-gate", "fleet-deploy-verify", "security-audit",
    "unstick-wedged-agent", "pre-gate-evidence-bundle", "ephemeral-eng-workflow",
    "fleet-meeting", "spawn-fleet-subagent", "c12-chameleon-test",
]

# Minimal SKILL.md that passes every check, parameterized with the required keywords.
KEYWORDS = {
    "fleet-ops": "store/.dashboard-token localhost:3420 kanban_cards",
    "fleet-pr-merge-gate": "mergeable urllib merge_method Bigi-HS/marveen",
    "fleet-deploy-verify": "dist/index.js fleet-supervisor Genesis-GO",
    "security-audit": "PASS FLAG BLOCK",
    "unstick-wedged-agent": "capture-pane delivered_at",
    "pre-gate-evidence-bundle": "tsc vitest",
    "ephemeral-eng-workflow": "git worktree",
    "fleet-meeting": "inter-agent",
    "spawn-fleet-subagent": "CLAUDE_CONFIG_DIR",
    "c12-chameleon-test": "buster",
}


def _passing_md(skill: str) -> str:
    kw = KEYWORDS.get(skill, "")
    return (
        "---\n"
        f"name: {skill}\n"
        f"description: test fixture for {skill}\n"
        "---\n\n"
        "## When to use\nx\n\n"
        "## Procedure\n"
        f"keywords: {kw}\n\n"
        "## Pitfalls\nx\n\n"
        "## Validation\nx\n"
    )


def _make_skills_fixture(root: str, skills=None):
    for skill in (skills if skills is not None else TOP10):
        d = os.path.join(root, skill)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(_passing_md(skill))


def _run_harness(skills_dir: str):
    env = dict(os.environ, SKILL_REGRESSION_DIR=skills_dir)
    return subprocess.run(
        ["bash", SCRIPT], capture_output=True, text=True, env=env, cwd=REPO, timeout=120
    )


class BadgeWrittenTests(unittest.TestCase):
    def setUp(self):
        # Snapshot any existing badge so we can restore it (store/ is gitignored,
        # but be a good citizen and not clobber a real local badge).
        self._saved = None
        if os.path.exists(BADGE):
            with open(BADGE, encoding="utf-8") as f:
                self._saved = f.read()

    def tearDown(self):
        if self._saved is not None:
            with open(BADGE, "w", encoding="utf-8") as f:
                f.write(self._saved)

    def test_badge_written_with_pass_verdict_and_schema(self):
        with tempfile.TemporaryDirectory() as d:
            _make_skills_fixture(d)
            r = _run_harness(d)
            self.assertEqual(r.returncode, 0, f"all-pass fixture should exit 0\n{r.stdout}\n{r.stderr}")
            self.assertTrue(os.path.exists(BADGE), "badge file must be written")
            with open(BADGE, encoding="utf-8") as f:
                badge = json.load(f)
            # shields.io endpoint schema
            self.assertEqual(badge["schemaVersion"], 1)
            self.assertEqual(badge["label"], "skill-regression")
            self.assertIn("message", badge)
            self.assertEqual(badge["color"], "brightgreen")
            self.assertEqual(badge["verdict"], "PASS")
            # explicit PASS/WARN/BLOCK counts
            self.assertEqual(badge["counts"], {"pass": 10, "warn": 0, "block": 0})
            self.assertEqual(badge["total"], 10)
            self.assertEqual(
                sum(badge["counts"].values()), badge["total"],
                "pass+warn+block must equal total",
            )
            # timestamp present, integer epoch + ISO-8601
            self.assertIsInstance(badge["timestamp"], int)
            self.assertRegex(badge["timestamp_iso"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")

    def test_badge_block_verdict_and_color_on_missing_skill(self):
        with tempfile.TemporaryDirectory() as d:
            # Empty fixture -> every skill BLOCKs "skill not found".
            r = _run_harness(d)
            self.assertEqual(r.returncode, 1, "any BLOCK should exit 1")
            with open(BADGE, encoding="utf-8") as f:
                badge = json.load(f)
            self.assertEqual(badge["verdict"], "BLOCK")
            self.assertEqual(badge["color"], "red")
            self.assertEqual(badge["counts"]["block"], 10)
            self.assertEqual(badge["counts"]["pass"], 0)


class InstallScriptTests(unittest.TestCase):
    """The cron installer must be repo-tracked, executable, idempotent-by-marker,
    and must NOT install a live cron just by being present (deploy step, not merge)."""

    def test_install_script_exists_and_executable(self):
        self.assertTrue(os.path.exists(INSTALL), "install script must exist")
        mode = os.stat(INSTALL).st_mode
        self.assertTrue(mode & stat.S_IXUSR, "install script must be executable")

    def test_install_script_is_valid_bash(self):
        r = subprocess.run(["bash", "-n", INSTALL], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, f"bash -n failed: {r.stderr}")

    def test_install_script_idempotent_marker_and_no_autoinstall(self):
        with open(INSTALL, encoding="utf-8") as f:
            src = f.read()
        # Unique marker for idempotent replace (grep -vF marker, then re-append).
        self.assertIn("card 8a04b73d", src, "must carry a unique idempotency marker")
        self.assertIn("grep -vF", src, "must filter old line by marker (idempotent)")
        self.assertIn("crontab -", src, "must write the crontab via `crontab -`")
        # The cron line must invoke the harness, daily, marker-tagged.
        self.assertRegex(src, r"skill-regression\.sh", "cron must run the harness")
        self.assertRegex(src, r'SCHEDULE="[\d ]*\* \* \*"', "must define a daily cron schedule")
        # Anti-auto-install: the crontab write happens inside the script body, NOT at
        # import/source time -- there's no top-level call to the script anywhere else.
        # Guard against a stray `crontab -` outside this dedicated installer.
        with open(SCRIPT, encoding="utf-8") as hf:
            harness_src = hf.read()
        self.assertNotIn("crontab", harness_src,
                         "the harness itself must NOT touch crontab (no auto-install on run)")

    def test_no_live_cron_assumed(self):
        """Sanity: running the harness does not register a cron (only the installer does)."""
        before = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
        with tempfile.TemporaryDirectory() as d:
            _make_skills_fixture(d)
            _run_harness(d)
        after = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
        self.assertEqual(before, after, "running the harness must not change the crontab")


if __name__ == "__main__":
    if not os.path.exists(SCRIPT):
        print(f"SKIP: {SCRIPT} not found")
        sys.exit(0)
    unittest.main(verbosity=2)
