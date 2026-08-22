#!/usr/bin/env python3
"""eng-worktree: one-command lifecycle for ephemeral engineering worktrees (card 64effaad).

Replaces the hand-typed worktree dance the fleet engineers repeat on every
ephemeral build:

  git worktree add -B eng/<key> <path> origin/develop
  ln -sfn /home/domin/marveen/node_modules <path>/node_modules
  ... work, commit, push ...
  git worktree remove --force <path> && git worktree prune && git branch -D eng/<key>

This wraps CREATE (add + node_modules symlink + stale-base verify) and REMOVE
(remove --force + prune + branch delete). The bulk orphan/merged sweep is NOT
reimplemented here -- `sweep` delegates to the existing
scripts/prune_merged_worktrees.py (card 678c1e82), which already classifies and
removes provably-merged worktrees (including stale /tmp/wt-prNNN gate-prep dirs)
with WIP/main/harness safety.

Conventions follow the git-worktree-manager skill: branch = eng/<key>, path =
/home/domin/marveen-wt/<key>, base pinned to origin/<base> via -B, node_modules
symlinked (never reinstalled).

Usage:
  python3 scripts/eng_worktree.py create <key> [--base develop]
  python3 scripts/eng_worktree.py remove <key> [--delete-remote]
  python3 scripts/eng_worktree.py sweep [--apply]      # -> prune_merged_worktrees.py
  python3 scripts/eng_worktree.py list

  <key> is a single segment, e.g. eph-7b44af3a-ackhook-harden
  -> branch eng/eph-7b44af3a-ackhook-harden, dir /home/domin/marveen-wt/eph-...
"""

import argparse
import os
import re
import subprocess
import sys

REPO_DEFAULT = "/home/domin/marveen"
WT_BASE_DEFAULT = "/home/domin/marveen-wt"
HARNESS_DIR = "/home/domin/marveen/.claude/worktrees"
BRANCH_PREFIX = "eng/"

# A worktree key is a single path/branch segment: alnum start, then alnum . _ -
# No slashes (would escape the wt dir / nest a branch), no shell metachars, no
# leading dash (git would parse it as a flag), no `..` (path traversal).
_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


# ---- pure logic (unit-tested) ---------------------------------------------

def validate_key(key):
    """Raise ValueError unless key is a safe single segment."""
    if not key or not _KEY_RE.match(key):
        raise ValueError(
            f"invalid worktree key {key!r}: expected ^[A-Za-z0-9][A-Za-z0-9._-]*$"
        )
    if ".." in key:
        raise ValueError(f"invalid worktree key {key!r}: path traversal")


def branch_name(key):
    return BRANCH_PREFIX + key


def worktree_path(key, wt_base=WT_BASE_DEFAULT):
    return os.path.join(wt_base, key)


def base_ref(base):
    return "origin/" + base


def create_plan(key, base="develop", repo=REPO_DEFAULT, wt_base=WT_BASE_DEFAULT):
    validate_key(key)
    path = worktree_path(key, wt_base)
    branch = branch_name(key)
    ref = base_ref(base)
    return {
        "key": key,
        "branch": branch,
        "path": path,
        "base": base,
        "base_ref": ref,
        "fetch": ["git", "-C", repo, "fetch", "origin", base],
        "add": ["git", "-C", repo, "worktree", "add", "-B", branch, path, ref],
        "symlink_src": os.path.join(repo, "node_modules"),
        "symlink_dst": os.path.join(path, "node_modules"),
    }


def remove_plan(key, repo=REPO_DEFAULT, wt_base=WT_BASE_DEFAULT, delete_remote=False):
    validate_key(key)
    path = worktree_path(key, wt_base)
    branch = branch_name(key)
    return {
        "key": key,
        "branch": branch,
        "path": path,
        "remove": ["git", "-C", repo, "worktree", "remove", "--force", path],
        "prune": ["git", "-C", repo, "worktree", "prune"],
        "branch_delete": ["git", "-C", repo, "branch", "-D", branch],
        "push_delete": (
            ["git", "-C", repo, "push", "origin", "--delete", branch]
            if delete_remote else None
        ),
    }


def is_safe_worktree_path(path, repo=REPO_DEFAULT, wt_base=WT_BASE_DEFAULT):
    """True only for a removable ephemeral worktree dir.

    Guards the destructive `worktree remove --force`: never the main checkout,
    never the wt-base container itself, never a harness-managed worktree. Only
    a child of wt_base or of /tmp counts.

    Uses realpath, not normpath: a `wt_base/<key>` symlink that targets the main
    checkout would slip past a normpath check (normpath does not resolve
    symlinks), so the remove must see the REAL target (Chad PR#216 INFO[low]).
    For a path with no symlinked components realpath == normpath, so the plain
    string-path behaviour is unchanged.
    """
    real = os.path.realpath(path)
    real_repo = os.path.realpath(repo)
    real_wt = os.path.realpath(wt_base)
    real_harness = os.path.realpath(HARNESS_DIR)
    if real == real_repo:
        return False
    if real == real_wt:
        return False
    if real == real_harness or real.startswith(real_harness + os.sep):
        return False
    if real.startswith(real_wt + os.sep):
        return True
    if real.startswith("/tmp/"):
        return True
    return False


