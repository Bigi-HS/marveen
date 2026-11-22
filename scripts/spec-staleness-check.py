#!/usr/bin/env python3
"""spec_staleness_check -- gate-hardening: detect recently-changed spec files
(card fc510493).

Before a gate review, any spec file touched within the last N days (default 3)
signals that reviewers must re-read the full diff; stale line-references from an
earlier read would otherwise be misleading.

DESIGN CONSTRAINTS (fail-closed):

  - Any error (git not found, non-git directory, missing spec file, subprocess
    failure, etc.) is treated as STALE -> force re-read. We never assume freshness
    when we cannot verify it.
  - CWD-INDEPENDENT: the git repo root is derived from HERE = the directory
    containing THIS script's parent (Path(__file__).resolve().parent.parent), NOT
    from the caller's cwd. This matches the fleet-wide anti-pattern: a CWD-
    relative constant silently breaks when the caller is not at repo root.
  - Pure importable core (spec_staleness_check / spec_is_stale) + thin CLI so
    tests can import and exercise the pure logic directly.

CLI usage:
  python3 scripts/spec-staleness-check.py <spec_path> [--days N] [--json]

Exit codes:
  0 = NOT stale (no fresh commits in the window -- reviewer may rely on existing read)
  1 = STALE (fresh commits exist -- reviewer MUST re-read the full diff)
  2 = ERROR (treated as stale; details on stderr)

The exit-code convention mirrors pre-gate-bundle.sh (0=ok / 1=block) so this can
be called from shell gate-checklist scripts with a simple `if !` guard.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# CWD-INDEPENDENT repo root (must be derived from __file__, NOT os.getcwd())
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent          # scripts/
REPO_ROOT = HERE.parent                         # repo root

# Test-only override: set _SPEC_STALE_REPO_ROOT_OVERRIDE env to redirect the
# CLI's implicit REPO_ROOT to a tempdir repo without touching __file__.
_env_override = os.environ.get("_SPEC_STALE_REPO_ROOT_OVERRIDE")
if _env_override:
    REPO_ROOT = Path(_env_override).resolve()


def _run_git_log(repo_root: Path, spec_path: str, days: int) -> tuple[int, str, str]:
    """Run `git log --since=<N>.days -- <spec>` in repo_root.

    Returns (returncode, stdout, stderr).  On OSError / FileNotFoundError
    returns (-1, "", error_message) so callers can treat it as an error
    without catching exceptions.
    """
    try:
        result = subprocess.run(
            [
                "git", "log",
                "--oneline",
                f"--since={days}.days",
                "--",
                spec_path,
            ],
            capture_output=True,
            text=True,
            cwd=str(repo_root),
        )
        return result.returncode, result.stdout, result.stderr
    except (OSError, FileNotFoundError) as exc:
        return -1, "", str(exc)


def spec_staleness_check(
    spec_path: str,
    *,
    days: int = 3,
    repo_root: Path | None = None,
) -> dict:
    """Pure-ish checker: return a verdict dict.

    Args:
        spec_path: Path to the spec file (absolute or relative to repo_root).
        days:      Recency window (default 3 -- the card requirement).
        repo_root: Override for testing; defaults to the CWD-independent REPO_ROOT.

    Returns a dict with:
        stale   (bool)  True  = fresh commits exist -> must re-read.
                        True  = also when an error prevents checking (fail-closed).
        commits (list)  One-line `git log` entries for fresh commits; [] on error.
        days    (int)   The window used.
        spec    (str)   The spec_path as given.
        error   (str|None) Set to a description when we fell back due to an error.

    FAIL-CLOSED: stale=True is returned on any error so callers never skip a
    re-read when the check could not complete.
    """
    root = repo_root if repo_root is not None else REPO_ROOT

    # Fail-closed: a path that does not exist in the repo cannot be verified
    # as fresh -- treat it as stale so reviewers are never misled.
    if not (root / spec_path).exists():
        return {
            "stale": True,
            "commits": [],
            "days": days,
            "spec": spec_path,
            "error": f"spec file not found in repo: {spec_path}",
        }

    rc, stdout, stderr = _run_git_log(root, spec_path, days)

    if rc == -1:
        # Subprocess could not start (git missing, not a git repo, etc.)
        return {
            "stale": True,   # fail-closed
            "commits": [],
            "days": days,
            "spec": spec_path,
            "error": f"git invocation failed: {stderr}",
        }

    if rc != 0:
        # git exited non-zero (e.g. the path is outside the repo)
        return {
            "stale": True,   # fail-closed
            "commits": [],
            "days": days,
            "spec": spec_path,
            "error": f"git log exited {rc}: {stderr.strip()}",
        }

    # rc == 0: empty stdout = no fresh commits; non-empty = stale (fresh commits)
    commits = [line for line in stdout.splitlines() if line.strip()]
    return {
        "stale": bool(commits),   # fresh commits present -> must re-read
        "commits": commits,
        "days": days,
        "spec": spec_path,
        "error": None,
    }


def spec_is_stale(spec_path: str, *, days: int = 3, repo_root: Path | None = None) -> bool:
    """Convenience bool wrapper -- True means: reviewer MUST re-read."""
    return spec_staleness_check(spec_path, days=days, repo_root=repo_root)["stale"]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Detect recently-changed spec files before a gate review."
    )
    ap.add_argument("spec", help="Path to the spec file (relative to repo root or absolute)")
    ap.add_argument(
        "--days", type=int, default=3,
        help="Recency window in days (default: 3)",
    )
    ap.add_argument("--json", action="store_true", help="Emit result as JSON to stdout")
    args = ap.parse_args(argv)

    result = spec_staleness_check(args.spec, days=args.days)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        status = "STALE" if result["stale"] else "OK"
        err_note = f" [error: {result['error']}]" if result["error"] else ""
        print(f"spec-staleness: {status} -- {args.spec} (window={args.days}d){err_note}")
        if result["commits"]:
            print(f"  fresh commits ({len(result['commits'])}):")
            for c in result["commits"]:
                print(f"    {c}")
        elif result["stale"]:
            # stale due to error, no commits to show
            pass
        else:
            print("  no commits in window -- safe to rely on existing read")

    if result["error"]:
        sys.stderr.write(f"WARNING spec-staleness-check: {result['error']}\n")

    # Exit 1 = stale (must re-read), 0 = not stale, 2 = treated as stale due to error
    if result["error"]:
        sys.exit(2)
    sys.exit(1 if result["stale"] else 0)


if __name__ == "__main__":
    main()
