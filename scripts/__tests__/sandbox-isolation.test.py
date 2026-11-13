#!/usr/bin/env python3
"""Tests for sandbox-up/down/isolation-selftest scripts (card 2efcb439).

TDD contract: these tests define the expected behaviour of:
  - scripts/sandbox-up.sh
  - scripts/sandbox-down.sh
  - scripts/sandbox-isolation-selftest.sh

Scope: static self-test only (Invariant 1 -- sandbox-nem-ir-live).
No actual tmux sessions, no live noa.db, no live port 3420 are touched.

Two key assertions (non-vacuous):
  (a) selftest PASSES on a correctly-isolated sandbox fixture layout.
  (b) selftest FAILS when the fixture is rigged to point at a live path --
      proving the test cannot be vacuously green.

Run: python3 scripts/__tests__/sandbox-isolation.test.py
"""
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..")

SANDBOX_UP = os.path.join(SCRIPTS, "sandbox-up.sh")
SANDBOX_DOWN = os.path.join(SCRIPTS, "sandbox-down.sh")
SELFTEST = os.path.join(SCRIPTS, "sandbox-isolation-selftest.sh")


def _write(path: str, content: str, executable: bool = False) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    if executable:
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP)


def _make_sandbox_fixture(d: str, *, violate_isolation: bool = False) -> dict:
    """Create a minimal fixture layout that sandbox-isolation-selftest.sh expects.

    When violate_isolation=True the SANDBOX_DB symlink/path is rigged to resolve
    to the LIVE_DB path, simulating a misconfigured (non-isolated) sandbox.

    Returns a dict of paths and env vars passed to the selftest.
    """
    live_root = os.path.join(d, "live")
    sandbox_root = os.path.join(d, "sandbox_wt")
    os.makedirs(os.path.join(live_root, "store"), exist_ok=True)
    os.makedirs(os.path.join(sandbox_root, "store"), exist_ok=True)

    # Live DB -- sentinel content so we can detect if it was written.
    live_db = os.path.join(live_root, "store", "noa.db")
    _write(live_db, "LIVE-DB-SENTINEL\n")

    # Live dashboard token.
    live_token = os.path.join(live_root, "store", ".dashboard-token")
    _write(live_token, "LIVE-TOKEN-SENTINEL\n")

    # Sandbox DB fixture -- either an isolated copy or rigged to point live.
    sandbox_db = os.path.join(sandbox_root, "store", "noa.db")
    if violate_isolation:
        # Rig: sandbox_db IS the live file (symlink so the inode is shared).
        os.symlink(live_db, sandbox_db)
    else:
        _write(sandbox_db, "SANDBOX-DB-FIXTURE\n")

    # Sandbox stub token (must differ from live).
    sandbox_token = os.path.join(sandbox_root, "store", ".dashboard-token")
    _write(sandbox_token, "SANDBOX-STUB-TOKEN\n")

    # Sandbox stub TELEGRAM_STATE_DIR.
    tg_stub = os.path.join(d, "tg_stub")
    os.makedirs(tg_stub, exist_ok=True)

    return {
        "SANDBOX_ISOLATION_TEST": "1",
        "SANDBOX_LIVE_ROOT": live_root,
        "SANDBOX_WORKTREE": sandbox_root,
        "SANDBOX_DB": sandbox_db,
        "LIVE_DB": live_db,
        "LIVE_PORT": "3420",
        "LIVE_TOKEN": live_token,
        "SANDBOX_TOKEN": sandbox_token,
        "TELEGRAM_STATE_DIR": tg_stub,
    }


