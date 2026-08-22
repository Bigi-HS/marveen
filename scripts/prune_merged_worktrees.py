#!/usr/bin/env python3
"""Prune git worktrees whose branch is provably merged into develop (card 678c1e82).

Fleet hygiene: the fleet accumulates dozens of per-task worktrees under
/home/domin/marveen-wt/ (and /tmp). Once a worktree's branch is merged, the
worktree is dead weight (disk + `git worktree list` noise). This sweep removes
ONLY worktrees that are provably merged and carry no uncommitted work.

Safety (dry-run by default; pass --apply to actually remove):
  - "merged" == the worktree HEAD commit is an ancestor of origin/develop
    (works for merge-commit merges; conservatively KEEPS squash/unmerged tips).
  - HARD-EXCLUDE: the main checkout, /home/domin/marveen-wt-privacy (uncommitted
    governance WIP), and everything under .claude/worktrees/ (harness-managed,
    live agent/workflow worktrees).
  - KEEP any worktree with uncommitted changes (WIP protected), even if merged.
  - KEEP any worktree whose tip is not an ancestor of develop (unmerged/active).
  - Branch deletion uses `git branch -d` (refuses unmerged) as a second guard.

Usage:
  python3 scripts/prune_merged_worktrees.py            # dry-run (default)
  python3 scripts/prune_merged_worktrees.py --apply     # actually remove
  python3 scripts/prune_merged_worktrees.py --repo /path/to/repo
"""

import argparse
import os
import subprocess
import sys

MAIN_PATH = "/home/domin/marveen"
EXCLUDE_PATHS = {"/home/domin/marveen-wt-privacy"}
HARNESS_DIR = "/home/domin/marveen/.claude/worktrees"
BASE_REF = "origin/develop"


def parse_worktrees(porcelain):
    """Parse `git worktree list --porcelain` output into dicts."""
    worktrees = []
    cur = {}

    def flush():
        if cur.get("path"):
            worktrees.append({
                "path": cur["path"],
                "head": cur.get("head", ""),
                "branch": cur.get("branch"),
                "detached": cur.get("detached", False),
            })

    for line in porcelain.splitlines():
        if line.startswith("worktree "):
            if cur:
                flush()
            cur = {"path": line[len("worktree "):]}
        elif line.startswith("HEAD "):
            cur["head"] = line[len("HEAD "):]
        elif line.startswith("branch "):
            cur["branch"] = line[len("branch "):].replace("refs/heads/", "")
        elif line.strip() == "detached":
            cur["detached"] = True
    if cur:
        flush()
    return worktrees


def classify_worktree(*, path, branch, detached, is_ancestor, dirty,
                       main_path, exclude_paths, harness_dir):
    """Decide whether a worktree is safe to prune. Return (action, reason)."""
    if path == main_path:
        return ("keep", "main checkout")
    if path in exclude_paths:
        return ("keep", "hard-excluded path")
    if harness_dir and (path == harness_dir or path.startswith(harness_dir + os.sep)):
        return ("keep", "harness-managed worktree (.claude/worktrees)")
    if dirty:
        return ("keep", "uncommitted changes (WIP protected)")
    label = branch if branch else "(detached)"
    if not is_ancestor:
        return ("keep", f"{label} not merged into develop")
    return ("prune", f"{label} merged into develop")


# ---- git IO ---------------------------------------------------------------

def _git(repo, *args):
    return subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True, text=True,
    )


def is_ancestor_of_base(repo, commit, base=BASE_REF):
    r = _git(repo, "merge-base", "--is-ancestor", commit, base)
    return r.returncode == 0


def is_dirty(path):
    # status on the worktree itself; non-empty porcelain == uncommitted changes
    r = subprocess.run(
        ["git", "-C", path, "status", "--porcelain"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        # can't read state -> treat as dirty (conservative keep)
        return True
    return bool(r.stdout.strip())


def remove_worktree(repo, path):
    return _git(repo, "worktree", "remove", path)


def delete_branch(repo, branch):
    # -d refuses to delete a not-fully-merged branch (extra safety net)
    return _git(repo, "branch", "-d", branch)


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually remove (default: dry-run)")
    ap.add_argument("--repo", default=MAIN_PATH)
    ap.add_argument("--base", default=BASE_REF)
    args = ap.parse_args(argv[1:])
    repo = args.repo

    _git(repo, "fetch", "origin", "develop")
    porcelain = _git(repo, "worktree", "list", "--porcelain").stdout
    worktrees = parse_worktrees(porcelain)

    to_prune, kept = [], []
    for wt in worktrees:
        anc = is_ancestor_of_base(repo, wt["head"], args.base) if wt["head"] else False
        dirty = is_dirty(wt["path"]) if os.path.isdir(wt["path"]) else False
        action, reason = classify_worktree(
            path=wt["path"], branch=wt["branch"], detached=wt["detached"],
            is_ancestor=anc, dirty=dirty,
            main_path=MAIN_PATH, exclude_paths=EXCLUDE_PATHS, harness_dir=HARNESS_DIR,
        )
        (to_prune if action == "prune" else kept).append((wt, reason))

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] {len(worktrees)} worktrees: {len(to_prune)} prunable, {len(kept)} kept\n")
    print("== PRUNE ==")
    for wt, reason in to_prune:
        print(f"  {wt['path']}  <- {reason}")
    print("\n== KEEP ==")
    for wt, reason in kept:
        print(f"  {wt['path']}  <- {reason}")

    if not args.apply:
        print(f"\nDry-run only. Re-run with --apply to remove {len(to_prune)} worktree(s).")
        return 0

    print(f"\nRemoving {len(to_prune)} worktree(s)...")
    removed, failed = 0, 0
    for wt, _ in to_prune:
        rr = remove_worktree(repo, wt["path"])
        if rr.returncode != 0:
            print(f"  FAIL remove {wt['path']}: {rr.stderr.strip()}")
            failed += 1
            continue
        removed += 1
        if wt["branch"]:
            br = delete_branch(repo, wt["branch"])
            tag = "branch deleted" if br.returncode == 0 else f"branch kept ({br.stderr.strip()})"
            print(f"  removed {wt['path']} ({tag})")
        else:
            print(f"  removed {wt['path']} (detached, no branch)")
    print(f"\nDone: {removed} removed, {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
