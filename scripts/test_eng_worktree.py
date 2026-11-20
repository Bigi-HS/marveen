#!/usr/bin/env python3
"""Unit tests for eng_worktree.py (the pure planners + path guards).

Run: python3 scripts/test_eng_worktree.py

Only the pure, side-effect-free logic is tested here (key validation, path /
branch derivation, command planning, the remove-safety guard). The git IO
(_git, run_create, run_remove) is a thin shell over subprocess and is exercised
end-to-end by the author before the gate, mirroring prune_merged_worktrees.py.
"""

import importlib.util
import io
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "eng_worktree", os.path.join(_HERE, "eng_worktree.py")
)
e = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(e)

REPO = "/home/domin/marveen"
WT_BASE = "/home/domin/marveen-wt"


class ValidateKeyTests(unittest.TestCase):
    def test_accepts_typical_ephemeral_key(self):
        e.validate_key("eph-7b44af3a-ackhook-harden")  # no raise

    def test_accepts_alnum_dot_underscore_dash(self):
        for k in ("codetree", "gate_v2", "feat.x", "a1", "x-y_z.0"):
            e.validate_key(k)

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            e.validate_key("")

    def test_rejects_slash(self):
        # key is a single path/branch segment; a slash would escape the wt dir
        with self.assertRaises(ValueError):
            e.validate_key("eng/x")

    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            e.validate_key("..")
        with self.assertRaises(ValueError):
            e.validate_key("a..b")

    def test_rejects_leading_dash(self):
        # would be parsed as a flag by git
        with self.assertRaises(ValueError):
            e.validate_key("-rf")

    def test_rejects_shell_metachars(self):
        for k in ("a;b", "a b", "a$(whoami)", "a`id`", "a|b", "a&b", "a\\b", "a'b"):
            with self.assertRaises(ValueError):
                e.validate_key(k)


class DerivationTests(unittest.TestCase):
    def test_branch_name(self):
        self.assertEqual(e.branch_name("eph-1"), "eng/eph-1")

    def test_worktree_path(self):
        self.assertEqual(e.worktree_path("eph-1", WT_BASE), WT_BASE + "/eph-1")

    def test_base_ref(self):
        self.assertEqual(e.base_ref("develop"), "origin/develop")
        self.assertEqual(e.base_ref("main"), "origin/main")


class CreatePlanTests(unittest.TestCase):
    def plan(self, **kw):
        base = dict(key="eph-1", base="develop", repo=REPO, wt_base=WT_BASE)
        base.update(kw)
        return e.create_plan(**base)

    def test_branch_path_baseref(self):
        p = self.plan()
        self.assertEqual(p["branch"], "eng/eph-1")
        self.assertEqual(p["path"], WT_BASE + "/eph-1")
        self.assertEqual(p["base_ref"], "origin/develop")

    def test_fetch_argv(self):
        p = self.plan()
        self.assertEqual(p["fetch"], ["git", "-C", REPO, "fetch", "origin", "develop"])

    def test_add_argv_pins_to_origin_base_with_capital_B(self):
        # -B resets/creates the branch at origin/develop so a stale local develop
        # is never inherited (git-worktree-manager skill, step 3).
        p = self.plan()
        self.assertEqual(
            p["add"],
            ["git", "-C", REPO, "worktree", "add", "-B", "eng/eph-1",
             WT_BASE + "/eph-1", "origin/develop"],
        )

    def test_symlink_shares_repo_node_modules(self):
        # Legacy single-symlink keys remain for backward compat.
        p = self.plan()
        self.assertEqual(p["symlink_src"], REPO + "/node_modules")
        self.assertEqual(p["symlink_dst"], WT_BASE + "/eph-1/node_modules")

    # --- card e27fb5e6: dual-symlink + base-freshness guard ---

    def test_symlinks_list_has_two_entries(self):
        p = self.plan()
        self.assertEqual(len(p["symlinks"]), 2)

    def test_symlinks_first_entry_is_root_node_modules(self):
        p = self.plan()
        sl = p["symlinks"][0]
        self.assertEqual(sl["src"], REPO + "/node_modules")
        self.assertEqual(sl["dst"], WT_BASE + "/eph-1/node_modules")
        self.assertEqual(sl["label"], "node_modules")

    def test_symlinks_second_entry_is_dashboard_new_node_modules(self):
        # card e27fb5e6: dashboard-new/node_modules must be linked automatically
        # so phantom worktrees don't start without the sub-package deps.
        p = self.plan()
        sl = p["symlinks"][1]
        self.assertEqual(sl["src"], REPO + "/dashboard-new/node_modules")
        self.assertEqual(sl["dst"], WT_BASE + "/eph-1/dashboard-new/node_modules")
        self.assertEqual(sl["label"], "dashboard-new/node_modules")

    def test_symlinks_list_matches_legacy_keys(self):
        # The first symlinks entry must be consistent with the legacy single-key
        # view so callers that still use symlink_src/dst get the same value.
        p = self.plan()
        self.assertEqual(p["symlinks"][0]["src"], p["symlink_src"])
        self.assertEqual(p["symlinks"][0]["dst"], p["symlink_dst"])

    def test_main_base_supported(self):
        p = self.plan(base="main")
        self.assertEqual(p["base_ref"], "origin/main")
        self.assertEqual(p["fetch"], ["git", "-C", REPO, "fetch", "origin", "main"])

    def test_invalid_key_raises(self):
        with self.assertRaises(ValueError):
            self.plan(key="../escape")


