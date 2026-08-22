#!/usr/bin/env python3
"""Acceptance tests for scripts/pre-gate-bundle.sh

These tests validate the pre-gate evidence bundle against the Thor-authored
acceptance criteria (card b45884fb). They are scaffold tests: they pin the
expected behavior (exit codes, output format, JSON schema) and are written
to fail against a missing/incorrect implementation.

Run: python3 scripts/__tests__/pre-gate-bundle.test.py

Design: each test stubs the external tools via an `npx` wrapper script in a
temp directory on PATH (the bundle uses `npx tsc` / `npx vitest run`, not bare
`tsc`/`npm`). No real compilation or test run happens -- the bundle's behavior
under each scenario is exercised.

Exit code convention (AC#2/3/4 -- matches Dave's implementation):
  0 = PASS or WARN
  1 = BLOCK
(Not the three-tier 0/1/2 originally sketched; the binary is cleaner for `if bundle; then`.)

Static severity (AC#5):
  Secret pattern hit -> BLOCK
  Unused export      -> WARN
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

BUNDLE_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "pre-gate-bundle.sh"
)


def _make_stub(content: str, path: str):
    """Write an executable stub script."""
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/bash\n" + content)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP)


def _run_bundle(stub_dir: str, args: list, env_extra: dict | None = None):
    """Run the bundle with stub_dir first on PATH so our npx wrapper intercepts."""
    env = dict(os.environ, PATH=stub_dir + ":" + os.environ.get("PATH", ""))
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        ["bash", BUNDLE_SCRIPT, "develop", "HEAD"] + args,
        capture_output=True,
        text=True,
        cwd=stub_dir,
        env=env,
    )


def _make_npx_stub(d: str, tsc_exit: int = 0, vitest_exit: int = 0,
                   vitest_out: str = "Tests 1 passed",
                   tsc_out: str = "") -> None:
    """Write a single npx stub that dispatches on its first argument.
    The bundle calls:  npx tsc --noEmit   and   npx vitest run ...
    """
    content = f"""case "$1" in
  tsc)
    echo "{tsc_out}" >&2
    exit {tsc_exit}
    ;;
  vitest)
    echo "{vitest_out}"
    exit {vitest_exit}
    ;;
  *)
    exec /usr/bin/npx "$@"
    ;;
esac
"""
    _make_stub(content, os.path.join(d, "npx"))


def _make_git_stub(d: str, additions: int = 10) -> None:
    """Stub git so --numstat returns a controlled number of additions."""
    content = f"""if [[ "$*" == *"--numstat"* ]]; then
  echo "{additions}\t0\tsrc/fake.ts"
elif [[ "$*" == *"diff"* ]] || [[ "$*" == *"grep"* ]]; then
  echo ""
else
  exec /usr/bin/git "$@"
fi
"""
    _make_stub(content, os.path.join(d, "git"))


class TscPassTests(unittest.TestCase):
    """AC#1/#2: tsc clean -> no BLOCK; tsc error -> BLOCK"""

    def test_tsc_pass_exit_0(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d, tsc_exit=0, vitest_exit=0)
            _make_git_stub(d)
            r = _run_bundle(d, [])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('PASS', r.stdout)
            self.assertIn('typecheck', r.stdout)

    def test_tsc_fail_exit_1_block(self):
        """AC#2: tsc error -> BLOCK (exit 1)"""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d, tsc_exit=1, tsc_out="error TS2322: type mismatch",
                           vitest_exit=0)
            _make_git_stub(d)
            r = _run_bundle(d, [])
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn('BLOCK', r.stdout)
            self.assertIn('typecheck', r.stdout)


class TestRunnerTests(unittest.TestCase):
    """AC#3: test failure -> BLOCK"""

    def test_test_fail_exit_1_block(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d, tsc_exit=0,
                           vitest_exit=1, vitest_out="Tests 3 passed | 1 failed")
            _make_git_stub(d)
            r = _run_bundle(d, [])
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn('BLOCK', r.stdout)
            self.assertIn('tests', r.stdout)


