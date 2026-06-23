#!/usr/bin/env python3
"""Acceptance tests for the c12 pane-state.ts detector gate in pre-gate-bundle.sh

Card: 6f763ea8
Rule: Any PR touching SPINNER_NAMES / BUSY_INDICATOR / PANE_DETECTOR_BASELINE_CLI_VERSION
in src/pane-state.ts must have a c12 chameleon smoke PASS sentinel before merge. The
check BLOCKs the verdict (not advisory). cli-version-mismatch.txt present is a standalone
WARN that affects the verdict.

Sentinel file: store/c12-smoke-pane-<head-sha>.pass  (created by Buster on smoke PASS).
C12_SMOKE_DIR is overridable for hermetic tests.
INSTALL_DIR is inferred from the script location; store/cli-version-mismatch.txt lives
relative to INSTALL_DIR.

Run: python3 scripts/__tests__/c12-pane-state-check.test.py
"""
import os
import stat
import subprocess
import tempfile
import unittest

BUNDLE_SCRIPT = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "pre-gate-bundle.sh"
))

HEAD_SHA = "aabbccdd1122334455667788990011223344556677"

DETECTOR_DIFF = """\
diff --git a/src/pane-state.ts b/src/pane-state.ts
--- a/src/pane-state.ts
+++ b/src/pane-state.ts
@@ -1,3 +1,3 @@
-export const SPINNER_NAMES = ['old']
+export const SPINNER_NAMES = ['new']
"""

NON_DETECTOR_DIFF = """\
diff --git a/src/pane-state.ts b/src/pane-state.ts
--- a/src/pane-state.ts
+++ b/src/pane-state.ts
@@ -10,3 +10,3 @@
-const unrelated = 1
+const unrelated = 2
"""


def _make_stub(content: str, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/bash\n" + content)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP)


def _make_npx_stub(d: str) -> None:
    content = """case "$1" in
  tsc)    exit 0 ;;
  vitest) echo "Tests 1 passed"; exit 0 ;;
  *)      exec /usr/bin/npx "$@" ;;
esac
"""
    _make_stub(content, os.path.join(d, "npx"))


def _make_git_stub(d: str, pane_state_diff: str = "", additions: int = 5) -> None:
    # Write pane-state diff to a temp file so bash can cat it without quoting issues
    diff_file = os.path.join(d, "_pane_diff.txt")
    with open(diff_file, "w", encoding="utf-8") as f:
        f.write(pane_state_diff)
    content = f"""if [[ "$*" == *"--numstat"* ]]; then
  echo "{additions}\\t0\\tsrc/fake.ts"
elif [[ "$*" == *"-- src/pane-state.ts"* ]]; then
  cat "{diff_file}"
elif [[ "$*" == *"diff"* ]] || [[ "$*" == *"grep"* ]]; then
  echo ""
else
  exec /usr/bin/git "$@"
fi
"""
    _make_stub(content, os.path.join(d, "git"))


def _run(stub_dir: str, c12_smoke_dir: str, extra_env: dict | None = None,
         args: list | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ, PATH=stub_dir + ":" + os.environ.get("PATH", ""))
    env["DA_RUNS_DIR"] = os.path.join(stub_dir, "da-runs-empty")
    os.makedirs(env["DA_RUNS_DIR"], exist_ok=True)
    env["C12_SMOKE_DIR"] = c12_smoke_dir
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["bash", BUNDLE_SCRIPT, "develop", HEAD_SHA] + (args or []),
        capture_output=True, text=True, cwd=stub_dir, env=env,
    )


class NoPaneStateDiffTests(unittest.TestCase):
    """pane-state.ts not touched -> c12-pane check silent, verdict unaffected."""

    def test_no_diff_no_c12_entry(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff="")
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            r = _run(d, c12_dir)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("verdict: PASS", r.stdout)
            self.assertNotIn("c12-pane", r.stdout)

    def test_non_detector_change_no_block(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff=NON_DETECTOR_DIFF)
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            r = _run(d, c12_dir)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("verdict: PASS", r.stdout)
            # no BLOCK entry for c12-pane
            self.assertNotIn("BLOCK", r.stdout)