def _run_selftest(env_vars: dict) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.update(env_vars)
    return subprocess.run(
        ["bash", SELFTEST],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


class SandboxSelftestSyntaxTests(unittest.TestCase):
    """bash -n (syntax check) for all three shell scripts."""

    def _syntax_ok(self, path: str) -> None:
        r = subprocess.run(["bash", "-n", path], capture_output=True, text=True)
        self.assertEqual(
            r.returncode, 0,
            f"bash -n {os.path.basename(path)} failed:\n{r.stderr}",
        )

    def test_sandbox_up_syntax(self):
        self._syntax_ok(SANDBOX_UP)

    def test_sandbox_down_syntax(self):
        self._syntax_ok(SANDBOX_DOWN)

    def test_sandbox_isolation_selftest_syntax(self):
        self._syntax_ok(SELFTEST)


class SandboxIsolationSelftestTests(unittest.TestCase):
    """Behavioural tests for sandbox-isolation-selftest.sh (Invariant 1)."""

    def test_passes_on_correctly_isolated_fixture(self):
        """(a) selftest PASSES when sandbox DB, port and token are all isolated."""
        with tempfile.TemporaryDirectory() as d:
            env_vars = _make_sandbox_fixture(d, violate_isolation=False)
            r = _run_selftest(env_vars)
            self.assertEqual(
                r.returncode, 0,
                f"selftest must PASS on a correctly-isolated fixture.\n"
                f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}",
            )

    def test_fails_when_sandbox_db_resolves_to_live_path(self):
        """(b) selftest FAILS when sandbox DB resolves to the live noa.db path --
        proving the test is NOT vacuously green (Inv-1 non-vacuous).
        """
        with tempfile.TemporaryDirectory() as d:
            env_vars = _make_sandbox_fixture(d, violate_isolation=True)
            r = _run_selftest(env_vars)
            self.assertNotEqual(
                r.returncode, 0,
                f"selftest must FAIL when sandbox_db resolves to live_db.\n"
                f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}",
            )

    def test_live_db_untouched_after_isolated_selftest(self):
        """The live noa.db must remain byte-identical after a passing selftest run."""
        with tempfile.TemporaryDirectory() as d:
            env_vars = _make_sandbox_fixture(d, violate_isolation=False)
            live_db = env_vars["LIVE_DB"]
            with open(live_db, "rb") as fh:
                before = fh.read()
            r = _run_selftest(env_vars)
            self.assertEqual(r.returncode, 0,
                             f"selftest should pass in this case\n{r.stdout}\n{r.stderr}")
            with open(live_db, "rb") as fh:
                after = fh.read()
            self.assertEqual(before, after,
                             "selftest must NOT write or modify the live noa.db")

    def test_sandbox_does_not_access_live_port(self):
        """The selftest must assert that the sandbox does not bind/use the live port
        (3420). It checks SANDBOX_PORT != LIVE_PORT."""
        with tempfile.TemporaryDirectory() as d:
            env_vars = _make_sandbox_fixture(d, violate_isolation=False)
            # Override SANDBOX_PORT to equal the live port -- selftest must reject.
            env_vars["SANDBOX_PORT"] = "3420"
            r = _run_selftest(env_vars)
            self.assertNotEqual(
                r.returncode, 0,
                "selftest must FAIL when sandbox is configured to use live port 3420",
            )

    def test_credential_stub_differs_from_live(self):
        """The sandbox token must differ from the live token (Inv-9 credential-stub)."""
        with tempfile.TemporaryDirectory() as d:
            env_vars = _make_sandbox_fixture(d, violate_isolation=False)
            # Rig: point sandbox token at the live token -- selftest must reject.
            env_vars["SANDBOX_TOKEN"] = env_vars["LIVE_TOKEN"]
            r = _run_selftest(env_vars)
            self.assertNotEqual(
                r.returncode, 0,
                "selftest must FAIL when sandbox token resolves to the live token",
            )


