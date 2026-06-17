#!/usr/bin/env python3
"""
qa-run.py  --  gate-prep automation for PR reviews (card b649a61d).

Usage:
    python3 scripts/qa-run.py <PR_NUMBER> [--no-cleanup]

Steps:
  1. Fetch PR head SHA + metadata via GitHub API
  2. Create a clean detached git worktree at /tmp/wt-pr<N>
  3. Symlink node_modules from the main checkout (avoids re-install)
  4. Run tsc --noEmit
  5. Run full vitest suite
  6. Print a PASS / FAIL verdict with counts
  7. Remove the worktree (skip with --no-cleanup to inspect failures)

Replaces the 4-5 manual Bash tool calls needed per gate review.
The PAT is extracted from ~/.git-credentials and never printed.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = "Bigi-HS/marveen"
MAIN_CHECKOUT = "/home/domin/marveen"
WORKTREE_BASE = "/tmp"


# ---------------------------------------------------------------------------
# GitHub API
# ---------------------------------------------------------------------------

def _get_token() -> str:
    try:
        creds = open(os.path.expanduser("~/.git-credentials")).read()
    except OSError:
        sys.exit("ERROR: ~/.git-credentials not found")
    m = re.search(r"https://[^:]+:([^@]+)@github\.com", creds)
    if not m:
        sys.exit("ERROR: PAT not found in ~/.git-credentials")
    return m.group(1)


def _gh(token: str, path: str) -> dict:
    url = f"https://api.github.com/repos/{REPO}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "thor-qa-run",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() or "{}"
        msg = json.loads(body).get("message", body)
        sys.exit(f"ERROR: GitHub API {path} -> {e.code}: {msg}")


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------

def _run(cmd: list, cwd: str, label: str, timeout: int = 300) -> tuple:
    """Run a command, return (returncode, stdout+stderr combined)."""
    print(f"  >> {label} ...", flush=True)
    t0 = time.time()
    result = subprocess.run(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, timeout=timeout,
    )
    elapsed = time.time() - t0
    status = "OK" if result.returncode == 0 else f"EXIT {result.returncode}"
    print(f"     {status}  ({elapsed:.1f}s)", flush=True)
    return result.returncode, result.stdout


def _remove_worktree(wt_path: str) -> None:
    subprocess.run(
        ["git", "worktree", "remove", wt_path, "--force"],
        cwd=MAIN_CHECKOUT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


# ---------------------------------------------------------------------------
# Output parsing
# ---------------------------------------------------------------------------

def _parse_vitest(output: str) -> dict:
    # Target the "Tests  NNN passed | NNN skipped (NNN)" summary line.
    # "Test Files  NNN passed" is a different line -- match only the "Tests" row.
    m = re.search(
        r"^\s*Tests\s+(\d+) passed(?:\s*\|\s*(\d+) failed)?(?:\s*\|\s*(\d+) skipped)?",
        output, re.MULTILINE,
    )
    if m:
        return {
            "passed": int(m.group(1)),
            "failed": int(m.group(2)) if m.group(2) else 0,
            "skipped": int(m.group(3)) if m.group(3) else 0,
        }
    # Fallback: scan for counts anywhere (partial output / older vitest format)
    failed_m = re.search(r"(\d+) failed", output)
    passed_m = re.search(r"(\d+) passed", output)
    skipped_m = re.search(r"(\d+) skipped", output)
    return {
        "passed": int(passed_m.group(1)) if passed_m else 0,
        "failed": int(failed_m.group(1)) if failed_m else 0,
        "skipped": int(skipped_m.group(1)) if skipped_m else 0,
    }


def _tail_failures(output: str, n: int = 40) -> list:
    """Return lines likely to describe test failures."""
    lines = output.splitlines()
    fail_lines = [
        l for l in lines
        if any(k in l for k in ("FAIL", "Error", "AssertionError", "×", "✗", "expected"))
    ]
    return (fail_lines or lines)[-n:]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Automated gate-prep for a GitHub PR")
    ap.add_argument("pr_number", type=int, help="PR number to review")
    ap.add_argument(
        "--no-cleanup", action="store_true",
        help="Keep the worktree after the run (useful for manual inspection)",
    )
    args = ap.parse_args()

    pr_n = args.pr_number
    wt_path = os.path.join(WORKTREE_BASE, f"wt-pr{pr_n}")
    token = _get_token()

    # 1. Fetch PR metadata
    print(f"\n[qa-run] PR #{pr_n}", flush=True)
    pr = _gh(token, f"/pulls/{pr_n}")
    head_sha = pr["head"]["sha"]
    print(f"  title : {pr.get('title', '?')[:72]}")
    print(f"  state : {pr.get('state', '?')}")
    print(f"  head  : {head_sha}")
    if pr.get("state") != "open":
        print(f"  WARN  : PR is not open -- continuing anyway")

    # 2. Fetch so the head SHA is in the local object store (a freshly pushed PR's
    #    SHA may not be present yet, causing "invalid reference" on worktree add).
    fetch_r = subprocess.run(
        ["git", "fetch", "origin", f"pull/{pr_n}/head"],
        cwd=MAIN_CHECKOUT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    if fetch_r.returncode != 0:
        # Fallback: broad fetch if the pull/<N>/head refspec is unavailable
        subprocess.run(
            ["git", "fetch", "origin"],
            cwd=MAIN_CHECKOUT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    # Create clean worktree (remove any leftover first)
    if os.path.exists(wt_path):
        print(f"  WARN  : {wt_path} exists, removing first")
        _remove_worktree(wt_path)

    r = subprocess.run(
        ["git", "worktree", "add", "--detach", wt_path, head_sha],
        cwd=MAIN_CHECKOUT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"ERROR: git worktree add failed:\n{r.stderr.strip()}")
    print(f"  >> worktree created at {wt_path}")

    tsc_ok = vt_ok = False
    tsc_output = vt_output = ""

    try:
        # 3. Link node_modules
        nm_link = os.path.join(wt_path, "node_modules")
        if not os.path.lexists(nm_link):
            os.symlink(os.path.join(MAIN_CHECKOUT, "node_modules"), nm_link)
            print("  >> node_modules linked")

        # 4. tsc
        tsc_code, tsc_output = _run(
            ["npx", "tsc", "--noEmit"], wt_path, "tsc --noEmit",
        )
        tsc_ok = tsc_code == 0

        # 5. vitest
        vt_code, vt_output = _run(
            ["npx", "vitest", "run"], wt_path, "vitest run",
        )
        vt_ok = vt_code == 0
        vt = _parse_vitest(vt_output)

        # 6. Verdict
        print()
        bar = "=" * 62
        print(bar)
        print(f"  PR #{pr_n}  {head_sha[:8]}")
        print(f"  tsc    : {'PASS' if tsc_ok else 'FAIL'}")
        if vt["failed"]:
            vt_label = (
                f"FAIL  ({vt['failed']} failed, {vt['passed']} passed,"
                f" {vt['skipped']} skipped)"
            )
        else:
            vt_label = f"PASS  ({vt['passed']} passed / {vt['skipped']} skipped)"
        print(f"  vitest : {vt_label}")
        overall = "PASS" if (tsc_ok and vt_ok) else "FAIL"
        print(f"  result : {overall}")
        print(bar)

        # Show failure details inline
        if not tsc_ok:
            print("\n-- tsc output (last 20 lines) --")
            for line in tsc_output.splitlines()[-20:]:
                print(f"  {line}")

        if not vt_ok:
            print("\n-- vitest failure excerpt --")
            for line in _tail_failures(vt_output):
                print(f"  {line}")

        return 0 if overall == "PASS" else 1

    finally:
        if not args.no_cleanup:
            print(f"\n  >> cleanup: removing {wt_path}")
            _remove_worktree(wt_path)
            print("     done")
        else:
            print(f"\n  >> --no-cleanup: worktree kept at {wt_path}")


if __name__ == "__main__":
    sys.exit(main())
