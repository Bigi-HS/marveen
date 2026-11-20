#!/usr/bin/env python3
"""Unit tests for prune_merged_worktrees.py (the pure classifier, parser, owner-infer).

Cards: 678c1e82 (original), 42192e2c (owner-check + 0-diff + git-cherry hardening).

Run: python3 scripts/test_prune_merged_worktrees.py
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "prune_merged_worktrees", os.path.join(_HERE, "prune_merged_worktrees.py")
)
p = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(p)

MAIN = "/home/domin/marveen"
PRIV = "/home/domin/marveen-wt-privacy"
HARNESS = "/home/domin/marveen/.claude/worktrees"


def classify(**kw):
    """Call classify_worktree with safe defaults for unspecified fields."""
    base = dict(
        path="/home/domin/marveen-wt/x", branch="feat/x", detached=False,
        is_ancestor=True, dirty=False, has_unpushed=False, owner_session_alive=False,
        main_path=MAIN, exclude_paths={PRIV}, harness_dir=HARNESS,
    )
    base.update(kw)
    return p.classify_worktree(**base)


class ClassifyTests(unittest.TestCase):
    # --- hard-exclude guards (unchanged from card 678c1e82) ---

    def test_main_checkout_kept(self):
        a, r = classify(path=MAIN, branch="feat/b737d67b", is_ancestor=True)
        self.assertEqual(a, "keep")
        self.assertIn("main", r)

    def test_excluded_path_kept_even_if_merged(self):
        a, r = classify(path=PRIV, is_ancestor=True)
        self.assertEqual(a, "keep")
        self.assertIn("exclud", r.lower())

    def test_harness_worktree_kept(self):
        a, r = classify(path=HARNESS + "/agent-abc123", is_ancestor=True)
        self.assertEqual(a, "keep")
        self.assertIn("harness", r.lower())

    def test_harness_dir_itself_kept(self):
        a, _ = classify(path=HARNESS, is_ancestor=True)
        self.assertEqual(a, "keep")

    def test_dirty_kept_even_if_merged(self):
        a, r = classify(dirty=True, is_ancestor=True)
        self.assertEqual(a, "keep")
        self.assertIn("uncommitted", r.lower())

    # --- owner-check (card 42192e2c) ---

    def test_owner_session_alive_keeps_merged_worktree(self):
        # Even if merged, skip if the owning agent session is alive.
        a, r = classify(is_ancestor=True, owner_session_alive=True)
        self.assertEqual(a, "keep")
        self.assertIn("owner session", r.lower())

    def test_owner_session_alive_keeps_0diff_worktree(self):
        # Even if 0-diff eligible, skip if owner session is alive.
        a, r = classify(is_ancestor=False, has_unpushed=False, owner_session_alive=True)
        self.assertEqual(a, "keep")
        self.assertIn("owner session", r.lower())

    def test_owner_session_dead_allows_prune_if_merged(self):
        # Owner session not alive + merged -> prune.
        a, r = classify(is_ancestor=True, owner_session_alive=False)
        self.assertEqual(a, "prune")
        self.assertIn("merged", r.lower())

    def test_dirty_beats_owner_session_check(self):
        # dirty check fires before owner check; keep even if session is dead.
        a, r = classify(dirty=True, is_ancestor=True, owner_session_alive=False)
        self.assertEqual(a, "keep")
        self.assertIn("uncommitted", r.lower())

    def test_exclude_beats_owner_session_alive(self):
        # hard-exclude overrides owner-session alive signal.
        a, _ = classify(path=PRIV, is_ancestor=True, owner_session_alive=True)
        self.assertEqual(a, "keep")

    # --- 0-diff path (card 42192e2c) ---

    def test_zero_diff_squash_merged_pruned(self):
        # Branch is not an ancestor (squash-merged) but clean + no unpushed.
        a, r = classify(is_ancestor=False, dirty=False, has_unpushed=False)
        self.assertEqual(a, "prune")
        self.assertIn("0-diff", r.lower())

    def test_unmerged_with_unpushed_kept(self):
        # Not an ancestor AND has unpushed commits -> must keep.
        a, r = classify(is_ancestor=False, dirty=False, has_unpushed=True)
        self.assertEqual(a, "keep")
        self.assertIn("not merged", r.lower())

    def test_dirty_unmerged_with_unpushed_kept(self):
        # dirty + unmerged + unpushed -> keep (dirty guard fires first).
        a, r = classify(is_ancestor=False, dirty=True, has_unpushed=True)
        self.assertEqual(a, "keep")
        self.assertIn("uncommitted", r.lower())

    # --- merged path (unchanged) ---

    def test_merged_branch_pruned(self):
        a, r = classify(is_ancestor=True)
        self.assertEqual(a, "prune")
        self.assertIn("merged", r.lower())

    def test_merged_detached_pruned(self):
        a, r = classify(branch=None, detached=True, is_ancestor=True)
        self.assertEqual(a, "prune")

    def test_unmerged_detached_with_unpushed_kept(self):
        # detached + not merged + has_unpushed=True -> keep.
        a, r = classify(branch=None, detached=True, is_ancestor=False, has_unpushed=True)
        self.assertEqual(a, "keep")

    def test_unmerged_detached_zero_diff_pruned(self):
        # detached + not merged + 0-diff -> prune (squash-safe path).
        # Note: has_unpushed_commits() returns True for detached HEAD in live code
        # (conservative), so this tests the pure classifier path only.
        a, r = classify(branch=None, detached=True, is_ancestor=False, has_unpushed=False)
        self.assertEqual(a, "prune")

    def test_exclude_precedence_over_dirty_and_merge(self):
        a, _ = classify(path=PRIV, dirty=False, is_ancestor=True)
        self.assertEqual(a, "keep")

    def test_dirty_precedence_over_merged(self):
        a, r = classify(is_ancestor=True, dirty=True)
        self.assertEqual(a, "keep")


class InferOwnerTests(unittest.TestCase):
    """Tests for the worktree path -> agent session mapping (card 42192e2c)."""

    OM = p.OWNER_SESSION_MAP

    def test_dave_wt_prefix(self):
        self.assertEqual(p.infer_owner("/home/domin/dave-wt-sec099", self.OM), "agent-dave")

    def test_dave_wt_subdir(self):
        self.assertEqual(p.infer_owner("/home/domin/dave-wt-w1-pr1", self.OM), "agent-dave")

    def test_marveen_wt_subdir(self):
        self.assertEqual(p.infer_owner("/home/domin/marveen-wt/089e78db", self.OM), "marveen")

    def test_marveen_wt_dash_prefix(self):
        self.assertEqual(p.infer_owner("/home/domin/marveen-wt-32abc69e", self.OM), "marveen")

    def test_marveen_internal_worktrees(self):
        self.assertEqual(
            p.infer_owner("/home/domin/marveen/.worktrees/card-abc123", self.OM), "marveen"
        )

    def test_tmp_path_no_owner(self):
        self.assertIsNone(p.infer_owner("/tmp/wt-pr1234", self.OM))

    def test_unknown_path_no_owner(self):
        self.assertIsNone(p.infer_owner("/home/domin/someother-wt/abc", self.OM))

    def test_marveen_wt_privacy_not_confused_with_marveen_wt(self):
        # marveen-wt-privacy must also map to marveen (starts with marveen-wt-).
        # (It is separately hard-excluded, but the owner inference is independent.)
        self.assertEqual(
            p.infer_owner("/home/domin/marveen-wt-privacy", self.OM), "marveen"
        )

    def test_exact_prefix_not_match_unrelated_sibling(self):
        # A path that starts with a prefix but is a different dir entirely.
        self.assertIsNone(p.infer_owner("/home/domin/dave-workspace/foo", self.OM))


class PorcelainParseTests(unittest.TestCase):
    SAMPLE = (
        "worktree /home/domin/marveen\n"
        "HEAD 4967661eac0000000000000000000000000000aa\n"
        "branch refs/heads/feat/b737d67b-gap-coverage\n"
        "\n"
        "worktree /home/domin/marveen-wt/cost-lineage\n"
        "HEAD a3607292f40000000000000000000000000000bb\n"
        "branch refs/heads/feat/cost-lineage-rollup\n"
        "\n"
        "worktree /home/domin/marveen-wt/deploy-live\n"
        "HEAD 54d612f9140000000000000000000000000000cc\n"
        "detached\n"
        "\n"
    )

    def test_parses_branch_and_detached(self):
        wts = p.parse_worktrees(self.SAMPLE)
        self.assertEqual(len(wts), 3)
        self.assertEqual(wts[0]["path"], "/home/domin/marveen")
        self.assertEqual(wts[0]["branch"], "feat/b737d67b-gap-coverage")
        self.assertFalse(wts[0]["detached"])
        self.assertEqual(wts[1]["branch"], "feat/cost-lineage-rollup")
        self.assertIsNone(wts[2]["branch"])
        self.assertTrue(wts[2]["detached"])
        self.assertTrue(wts[2]["head"].startswith("54d612f914"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
