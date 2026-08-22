#!/usr/bin/env python3
"""Acceptance tests for the DA T1 sentinel advisory in scripts/pre-gate-bundle.sh

Spec: store/specs/devil-advocate-agent.md -- "Trigger enforcement (M2)".
The bundle emits a WARN (advisory, never BLOCK) when no DA T1 sentinel
(store/da-runs/T1-*.json) exists. This is an "any T1 sentinel present" check:
once any T1 run has completed fleet-wide, the advisory goes quiet.

Critical invariant: the DA advisory NEVER changes the PASS/WARN/BLOCK verdict
or the exit code -- it is informational only (same contract as the cross-model
and skill-regression advisories).

The da-runs directory is overridable via DA_RUNS_DIR so the test is hermetic
(does not depend on the real store/da-runs state).

Run: python3 scripts/__tests__/da-sentinel-check.test.py
"""
import json
import os
import stat
import subprocess
import tempfile
import unittest

BUNDLE_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "pre-gate-bundle.sh"
)


def _make_stub(content: str, path: str):
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/bash\n" + content)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP)


def _make_npx_stub(d: str, tsc_exit: int = 0, vitest_exit: int = 0,
                   vitest_out: str = "Tests 1 passed", tsc_out: str = "") -> None:
    content = f"""case "$1" in
  tsc)    echo "{tsc_out}" >&2; exit {tsc_exit} ;;
  vitest) echo "{vitest_out}"; exit {vitest_exit} ;;
  *)      exec /usr/bin/npx "$@" ;;
esac
"""
    _make_stub(content, os.path.join(d, "npx"))


def _make_git_stub(d: str, additions: int = 10) -> None:
    content = f"""if [[ "$*" == *"--numstat"* ]]; then
  echo "{additions}\t0\tsrc/fake.ts"
elif [[ "$*" == *"diff"* ]] || [[ "$*" == *"grep"* ]]; then
  echo ""
else
  exec /usr/bin/git "$@"
fi
"""
    _make_stub(content, os.path.join(d, "git"))


def _run_bundle(stub_dir: str, da_runs_dir: str, args: list):
    env = dict(os.environ, PATH=stub_dir + ":" + os.environ.get("PATH", ""))
    env["DA_RUNS_DIR"] = da_runs_dir
    return subprocess.run(
        ["bash", BUNDLE_SCRIPT, "develop", "HEAD"] + args,
        capture_output=True, text=True, cwd=stub_dir, env=env,
    )


class DaSentinelAbsentTests(unittest.TestCase):
    """No T1 sentinel -> advisory WARN line, but verdict/exit unaffected."""

    def test_absent_emits_warn_line(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d)
            da_dir = os.path.join(d, "da-runs-empty")
            os.makedirs(da_dir)
            r = _run_bundle(d, da_dir, [])
            self.assertIn("da-trigger", r.stdout)
            self.assertIn("DA T1 not triggered", r.stdout)

    def test_absent_does_not_change_verdict(self):
        """Critical: with all core checks PASS, the DA WARN must NOT flip the
        verdict to WARN -- the advisory is informational only."""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d)
            da_dir = os.path.join(d, "da-runs-empty")
            os.makedirs(da_dir)
            r = _run_bundle(d, da_dir, [])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("verdict: PASS", r.stdout)

    def test_absent_missing_dir_is_safe(self):
        """A non-existent da-runs dir behaves like 'absent', not a crash."""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d)
            da_dir = os.path.join(d, "does-not-exist")
            r = _run_bundle(d, da_dir, [])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("DA T1 not triggered", r.stdout)


class DaSentinelPresentTests(unittest.TestCase):
    """A T1 sentinel present -> no WARN, advisory reports present."""

    def test_present_no_warn(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d)
            da_dir = os.path.join(d, "da-runs")
            os.makedirs(da_dir)
            with open(os.path.join(da_dir, "T1-abc123.json"), "w") as f:
                json.dump({"trigger": "T1", "spec": "abc123",
                           "completed_at": 1, "rounds": 1}, f)
            r = _run_bundle(d, da_dir, [])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn("DA T1 not triggered", r.stdout)
            self.assertIn("da-trigger", r.stdout)


class DaSentinelJsonTests(unittest.TestCase):
    """--json includes the da_sentinel advisory field."""

    def test_json_absent_has_da_sentinel_warn(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, additions=5)
            da_dir = os.path.join(d, "da-runs-empty")
            os.makedirs(da_dir)
            r = _run_bundle(d, da_dir, ["--json"])
            self.assertEqual(r.returncode, 0, r.stderr)
            data = json.loads(r.stdout)
            self.assertIn("da_sentinel", data)
            self.assertEqual(data["da_sentinel"].get("status"), "warn")
            # advisory must not flip the structured verdict either
            self.assertEqual(data.get("verdict"), "PASS")

    def test_json_present_has_da_sentinel_present(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d, additions=5)
            da_dir = os.path.join(d, "da-runs")
            os.makedirs(da_dir)
            with open(os.path.join(da_dir, "T1-x.json"), "w") as f:
                f.write("{}")
            r = _run_bundle(d, da_dir, ["--json"])
            data = json.loads(r.stdout)
            self.assertEqual(data["da_sentinel"].get("status"), "present")


if __name__ == '__main__':
    import sys
    if not os.path.exists(BUNDLE_SCRIPT):
        print(f'SKIP: {BUNDLE_SCRIPT} not found')
        sys.exit(0)
    unittest.main(verbosity=2)