class DetectorChangedNoSentinelTests(unittest.TestCase):
    """Detector pattern changed, no smoke sentinel -> BLOCK."""

    def test_spinner_names_change_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff=DETECTOR_DIFF)
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            r = _run(d, c12_dir)
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn("verdict: BLOCK", r.stdout)
            self.assertIn("c12-pane", r.stdout)

    def test_busy_indicator_change_blocks(self):
        busy_diff = DETECTOR_DIFF.replace("SPINNER_NAMES", "BUSY_INDICATOR")
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff=busy_diff)
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            r = _run(d, c12_dir)
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn("verdict: BLOCK", r.stdout)

    def test_baseline_cli_version_change_blocks(self):
        cli_diff = DETECTOR_DIFF.replace("SPINNER_NAMES", "PANE_DETECTOR_BASELINE_CLI_VERSION")
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff=cli_diff)
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            r = _run(d, c12_dir)
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn("verdict: BLOCK", r.stdout)

    def test_block_message_names_sentinel_path(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff=DETECTOR_DIFF)
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            r = _run(d, c12_dir)
            self.assertIn("c12-smoke-pane-" + HEAD_SHA + ".pass", r.stdout)


class DetectorChangedWithSentinelTests(unittest.TestCase):
    """Detector pattern changed AND smoke sentinel present -> PASS."""

    def test_sentinel_present_passes(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff=DETECTOR_DIFF)
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            sentinel = os.path.join(c12_dir, f"c12-smoke-pane-{HEAD_SHA}.pass")
            open(sentinel, "w").close()
            r = _run(d, c12_dir)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("verdict: PASS", r.stdout)
            self.assertIn("c12-pane", r.stdout)
            self.assertNotIn("BLOCK", r.stdout)

    def test_sentinel_wrong_sha_still_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff=DETECTOR_DIFF)
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            # sentinel for a different SHA
            wrong = os.path.join(c12_dir, "c12-smoke-pane-deadbeef1234.pass")
            open(wrong, "w").close()
            r = _run(d, c12_dir)
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn("verdict: BLOCK", r.stdout)


class CliVersionMismatchTests(unittest.TestCase):
    """cli-version-mismatch.txt present -> WARN (verdict becomes WARN, not BLOCK)."""

    def test_mismatch_file_warns(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff="")
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            # Create the mismatch file -- the check looks for INSTALL_DIR/store/cli-version-mismatch.txt
            # INSTALL_DIR is derived from the script location (one dir up from scripts/)
            # We can't easily override INSTALL_DIR, so we create the real path
            real_store = os.path.join(
                os.path.dirname(os.path.dirname(BUNDLE_SCRIPT)), "store"
            )
            mismatch = os.path.join(real_store, "cli-version-mismatch.txt")
            created = False
            try:
                if not os.path.exists(mismatch):
                    with open(mismatch, "w") as f:
                        f.write("mismatch")
                    created = True
                r = _run(d, c12_dir)
                self.assertIn("c12-pane", r.stdout)
                self.assertIn("WARN", r.stdout)
                # WARN should not become BLOCK (no detector change)
                self.assertEqual(r.returncode, 0, r.stderr)
            finally:
                if created and os.path.exists(mismatch):
                    os.remove(mismatch)

    def test_no_mismatch_file_clean(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, pane_state_diff="")
            c12_dir = os.path.join(d, "store")
            os.makedirs(c12_dir)
            real_store = os.path.join(
                os.path.dirname(os.path.dirname(BUNDLE_SCRIPT)), "store"
            )
            mismatch = os.path.join(real_store, "cli-version-mismatch.txt")
            if not os.path.exists(mismatch):
                r = _run(d, c12_dir)
                self.assertNotIn("cli-version-mismatch", r.stdout)
                self.assertIn("verdict: PASS", r.stdout)


if __name__ == "__main__":
    import sys
    if not os.path.exists(BUNDLE_SCRIPT):
        print(f"SKIP: {BUNDLE_SCRIPT} not found")
        sys.exit(0)
    unittest.main(verbosity=2)