class RemovePlanTests(unittest.TestCase):
    def plan(self, **kw):
        base = dict(key="eph-1", repo=REPO, wt_base=WT_BASE, delete_remote=False)
        base.update(kw)
        return e.remove_plan(**base)

    def test_remove_argv_force(self):
        p = self.plan()
        self.assertEqual(
            p["remove"],
            ["git", "-C", REPO, "worktree", "remove", "--force", WT_BASE + "/eph-1"],
        )

    def test_prune_argv(self):
        self.assertEqual(self.plan()["prune"], ["git", "-C", REPO, "worktree", "prune"])

    def test_branch_delete_argv(self):
        self.assertEqual(
            self.plan()["branch_delete"],
            ["git", "-C", REPO, "branch", "-D", "eng/eph-1"],
        )

    def test_no_remote_delete_by_default(self):
        self.assertIsNone(self.plan()["push_delete"])

    def test_remote_delete_when_requested(self):
        self.assertEqual(
            self.plan(delete_remote=True)["push_delete"],
            ["git", "-C", REPO, "push", "origin", "--delete", "eng/eph-1"],
        )

    def test_invalid_key_raises(self):
        with self.assertRaises(ValueError):
            self.plan(key="-rf")


class SafeRemovePathTests(unittest.TestCase):
    def test_wt_base_child_is_safe(self):
        self.assertTrue(e.is_safe_worktree_path(WT_BASE + "/eph-1", REPO, WT_BASE))

    def test_tmp_worktree_is_safe(self):
        self.assertTrue(e.is_safe_worktree_path("/tmp/wt-pr210", REPO, WT_BASE))

    def test_main_checkout_is_never_safe(self):
        self.assertFalse(e.is_safe_worktree_path(REPO, REPO, WT_BASE))

    def test_harness_worktree_is_never_safe(self):
        # .claude/worktrees are harness-managed; never touched by this wrapper
        self.assertFalse(
            e.is_safe_worktree_path(REPO + "/.claude/worktrees/wf_x-1", REPO, WT_BASE))

    def test_arbitrary_path_is_not_safe(self):
        self.assertFalse(e.is_safe_worktree_path("/etc", REPO, WT_BASE))
        self.assertFalse(e.is_safe_worktree_path("/home/domin", REPO, WT_BASE))

    def test_wt_base_itself_is_not_safe(self):
        # removing the container dir is not a worktree op
        self.assertFalse(e.is_safe_worktree_path(WT_BASE, REPO, WT_BASE))

    def test_traversal_into_main_checkout_is_not_safe(self):
        # `..` must not let a wt_base-rooted path escape into the main checkout
        self.assertFalse(
            e.is_safe_worktree_path(WT_BASE + "/../marveen", REPO, WT_BASE))

    def test_sibling_prefix_dir_is_not_safe(self):
        # a sibling whose name merely starts with wt_base is NOT under wt_base
        # (the guard must match on the os.sep boundary, not a raw string prefix)
        self.assertFalse(
            e.is_safe_worktree_path(WT_BASE + ".extra/eph-1", REPO, WT_BASE))

    def test_symlink_under_wt_base_pointing_at_main_repo_is_not_safe(self):
        # Chad PR#216 INFO[low]: a wt_base/<key> symlink that targets the main
        # checkout must NOT pass the guard -- the destructive remove has to see
        # the REAL target, so the guard resolves symlinks (realpath), not just
        # normpath (which leaves a symlink unresolved).
        with tempfile.TemporaryDirectory() as tmp:
            repo = os.path.join(tmp, "marveen")
            wt_base = os.path.join(tmp, "marveen-wt")
            os.makedirs(repo)
            os.makedirs(wt_base)
            evil = os.path.join(wt_base, "evil")
            os.symlink(repo, evil)  # wt_base/evil -> the main checkout
            self.assertFalse(e.is_safe_worktree_path(evil, repo, wt_base))
            # control: a real (non-symlinked) child of wt_base is still safe
            real_child = os.path.join(wt_base, "eph-real")
            os.makedirs(real_child)
            self.assertTrue(e.is_safe_worktree_path(real_child, repo, wt_base))