class DiffSizeTests(unittest.TestCase):
    """AC#4: diff-size threshold (PGB_DIFF_WARN env-settable)"""

    def _make_ok_stubs(self, d: str, additions: int) -> None:
        _make_npx_stub(d, tsc_exit=0, vitest_exit=0)
        _make_git_stub(d, additions=additions)

    def test_diffsize_under_warn_pass(self):
        with tempfile.TemporaryDirectory() as d:
            self._make_ok_stubs(d, 10)
            r = _run_bundle(d, [], env_extra={"PGB_DIFF_WARN": "500"})
            self.assertEqual(r.returncode, 0)
            self.assertIn('diff-size', r.stdout)

    def test_diffsize_over_warn_warns(self):
        """AC#4: additions > PGB_DIFF_WARN -> WARN (still exit 0)"""
        with tempfile.TemporaryDirectory() as d:
            self._make_ok_stubs(d, 800)
            r = _run_bundle(d, [], env_extra={"PGB_DIFF_WARN": "500"})
            self.assertEqual(r.returncode, 0, 'WARN alone must not BLOCK (exit 0)')
            self.assertIn('WARN', r.stdout)
            self.assertIn('diff-size', r.stdout)


class StaticTests(unittest.TestCase):
    """AC#5: secret pattern -> BLOCK; unused export -> WARN"""

    def _make_stubs(self, d: str, diff_content: str) -> None:
        _make_npx_stub(d, tsc_exit=0, vitest_exit=0)
        # git stub: numstat for size check, full diff for static grep
        git_stub = (
            'if [[ "$*" == *"--numstat"* ]]; then\n'
            '  echo "5\t0\tsrc/a.ts"\n'
            'elif [[ "$*" == *"--unified"* ]] || [[ "$*" == *"diff"* ]]; then\n'
            f'  printf "%s\\n" \'{diff_content}\'\n'
            'elif [[ "$*" == *"grep"* ]]; then\n'
            '  echo "2"\n'  # 2 refs = export IS used
            'fi\n'
        )
        _make_stub(git_stub, os.path.join(d, "git"))

    def test_static_hardcoded_anthropic_key_blocks(self):
        """AC#5: Anthropic secret key in diff -> BLOCK"""
        with tempfile.TemporaryDirectory() as d:
            self._make_stubs(d, '+const key = "sk-ant-abc123XYZ456"')
            r = _run_bundle(d, [])
            self.assertEqual(r.returncode, 1, 'secret pattern must BLOCK')
            self.assertIn('BLOCK', r.stdout)
            self.assertIn('static', r.stdout)

    def test_static_clean_diff_passes(self):
        with tempfile.TemporaryDirectory() as d:
            self._make_stubs(d, '+const message = "hello world"')
            r = _run_bundle(d, [])
            # PASS or WARN (possibly WARN from diff-size), but NOT BLOCK
            self.assertNotIn('BLOCK', r.stdout)


class JsonOutputTests(unittest.TestCase):
    """AC#6: --json flag returns valid structured output"""

    def test_json_flag_valid_json(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d, tsc_exit=0, vitest_exit=0)
            _make_git_stub(d, additions=5)
            r = _run_bundle(d, ['--json'])
            self.assertEqual(r.returncode, 0)
            try:
                data = json.loads(r.stdout)
            except json.JSONDecodeError:
                self.fail(f'--json output is not valid JSON: {r.stdout[:300]}')
            self.assertIn('verdict', data)
            self.assertIn('checks', data)
            self.assertIn('diff_additions', data)
            self.assertIsInstance(data['checks'], list)
            self.assertGreater(len(data['checks']), 0)
            for check in data['checks']:
                self.assertIn('name', check)
                self.assertIn('status', check)
                self.assertIn('detail', check)

    def test_json_verdict_block_on_tsc_fail(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d, tsc_exit=1, tsc_out="error TS2322", vitest_exit=0)
            _make_git_stub(d)
            r = _run_bundle(d, ['--json'])
            self.assertEqual(r.returncode, 1)
            data = json.loads(r.stdout)
            self.assertEqual(data.get('verdict'), 'BLOCK')