class SandboxUpSyntaxAndHelpTests(unittest.TestCase):
    """sandbox-up.sh: syntax + --help / --dry-run guard."""

    def test_help_flag_exits_cleanly(self):
        """sandbox-up.sh --help must exit 0 (or non-zero on missing deps) but NOT
        crash with a syntax error."""
        r = subprocess.run(
            ["bash", SANDBOX_UP, "--help"],
            capture_output=True, text=True, timeout=10,
        )
        # We only require it doesn't crash with bash syntax errors (exit 2 from set -e
        # is acceptable if deps are absent in test env; exit 0 or 1 also fine).
        # What we reject is a bash syntax-error exit (bash -n catches that separately).
        self.assertNotIn("syntax error", r.stderr.lower(),
                         f"--help must not produce a syntax error:\n{r.stderr}")

    def test_dry_run_does_not_launch_tmux(self):
        """SANDBOX_DRY_RUN=1 must skip tmux/flock and exit without starting sessions."""
        with tempfile.TemporaryDirectory() as d:
            # Provide a minimal live root so the script can find store/noa.db.
            live_root = d
            os.makedirs(os.path.join(live_root, "store"), exist_ok=True)
            _write(os.path.join(live_root, "store", "noa.db"), "FIXTURE\n")
            # Stub out tmux so it cannot actually create sessions.
            tmux_stub = os.path.join(d, "tmux")
            _write(tmux_stub,
                   "#!/bin/bash\necho '[stub-tmux] blocked in dry-run' >&2\nexit 1\n",
                   executable=True)
            env = dict(os.environ,
                       SANDBOX_DRY_RUN="1",
                       SANDBOX_LIVE_ROOT=live_root,
                       PATH=d + ":" + os.environ.get("PATH", ""))
            r = subprocess.run(
                ["bash", SANDBOX_UP],
                capture_output=True, text=True, env=env, timeout=15,
            )
            # Must not have invoked the tmux stub (which would have written its message).
            self.assertNotIn("[stub-tmux]", r.stderr,
                             "sandbox-up.sh must not call tmux in SANDBOX_DRY_RUN=1 mode")


class SandboxDownIdempotencyTests(unittest.TestCase):
    """sandbox-down.sh: idempotent teardown (safe to run twice on absent sandbox)."""

    def test_down_twice_is_idempotent(self):
        """Running sandbox-down.sh twice must not error on the second invocation."""
        with tempfile.TemporaryDirectory() as d:
            env = dict(os.environ,
                       SANDBOX_WORKTREE=os.path.join(d, "absent_wt"),
                       SANDBOX_SESSION_PREFIX="sb-test-nonexistent")
            for run_num in (1, 2):
                r = subprocess.run(
                    ["bash", SANDBOX_DOWN],
                    capture_output=True, text=True, env=env, timeout=15,
                )
                self.assertEqual(
                    r.returncode, 0,
                    f"sandbox-down.sh run #{run_num} must succeed even if sandbox "
                    f"is already absent.\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}",
                )