# ---- git IO ----------------------------------------------------------------

def _run(argv):
    return subprocess.run(argv, capture_output=True, text=True)


def _symlink_force(src, dst):
    """ln -sfn src dst: replace an existing symlink, never reinstall node_modules."""
    if os.path.islink(dst) or os.path.exists(dst):
        if os.path.islink(dst):
            os.unlink(dst)
        # a real directory at dst is not ours to delete -> leave it, git add handled deps
        elif os.path.isdir(dst):
            return False
    os.symlink(src, dst)
    return True


def run_create(args):
    plan = create_plan(args.key, base=args.base, repo=args.repo, wt_base=args.wt_base)

    f = _run(plan["fetch"])
    if f.returncode != 0:
        print(f"FAIL fetch origin {plan['base']}: {f.stderr.strip()}", file=sys.stderr)
        return 1

    a = _run(plan["add"])
    if a.returncode != 0:
        print(f"FAIL worktree add: {a.stderr.strip()}", file=sys.stderr)
        return 1

    linked = _symlink_force(plan["symlink_src"], plan["symlink_dst"])
    if not linked:
        print(f"  note: {plan['symlink_dst']} already a real dir, left as-is")

    # stale-base guard: HEAD must equal origin/<base> right after creation
    head = _run(["git", "-C", plan["path"], "rev-parse", "HEAD"]).stdout.strip()
    want = _run(["git", "-C", args.repo, "rev-parse", plan["base_ref"]]).stdout.strip()
    if head != want:
        print(f"WARN stale base: HEAD {head[:10]} != {plan['base_ref']} {want[:10]}",
              file=sys.stderr)

    print(f"created  {plan['path']}")
    print(f"  branch {plan['branch']}  @ {plan['base_ref']} ({head[:10]})")
    print(f"  node_modules -> {plan['symlink_src']}")
    print(f"\ncd {plan['path']}")
    return 0


def run_remove(args):
    plan = remove_plan(args.key, repo=args.repo, wt_base=args.wt_base,
                       delete_remote=args.delete_remote)

    if not is_safe_worktree_path(plan["path"], repo=args.repo, wt_base=args.wt_base):
        print(f"REFUSE remove: {plan['path']} is not a removable ephemeral worktree",
              file=sys.stderr)
        return 1

    r = _run(plan["remove"])
    if r.returncode != 0:
        print(f"FAIL worktree remove: {r.stderr.strip()}", file=sys.stderr)
        return 1
    _run(plan["prune"])

    b = _run(plan["branch_delete"])
    btag = "branch deleted" if b.returncode == 0 else f"branch kept ({b.stderr.strip()})"
    print(f"removed  {plan['path']} ({btag})")

    if plan["push_delete"]:
        p = _run(plan["push_delete"])
        ptag = "remote deleted" if p.returncode == 0 else f"remote kept ({p.stderr.strip()})"
        print(f"  {ptag}: {plan['branch']}")
    return 0


def run_sweep(args):
    """Delegate the bulk orphan/merged sweep to the existing prune script."""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "prune_merged_worktrees.py")
    argv = [sys.executable, script, "--repo", args.repo]
    if args.apply:
        argv.append("--apply")
    return subprocess.run(argv).returncode


def run_list(args):
    return subprocess.run(["git", "-C", args.repo, "worktree", "list"]).returncode


def main(argv):
    ap = argparse.ArgumentParser(prog="eng_worktree")
    ap.add_argument("--repo", default=REPO_DEFAULT)
    ap.add_argument("--wt-base", default=WT_BASE_DEFAULT)
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create", help="add a worktree on eng/<key> pinned to origin/<base>")
    c.add_argument("key")
    c.add_argument("--base", default="develop")
    c.set_defaults(fn=run_create)

    r = sub.add_parser("remove", help="remove worktree + prune + delete eng/<key>")
    r.add_argument("key")
    r.add_argument("--delete-remote", action="store_true")
    r.set_defaults(fn=run_remove)

    s = sub.add_parser("sweep", help="prune provably-merged worktrees (delegates)")
    s.add_argument("--apply", action="store_true")
    s.set_defaults(fn=run_sweep)

    l = sub.add_parser("list", help="git worktree list")
    l.set_defaults(fn=run_list)

    args = ap.parse_args(argv[1:])
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
