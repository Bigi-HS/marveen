#!/usr/bin/env python3
"""gate-ci-poll.py  --  independent-CI dispatcher for the merge gate (card d44c9c75).

Scheduled ~every 5 min by n8n (Tier-B token-offload, ZERO LLM). Finds open PRs
whose live head has no mechanical CI result yet and runs the CI on ONE of them,
posting the verdict to /api/gate/ci (via qa-run.py --post-ci).

Design:
  1. List open PRs (GitHub API; PAT from ~/.git-credentials, never printed).
  2. For each (oldest-created first) GET /api/gate/check?pr=N and keep those whose
     ci_status == "none" -- i.e. no CI run bound to the current head. A pushed head
     resets ci_status to none, so a re-push re-qualifies automatically.
  3. Run CI on the FIRST such PR only (one per tick -> bounded wall-clock, no
     overlapping vitest runs across ticks), by invoking qa-run.py <N> --post-ci.
     qa-run.py posts the result and relays a RED to forge.

SENSE + REPORT only: this never fills a reviewer seat, merges, deploys, or restarts.
Green CI is necessary-not-sufficient; it feeds the gate as an advisory signal.

Usage:
    python3 scripts/gate-ci-poll.py [--limit N] [--dry-run]

Exit code: 0 on success (including "nothing to do"); non-zero on hard error.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "Bigi-HS/marveen"
MAIN_CHECKOUT = "/home/domin/marveen"
DASHBOARD_URL = "http://localhost:3420"


# ---------------------------------------------------------------------------
# Pure selection logic (unit-tested)
# ---------------------------------------------------------------------------

def needs_ci(check: dict) -> bool:
    """True when the PR's live head has no CI run bound to it yet.

    ci_status is "none" until a run is posted for the current head; a fresh push
    resets it to "none". "pass"/"fail" mean a run already exists for this head.
    """
    return check.get("ci_status") == "none"


def select_target(prs, check_of) -> dict:
    """First open PR (oldest by number) that needs CI. check_of(pr_number)->check dict.

    Returns the PR dict, or None if every open PR already has a CI result.
    """
    for pr in sorted(prs, key=lambda p: p["number"]):
        try:
            if needs_ci(check_of(pr["number"])):
                return pr
        except Exception:
            # A transient gate-check failure must not wedge the whole poll; skip
            # this PR and let the next tick retry it.
            continue
    return None


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def _github_token() -> str:
    creds = open(os.path.expanduser("~/.git-credentials")).read()
    m = re.search(r"https://[^:]+:([^@]+)@github\.com", creds)
    if not m:
        sys.exit("ERROR: PAT not found in ~/.git-credentials")
    return m.group(1)


def _dashboard_token() -> str:
    with open(os.path.join(MAIN_CHECKOUT, "store", ".dashboard-token")) as f:
        return f.read().strip()


def list_open_prs(gh_token: str) -> list:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/pulls?state=open&per_page=50",
        headers={"Authorization": f"token {gh_token}", "User-Agent": "gate-ci-poll",
                 "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode())


def gate_check(pr_number: int, op_token: str) -> dict:
    req = urllib.request.Request(
        f"{DASHBOARD_URL}/api/gate/check?pr={pr_number}",
        headers={"Authorization": f"Bearer {op_token}"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def run_ci(pr_number: int) -> int:
    """Invoke qa-run.py <N> --post-ci (which owns worktree + tsc + vitest + post)."""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qa-run.py")
    return subprocess.run(["python3", script, str(pr_number), "--post-ci"],
                          cwd=MAIN_CHECKOUT).returncode


def main() -> int:
    ap = argparse.ArgumentParser(description="Dispatch independent CI to open PRs needing it")
    ap.add_argument("--limit", type=int, default=1,
                    help="Max PRs to run CI on this tick (default 1, keeps ticks bounded)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report which PR(s) would run, without invoking CI")
    args = ap.parse_args()

    op_token = _dashboard_token()
    prs = list_open_prs(_github_token())
    if not prs:
        print("gate-ci-poll: no open PRs")
        return 0

    ran = 0
    remaining = list(prs)
    while ran < args.limit:
        target = select_target(remaining, lambda n: gate_check(n, op_token))
        if target is None:
            break
        n = target["number"]
        print(f"gate-ci-poll: PR#{n} needs CI ({target.get('title', '?')[:60]})")
        if args.dry_run:
            print(f"  DRY-RUN: would run qa-run.py {n} --post-ci")
        else:
            rc = run_ci(n)
            print(f"  qa-run.py {n} --post-ci -> exit {rc}")
        remaining = [p for p in remaining if p["number"] != n]
        ran += 1

    if ran == 0:
        print("gate-ci-poll: all open PRs already have a CI result for their live head")
    return 0


if __name__ == "__main__":
    sys.exit(main())