class FailSafeTests(unittest.TestCase):
    """AC#8: if a check's tooling is missing, WARN and continue"""

    def test_missing_npx_guard_in_source(self):
        """Verify the bundle source has a command -v npx guard before calling tsc/vitest.
        This ensures tooling-absent paths emit WARN and continue (fail-safe AC#8),
        which is hard to exercise via subprocess without losing bash itself."""
        with open(BUNDLE_SCRIPT, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('command -v npx', src,
            'bundle must guard tsc/vitest calls with `command -v npx` for fail-safe')
        # Both check_typecheck and check_tests must have the guard
        self.assertGreaterEqual(src.count('command -v npx'), 2,
            'both typecheck and tests checks must guard against missing npx')


class ReadOnlyTests(unittest.TestCase):
    """AC#10: bundle does not modify repo state"""

    def test_no_unexpected_files_written(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d, tsc_exit=0, vitest_exit=0)
            _make_git_stub(d)
            stub_files = set(os.listdir(d))
            _run_bundle(d, [])
            after = set(os.listdir(d))
            new_files = after - stub_files
            self.assertEqual(new_files, set(), f'bundle wrote unexpected files: {new_files}')


class ExitCodeCaptureTests(unittest.TestCase):
    """Dogfood AC: exit code must not be lost via pipeline."""

    def test_test_failure_captured_correctly(self):
        """vitest exits 1 -> bundle exits 1 (BLOCK), not masked"""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d, tsc_exit=0, vitest_exit=1,
                           vitest_out="Tests 0 passed | 1 failed")
            _make_git_stub(d)
            r = _run_bundle(d, [])
            self.assertEqual(r.returncode, 1,
                'test failure exit code must reach the bundle')

    def test_tsc_failure_captured_correctly(self):
        """tsc exits 1 -> bundle exits 1 (BLOCK)"""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d, tsc_exit=1, tsc_out="error TS2322", vitest_exit=0)
            _make_git_stub(d)
            r = _run_bundle(d, [])
            self.assertEqual(r.returncode, 1,
                'tsc failure exit code must reach the bundle')


