#!/usr/bin/env python3
"""Safe fleet-wide worktree prune: merged/0-diff only, owner-check, dry-run-first.

Cards: 678c1e82 (original), 42192e2c (owner-check + 0-diff + git-cherry hardening).

Fleet hygiene: the fleet accumulates dozens of per-task worktrees under
/home/domin/marveen-wt/ (and /tmp). Once a worktree's branch is merged or
carries no unique work, the worktree is dead weight (disk + `git worktree list`
noise). This sweep removes ONLY worktrees that are provably safe to remove.

Safety (dry-run by default; pass --apply to actually remove):
  - Prune criterion (either A or B):
    A. "merged" == the worktree HEAD commit is an ancestor of origin/develop
       (works for merge-commit merges; conservatively KEEPS squash-only tips).
    B. "0-diff" == NOT an ancestor (squash/rebased) BUT the branch carries no
       uncommitted changes (dirty=False) AND no unpushed commits vs develop
       (`git cherry origin/develop <branch>` has no `+` lines).
       A worktree that is clean and has no unique commits is safe even if its
       branch was squash-merged, because there is nothing that would be lost.
  - OWNER-CHECK: if the worktree's owning agent tmux session is alive, KEEP it
    regardless of merge status. The agent may be mid-task.
    Owner is inferred from the worktree path prefix (see OWNER_SESSION_MAP).
  - HARD-EXCLUDE: the main checkout, /home/domin/marveen-wt-privacy (uncommitted
    governance WIP), and everything under .claude/worktrees/ (harness-managed,
    live agent/workflow worktrees).
  - KEEP any worktree with uncommitted changes (WIP protected).
  - KEEP any worktree that is neither merged nor 0-diff.
  - Branch deletion uses `git branch -d` (refuses unmerged) as a second guard.

Owner -> tmux session mapping (OWNER_SESSION_MAP below):
  - Paths under /home/domin/dave-wt-* belong to agent "dave" (session: agent-dave).
  - Paths under /home/domin/marveen-wt* belong to agent "marveen" (session: marveen).
  - Paths under /home/domin/marveen/.worktrees/* are also marveen's.
  - /tmp/* and other paths: owner unknown (conservative: skip owner-check, treat
    as no session alive so eligible for prune if otherwise safe).

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

# Map worktree path prefix -> agent session name.
# Checked in order; first prefix match wins.
# Value is the exact tmux session target (passed to `tmux has-session -t "=<val>"`).
OWNER_SESSION_MAP = [
    ("/home/domin/dave-wt", "agent-dave"),
    ("/home/domin/marveen-wt", "marveen"),
    ("/home/domin/marveen/.worktrees", "marveen"),
]


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


def infer_owner(path, owner_map=None):
    """Return the tmux session name for the agent owning this worktree path.

    Returns None if no prefix matches (owner unknown -> skip session check).
    """
    if owner_map is None:
        owner_map = OWNER_SESSION_MAP
    for prefix, session in owner_map:
        # Match exact prefix or prefix + separator (avoid "marveen-wt" matching
        # "marveen-wt-privacy" only via the more-specific entry).
        if path == prefix or path.startswith(prefix + os.sep) or path.startswith(prefix + "-"):
            return session
    return None


def is_session_alive(session_name):
    """Return True if tmux reports the named session as alive.

    Uses exact-match syntax (`=<name>`) so "marveen-channels" does not match
    a check for "marveen".  Returns False on any error (tmux absent, no server).
    """
    r = subprocess.run(
        ["tmux", "has-session", "-t", f"={session_name}"],
        capture_output=True,
    )
    return r.returncode == 0


def classify_worktree(*, path, branch, detached, is_ancestor, dirty, has_unpushed,
                       owner_session_alive,
                       main_path, exclude_paths, harness_dir):
    """Decide whether a worktree is safe to prune. Return (action, reason).

    Decision order (fail-CLOSED: each keep beats the next):
      1. Hard excludes (main, exclude_paths, harness).
      2. Uncommitted changes -> keep (WIP protected).
      3. Owner session alive -> keep (agent mid-task).
      4. Merged (ancestor of develop) -> prune.
      5. 0-diff (clean + no unpushed commits) -> prune.
      6. Everything else -> keep.
    """
    if path == main_path:
        return ("keep", "main checkout")
    if path in exclude_paths:
        return ("keep", "hard-excluded path")
    if harness_dir and (path == harness_dir or path.startswith(harness_dir + os.sep)):
        return ("keep", "harness-managed worktree (.claude/worktrees)")
    if dirty:
        return ("keep", "uncommitted changes (WIP protected)")
    if owner_session_alive:
        return ("keep", "owner session alive (agent may be mid-task)")
    label = branch if branch else "(detached)"
    if is_ancestor:
        return ("prune", f"{label} merged into develop")
    if not has_unpushed:
        return ("prune", f"{label} 0-diff vs develop (no unpushed commits, clean tree)")
    return ("keep", f"{label} not merged into develop")


# ---- git IO ---------------------------------------------------------------

def _git(repo, *args):
    return subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True, text=True,
    )


def is_ancestor_of_base(repo, commit, base=BASE_REF):
    r = _git(repo, "merge-base", "--is-ancestor", commit, base)
    return r.returncode == 0


def has_unpushed_commits(repo, branch, base=BASE_REF):
    """Return True if the branch has commits not in base.

    Uses `git cherry <base> <branch>`: lines starting with `+` are unpushed.
    Returns True (conservative: has unpushed) if the command fails or branch
    is None/detached.
    """
    if not branch:
        return True  # detached HEAD: can't cherry-check; treat as has-unpushed
    r = _git(repo, "cherry", base, branch)
    if r.returncode != 0:
        return True  # error -> conservative keep
    return any(line.startswith("+") for line in r.stdout.splitlines())


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
        unpushed = has_unpushed_commits(repo, wt["branch"], args.base)
        owner_session = infer_owner(wt["path"])
        owner_alive = is_session_alive(owner_session) if owner_session else False
        action, reason = classify_worktree(
            path=wt["path"], branch=wt["branch"], detached=wt["detached"],
            is_ancestor=anc, dirty=dirty, has_unpushed=unpushed,
            owner_session_alive=owner_alive,
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
