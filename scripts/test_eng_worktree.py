#!/usr/bin/env python3
"""Unit tests for eng_worktree.py (the pure planners + path guards).

Run: python3 scripts/test_eng_worktree.py

Only the pure, side-effect-free logic is tested here (key validation, path /
branch derivation, command planning, the remove-safety guard). The git IO
(_git, run_create, run_remove) is a thin shell over subprocess and is exercised
end-to-end by the author before the gate, mirroring prune_merged_worktrees.py.
"""

import importlib.util
import os
import tempfile
import unittest

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
        p = self.plan()
        self.assertEqual(p["symlink_src"], REPO + "/node_modules")
        self.assertEqual(p["symlink_dst"], WT_BASE + "/eph-1/node_modules")

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