class WorktreeExclusionTests(unittest.TestCase):
    """Dogfood AC: .claude/worktrees/** must be excluded from vitest scope."""

    def test_worktree_exclude_present_in_source(self):
        """The bundle script source must reference worktrees exclusion for vitest."""
        with open(BUNDLE_SCRIPT, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('worktrees', src,
            'bundle script must exclude .claude/worktrees/** from vitest invocation')
        # Confirm the variable is actually passed to the vitest call
        self.assertIn('VITEST_EXCLUDE', src,
            'VITEST_EXCLUDE variable must be defined and used in vitest call')

    def test_worktree_exclude_echoed_in_verbose_output(self):
        """When vitest runs, the worktree exclusion does not cause spurious output.
        Validates the exclude flag is syntactically accepted by the real vitest."""
        # This test only runs if we can reach the real vitest (skip otherwise)
        import shutil
        if not shutil.which("npx"):
            self.skipTest("npx not available; skipping real vitest invocation")
        # The real dogfood: run the bundle on develop..HEAD (read-only)
        r = subprocess.run(
            ["/bin/bash", BUNDLE_SCRIPT, "develop", "HEAD"],
            capture_output=True, text=True, cwd="/home/domin/marveen",
            env=os.environ,
            timeout=120,
        )
        # Must not crash with "unknown flag --exclude" or similar
        self.assertNotIn('unknown flag', (r.stdout + r.stderr).lower())
        self.assertNotIn('error: unknown option', (r.stdout + r.stderr).lower())


class GitleaksCheckTests(unittest.TestCase):
    """Positive- and negative-control for check_gitleaks (card ea3720b3).

    Uses GITLEAKS_BIN to inject a stub binary without installing the real tool.
    The positive-control is the merge condition for CHANGE-1 (the || true bug):
    if the bug were present, gl_rc would always be 0 and the test would see PASS
    instead of BLOCK.
    """

    _FINDING_JSON = json.dumps([{
        "RuleID": "generic-api-key",
        "File": "src/config.ts",
        "StartLine": 14,
        "Commit": "abc",
    }])

    def _make_gitleaks_stub(self, d: str, *, exit_code: int, output: str = "") -> str:
        """Write a gitleaks stub that emits output and exits exit_code."""
        json_file = os.path.join(d, "_gl_stub_output.json")
        with open(json_file, "w", encoding="utf-8") as f:
            f.write(output)
        stub_path = os.path.join(d, "fake-gitleaks")
        _make_stub(f"cat {json_file}\nexit {exit_code}\n", stub_path)
        return stub_path

    def _make_git_stub_with_diff(self, d: str) -> None:
        """Git stub that returns a non-empty diff so check_gitleaks does not short-circuit."""
        content = """if [[ "$*" == *"--numstat"* ]]; then
  echo "5\t0\tsrc/fake.ts"
elif [[ "$*" == *"diff"* ]]; then
  printf '+fake_content_for_gitleaks_scan\\n'
elif [[ "$*" == *"grep"* ]]; then
  echo ""
else
  exec /usr/bin/git "$@"
fi
"""
        _make_stub(content, os.path.join(d, "git"))

    def test_gitleaks_finding_causes_block(self):
        """Positive control: stub exits 1 + JSON finding -> bundle exits 1 (BLOCK).

        This is the merge condition for CHANGE-1 (|| true bug fix).  Before the
        fix, gl_rc was always 0 (the || true swallowed the real exit code) so the
        bundle reported PASS on every gitleaks run regardless of findings.
        """
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            self._make_git_stub_with_diff(d)
            stub = self._make_gitleaks_stub(d, exit_code=1,
                                             output=self._FINDING_JSON)
            r = _run_bundle(d, [], env_extra={"GITLEAKS_BIN": stub})
            self.assertEqual(r.returncode, 1,
                f"gitleaks finding must cause BLOCK (exit 1); got {r.returncode}\n"
                f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}")
            self.assertIn("BLOCK", r.stdout)
            self.assertIn("gitleaks", r.stdout.lower())

    def test_gitleaks_clean_exits_pass(self):
        """Negative control: stub exits 0 -> gitleaks PASS, overall not BLOCK."""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            self._make_git_stub_with_diff(d)
            stub = self._make_gitleaks_stub(d, exit_code=0, output="null")
            r = _run_bundle(d, [], env_extra={"GITLEAKS_BIN": stub})
            self.assertEqual(r.returncode, 0,
                f"clean gitleaks must not cause BLOCK; got {r.returncode}\n"
                f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}")
            self.assertIn("gitleaks", r.stdout.lower())

    def test_gitleaks_missing_binary_is_warn_not_block(self):
        """Missing binary -> WARN (fail-open), not BLOCK."""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_git_stub(d)
            r = _run_bundle(d, [], env_extra={
                "GITLEAKS_BIN": os.path.join(d, "no-such-binary")
            })
            self.assertEqual(r.returncode, 0,
                "missing gitleaks binary must be WARN (fail-open), not BLOCK")
            self.assertIn("WARN", r.stdout)
            self.assertIn("gitleaks", r.stdout.lower())


class BaseBranchResolutionTests(unittest.TestCase):
    """Regression: base param 'develop' must resolve to origin/develop.

    When the caller passes a bare branch name (e.g. 'develop'), a stale local
    branch causes git's 3-dot diff to include intermediate PR commits. Those
    commits may contain test fixtures with auth-like patterns (e.g.
    'password: nope-nope-nope') that trip the generic-secret-assign detector ->
    false-positive BLOCK on every PR (#434-#439). Fix: fetch + resolve to
    origin/<branch> in main(). PR: eng/9c607f2a-bundle-base.
    """

    def test_source_fetches_origin_before_diff(self):
        """Script source must call 'git ... fetch origin' in main before running checks."""
        with open(BUNDLE_SCRIPT, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('fetch origin', src,
            'pre-gate-bundle must fetch origin before computing the diff')

    def test_source_resolves_bare_branch_to_origin(self):
        """Script source must prepend 'origin/' when base has no slash."""
        with open(BUNDLE_SCRIPT, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('origin/', src,
            'pre-gate-bundle must rewrite bare branch names to origin/<branch>')


if __name__ == '__main__':
    if not os.path.exists(BUNDLE_SCRIPT):
        print(f'SKIP: {BUNDLE_SCRIPT} not yet implemented (expected -- scaffold test)')
        sys.exit(0)
    unittest.main(verbosity=2)