class SandboxDownRmrfGuardTests(unittest.TestCase):
    """sandbox-down.sh: the rm -rf fallback must validate its target path first.

    Chad SEC medium on merged #984 (card 7618968d): _remove_worktree falls back to
    `rm -rf "$worktree"` when `git worktree remove` fails, previously with only an
    empty-string check. An empty / '/' / outside-the-sandbox-base path would cause a
    catastrophic delete. The guard `_is_safe_rm_target <path> <base>` must reject any
    path that is empty, '/', or not strictly nested under the sandbox worktree base.

    The predicate is exercised directly (by sourcing the script) so the dangerous
    inputs '/' and '' are tested WITHOUT ever running a real rm -rf on them.
    """

    def _guard(self, path: str, base: str) -> subprocess.CompletedProcess:
        """Source sandbox-down.sh and call _is_safe_rm_target with (path, base).

        Sourcing (not executing) means BASH_SOURCE[0] != $0, so main() does not run;
        only the function definitions load. Returns the completed process; rc 0 means
        the path is accepted as a safe rm -rf target, non-zero means rejected.
        """
        cmd = 'source "$1"; _is_safe_rm_target "$2" "$3"'
        return subprocess.run(
            ["bash", "-c", cmd, "guard", SANDBOX_DOWN, path, base],
            capture_output=True, text=True, timeout=15,
        )

    def test_guard_rejects_empty_path(self):
        r = self._guard("", "/tmp/base/.sandbox-worktrees")
        self.assertNotEqual(r.returncode, 0, "empty path must be rejected")

    def test_guard_rejects_root(self):
        for danger in ("/", "//", "/.", "/.."):
            r = self._guard(danger, "/tmp/base/.sandbox-worktrees")
            self.assertNotEqual(
                r.returncode, 0, f"root-ish path {danger!r} must be rejected")

    def test_guard_rejects_path_outside_base(self):
        base = "/tmp/base/.sandbox-worktrees"
        # The live repo root, a sibling of base, and a prefix-collision sibling.
        for danger in ("/home/domin/marveen", "/tmp/base",
                       "/tmp/base/.sandbox-worktrees-evil/wt-1",
                       "/tmp/other/wt-1"):
            r = self._guard(danger, base)
            self.assertNotEqual(
                r.returncode, 0, f"path outside base {danger!r} must be rejected")

    def test_guard_rejects_base_itself(self):
        base = "/tmp/base/.sandbox-worktrees"
        r = self._guard(base, base)
        self.assertNotEqual(r.returncode, 0, "deleting the base dir itself must be rejected")

    def test_guard_accepts_path_under_base(self):
        """NON-VACUOUS: a legitimate sandbox worktree path IS accepted."""
        base = "/tmp/base/.sandbox-worktrees"
        r = self._guard(base + "/wt-12345", base)
        self.assertEqual(
            r.returncode, 0,
            f"legit sandbox worktree under base must be accepted.\n"
            f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}")

    def test_fallback_refuses_rm_rf_outside_base(self):
        """End-to-end: a worktree path outside the base survives teardown (not deleted)."""
        with tempfile.TemporaryDirectory() as d:
            live_root = os.path.join(d, "live")
            os.makedirs(os.path.join(live_root, "store"), exist_ok=True)
            # Sentinel dir OUTSIDE live_root/store/.sandbox-worktrees.
            victim = os.path.join(d, "victim")
            os.makedirs(victim, exist_ok=True)
            _write(os.path.join(victim, "precious.txt"), "DO-NOT-DELETE\n")
            env = dict(os.environ,
                       SANDBOX_LIVE_ROOT=live_root,
                       SANDBOX_WORKTREE=victim,
                       SANDBOX_SESSION_PREFIX="sb-test-guard")
            r = subprocess.run(
                ["bash", SANDBOX_DOWN],
                capture_output=True, text=True, env=env, timeout=15,
            )
            self.assertEqual(r.returncode, 0, f"teardown must still exit 0 (idempotent).\n{r.stderr}")
            self.assertTrue(
                os.path.isdir(victim) and os.path.isfile(os.path.join(victim, "precious.txt")),
                f"rm -rf fallback must REFUSE a path outside the sandbox base.\n"
                f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}")
            self.assertIn("REFUSING", r.stdout + r.stderr,
                          "teardown must log that it refused the unsafe rm -rf")

    def test_fallback_removes_path_under_base(self):
        """NON-VACUOUS end-to-end: a dir under the base IS cleaned by the rm -rf fallback."""
        with tempfile.TemporaryDirectory() as d:
            live_root = os.path.join(d, "live")
            wt = os.path.join(live_root, "store", ".sandbox-worktrees", "wt-test")
            os.makedirs(wt, exist_ok=True)
            _write(os.path.join(wt, "junk.txt"), "sandbox-junk\n")
            env = dict(os.environ,
                       SANDBOX_LIVE_ROOT=live_root,
                       SANDBOX_WORKTREE=wt,
                       SANDBOX_SESSION_PREFIX="sb-test-guard")
            # git worktree remove will fail (live_root is not a git repo / wt is not a
            # registered worktree), so the guarded rm -rf fallback runs and -- because
            # the path is under the base -- removes it.
            r = subprocess.run(
                ["bash", SANDBOX_DOWN],
                capture_output=True, text=True, env=env, timeout=15,
            )
            self.assertEqual(r.returncode, 0, f"teardown must exit 0.\n{r.stderr}")
            self.assertFalse(
                os.path.exists(wt),
                f"a sandbox worktree under the base must be cleaned by the fallback.\n"
                f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}")


if __name__ == "__main__":
    missing = [p for p in (SANDBOX_UP, SANDBOX_DOWN, SELFTEST) if not os.path.exists(p)]
    if missing:
        print(f"RED (expected -- scripts not yet built): {missing}")
        sys.exit(1)
    unittest.main(verbosity=2)