class BaseFreshnessGuardTests(unittest.TestCase):
    """card e27fb5e6: stale-base is now a hard FAIL, not a WARN.

    The dangerous path: a worktree whose HEAD diverges from origin/<base>
    produces phantom PRs that are rebased on stale commits -> dirty re-heads
    and churn at the gate.  The guard must refuse and tear down the worktree
    rather than merely printing a warning.
    """

    def _make_args(self, key="eph-test", base="develop",
                   repo=REPO, wt_base=WT_BASE):
        args = types.SimpleNamespace(
            key=key, base=base, repo=repo, wt_base=wt_base,
        )
        return args

    def _run_create_with_mocked_git(self, fetch_rc=0, add_rc=0,
                                    head_sha="aabbcc", want_sha="aabbcc"):
        """Run run_create with subprocess patched so no real git is invoked."""
        call_log = []

        def fake_run(argv):
            call_log.append(argv)
            result = MagicMock()
            result.returncode = 0
            result.stdout = ""
            result.stderr = ""
            if argv[3] == "fetch":
                result.returncode = fetch_rc
            elif argv[3] == "worktree" and argv[4] == "add":
                result.returncode = add_rc
            elif argv[3] == "rev-parse":
                # First rev-parse (want = origin/develop), second (head).
                # Caller decides which sha to return by counting calls.
                rp_calls = sum(1 for a in call_log if a[3] == "rev-parse")
                if rp_calls == 1:
                    result.stdout = want_sha + "\n"
                else:
                    result.stdout = head_sha + "\n"
            # worktree remove / prune for cleanup -> rc=0
            return result

        args = self._make_args()
        # Suppress stdout/stderr during the test run.
        with patch.object(e, "_run", side_effect=fake_run), \
             patch.object(e, "_symlink_force", return_value=True):
            stderr_capture = io.StringIO()
            stdout_capture = io.StringIO()
            with patch("sys.stderr", stderr_capture), \
                 patch("sys.stdout", stdout_capture):
                rc = e.run_create(args)
        return rc, call_log, stdout_capture.getvalue(), stderr_capture.getvalue()

    def test_matching_shas_succeed(self):
        rc, _, stdout, _ = self._run_create_with_mocked_git(
            head_sha="deadbeef1234", want_sha="deadbeef1234"
        )
        self.assertEqual(rc, 0)
        self.assertIn("created", stdout)

    def test_mismatched_shas_fail_hard(self):
        # DANGEROUS path: HEAD diverges from origin/develop.
        # Must return non-zero (hard fail), NOT zero with a warning.
        rc, call_log, _, stderr = self._run_create_with_mocked_git(
            head_sha="111111aaaa", want_sha="222222bbbb"
        )
        self.assertNotEqual(rc, 0, "stale base must be a hard FAIL, not a WARN")
        self.assertIn("FAIL", stderr)
        self.assertIn("stale base", stderr)

    def test_mismatched_shas_triggers_cleanup(self):
        # After a hard fail the worktree must be torn down (worktree remove + prune).
        rc, call_log, _, _ = self._run_create_with_mocked_git(
            head_sha="111111aaaa", want_sha="222222bbbb"
        )
        self.assertNotEqual(rc, 0)
        cleanup_cmds = [a for a in call_log if a[3] == "worktree" and a[4] == "remove"]
        self.assertTrue(len(cleanup_cmds) >= 1,
                        "worktree remove must be called on stale-base hard fail")

    def test_unresolvable_base_ref_fails_before_add(self):
        # If want_sha is empty (remote unreachable), must fail before worktree add.
        rc, call_log, _, stderr = self._run_create_with_mocked_git(
            want_sha="",    # simulate unresolvable ref
            head_sha="",
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("FAIL", stderr)
        add_calls = [a for a in call_log if a[3] == "worktree" and a[4] == "add"]
        self.assertEqual(len(add_calls), 0,
                         "worktree add must NOT run when base ref is unresolvable")


class DualSymlinkFunctionalTests(unittest.TestCase):
    """card e27fb5e6: both node_modules symlinks are created by run_create."""

    def test_both_symlinks_created_on_success(self):
        """run_create must call _symlink_force for each entry in plan['symlinks']."""
        created = []

        def fake_run(argv):
            result = MagicMock()
            result.returncode = 0
            sha = "deadbeef1234"
            result.stdout = sha + "\n"
            result.stderr = ""
            return result

        def fake_symlink_force(src, dst):
            created.append((src, dst))
            return True

        args = types.SimpleNamespace(
            key="eph-dual", base="develop", repo=REPO, wt_base=WT_BASE
        )
        with patch.object(e, "_run", side_effect=fake_run), \
             patch.object(e, "_symlink_force", side_effect=fake_symlink_force):
            stderr_buf = io.StringIO()
            stdout_buf = io.StringIO()
            with patch("sys.stderr", stderr_buf), patch("sys.stdout", stdout_buf):
                rc = e.run_create(args)

        self.assertEqual(rc, 0)
        self.assertEqual(len(created), 2, "both symlinks must be created")
        srcs = [c[0] for c in created]
        self.assertIn(REPO + "/node_modules", srcs)
        self.assertIn(REPO + "/dashboard-new/node_modules", srcs)


if __name__ == "__main__":
    unittest.main(verbosity=2)
