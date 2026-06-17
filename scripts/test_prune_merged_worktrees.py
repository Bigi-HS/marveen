#!/usr/bin/env python3
"""Unit tests for prune_merged_worktrees.py (the pure classifier + parser).

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
    base = dict(
        path="/home/domin/marveen-wt/x", branch="feat/x", detached=False,
        is_ancestor=True, dirty=False,
        main_path=MAIN, exclude_paths={PRIV}, harness_dir=HARNESS,
    )
    base.update(kw)
    return p.classify_worktree(**base)


class ClassifyTests(unittest.TestCase):
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

    def test_unmerged_branch_kept(self):
        a, r = classify(is_ancestor=False)
        self.assertEqual(a, "keep")
        self.assertIn("not merged", r.lower())

    def test_merged_branch_pruned(self):
        a, r = classify(is_ancestor=True)
        self.assertEqual(a, "prune")
        self.assertIn("merged", r.lower())

    def test_merged_detached_pruned(self):
        a, r = classify(branch=None, detached=True, is_ancestor=True)
        self.assertEqual(a, "prune")

    def test_unmerged_detached_kept(self):
        a, r = classify(branch=None, detached=True, is_ancestor=False)
        self.assertEqual(a, "keep")

    def test_exclude_precedence_over_dirty_and_merge(self):
        # excluded path wins regardless of other signals
        a, _ = classify(path=PRIV, dirty=False, is_ancestor=True)
        self.assertEqual(a, "keep")

    def test_dirty_precedence_over_merged(self):
        # a merged branch with local edits is still protected
        a, r = classify(is_ancestor=True, dirty=True)
        self.assertEqual(a, "keep")


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
