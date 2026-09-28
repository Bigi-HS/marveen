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
        """Critical: the DA advisory must NOT flip the verdict or exit code.
        Differential test: run with sentinel absent vs present; the verdict and
        exit code must be the same in both cases regardless of other advisory
        WARNs (e.g. missing gitleaks binary on worktrees where scripts/bin/ is
        gitignored). Asserting absolute 'PASS' was environment-coupled and broke
        on any runner missing gitleaks."""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d)
            # Absent sentinel run
            da_absent = os.path.join(d, "da-runs-empty")
            os.makedirs(da_absent)
            r_absent = _run_bundle(d, da_absent, [])
            # Present sentinel run (same environment, only da-runs differs)
            da_present = os.path.join(d, "da-runs-present")
            os.makedirs(da_present)
            with open(os.path.join(da_present, "T1-abc123.json"), "w") as f:
                json.dump({"trigger": "T1", "spec": "abc123",
                           "completed_at": 1, "rounds": 1}, f)
            r_present = _run_bundle(d, da_present, [])

            def _verdict_line(r):
                for line in r.stdout.splitlines():
                    if line.strip().startswith("verdict:"):
                        return line.strip()
                return ""

            self.assertEqual(
                r_absent.returncode, r_present.returncode,
                "exit code must not change: absent=%d present=%d\noutput: %s"
                % (r_absent.returncode, r_present.returncode, r_absent.stdout),
            )
            self.assertEqual(
                _verdict_line(r_absent), _verdict_line(r_present),
                "verdict must not flip: absent=%r present=%r"
                % (_verdict_line(r_absent), _verdict_line(r_present)),
            )

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
            # Absent run: verify sentinel status is "warn"
            da_absent = os.path.join(d, "da-runs-empty")
            os.makedirs(da_absent)
            r_absent = _run_bundle(d, da_absent, ["--json"])
            self.assertEqual(r_absent.returncode, 0, r_absent.stderr)
            data_absent = json.loads(r_absent.stdout)
            self.assertIn("da_sentinel", data_absent)
            self.assertEqual(data_absent["da_sentinel"].get("status"), "warn")
            # Present run: same environment, only da-runs differs
            da_present = os.path.join(d, "da-runs-present")
            os.makedirs(da_present)
            with open(os.path.join(da_present, "T1-x.json"), "w") as f:
                json.dump({"trigger": "T1", "spec": "x",
                           "completed_at": 1, "rounds": 1}, f)
            r_present = _run_bundle(d, da_present, ["--json"])
            data_present = json.loads(r_present.stdout)
            # Differential: advisory must NOT flip the structured verdict
            self.assertEqual(
                data_absent.get("verdict"), data_present.get("verdict"),
                "DA advisory must not flip verdict: absent=%r present=%r"
                % (data_absent.get("verdict"), data_present.get("verdict")),
            )

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
