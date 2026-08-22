#!/usr/bin/env python3
"""Pre-deploy delta risk classifier + hook-presence check.

Usage: python3 scripts/deploy-delta-check.py [--target <sha-or-ref>]

Reads store/.deployed-tip, compares with origin/develop (or --target),
classifies each merged PR as LOW/MED/HIGH risk, and runs a hook-presence scan.

Exit 0 = PASS (no HIGH-risk PRs, no missing hooks).
Exit 1 = BLOCK (HIGH-risk PRs found OR hooks missing -- review before GO).

Intended as a pre-GO-request gate in the deploy checklist. Run it before
asking NoA for GO; include the SUMMARY line in the GO request so reviewers
know the risk surface.
"""

import subprocess
import sys
import os
import re
import glob
import argparse

REPO = "/home/domin/marveen"

# Files matching these patterns classify a PR as HIGH risk.
# Order matters: first match wins.
HIGH_PATTERNS = [
    r"scripts/hooks/",           # hook scripts referenced in settings.json
    r"src/.*guardrail",          # security guardrails
    r"src/.*permission",         # permission rules
    r"src/.*auth",               # auth / token handling
    r"src/.*token",
    r"src/.*channel",            # channel wiring / Telegram pipe
    r"src/.*watchdog",           # watchdog / supervisor changes
    r"scripts/fleet-supervisor", # supervisor itself
    r"scripts/.*watchdog",
    r"seed-config/",             # per-agent launch config
]

# Files matching these patterns classify a PR as MED risk (if not HIGH).
MED_PATTERNS = [
    r"src/web/",
    r"src/api",
    r"src/mcp/",
    r"src/.*route",
]


def classify_files(files):
    """Return ('HIGH'|'MED'|'LOW', trigger_file)."""
    for f in files:
        for p in HIGH_PATTERNS:
            if re.search(p, f):
                return "HIGH", f
    for f in files:
        for p in MED_PATTERNS:
            if re.search(p, f):
                return "MED", f
    return "LOW", ""


def get_deployed_tip():
    path = os.path.join(REPO, "store/.deployed-tip")
    try:
        return open(path).read().strip()
    except FileNotFoundError:
        return None


def get_delta_prs(tip, target):
    result = subprocess.run(
        ["git", "-C", REPO, "log", "--merges", "--oneline", f"{tip}..{target}"],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip().splitlines()


def get_pr_files(sha):
    # Use first-parent diff: diff-tree without -m/-c is empty for merge commits.
    result = subprocess.run(
        ["git", "-C", REPO, "diff", "--name-only", f"{sha}^1..{sha}"],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip().splitlines()


def hook_presence_check():
    """Scan agent settings.json files for scripts/hooks/*.py refs.

    Returns (missing: list[str], checked: int).
    """
    settings_paths = glob.glob(f"{REPO}/agents/*/.claude*/settings*.json")
    referenced = set()
    found_any = False
    for path in settings_paths:
        try:
            content = open(path).read()
            found_any = True
            for m in re.finditer(r"scripts/hooks/[^\s\"']+\.py", content):
                referenced.add(m.group())
        except Exception:
            pass
    if not found_any:
        print("WARN: hook-presence scan found 0 settings.json files -- vacuous pass, verify REPO path")
    missing = [f for f in sorted(referenced) if not os.path.exists(f"{REPO}/{f}")]
    return missing, len(referenced)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="origin/develop",
                        help="Target ref to diff against (default: origin/develop)")
    args = parser.parse_args()

    tip = get_deployed_tip()
    if not tip:
        print("ERROR: store/.deployed-tip not found -- cannot compute delta")
        sys.exit(1)

    print(f"Deployed tip : {tip}")
    print(f"Target       : {args.target}")
    print()

    # 1. Hook-presence check
    missing_hooks, checked = hook_presence_check()
    if missing_hooks:
        print(f"HOOK-PRESENCE: BLOCK ({len(missing_hooks)} missing)")
        for f in missing_hooks:
            print(f"  MISSING: {REPO}/{f}")
    else:
        print(f"Hook-presence: OK ({checked} referenced scripts all present)")
    print()

    # 2. Delta PR classification
    prs = get_delta_prs(tip, args.target)
    if not prs:
        print("Delta: 0 PRs -- already up to date")
        sys.exit(1 if missing_hooks else 0)

    high, med, low = [], [], []
    for pr_line in prs:
        parts = pr_line.split(None, 1)
        sha = parts[0]
        title = parts[1] if len(parts) > 1 else "(no title)"
        files = get_pr_files(sha)
        level, trigger = classify_files(files)
        entry = (sha[:8], title, trigger)
        if level == "HIGH":
            high.append(entry)
        elif level == "MED":
            med.append(entry)
        else:
            low.append(entry)

    # 3. Summary line (paste into GO request)
    parts_summary = []
    if high:
        parts_summary.append(f"{len(high)} HIGH")
    if med:
        parts_summary.append(f"{len(med)} MED")
    if low:
        parts_summary.append(f"{len(low)} LOW")
    summary = f"{len(prs)} PR: {', '.join(parts_summary)}"

    block = bool(high) or bool(missing_hooks)
    if block:
        suffix = "REVIEW HIGH BEFORE GO" if high else "HOOK-PRESENCE BLOCK"
        print(f"SUMMARY: {summary} -- {suffix}")
    else:
        print(f"SUMMARY: {summary} -- GO OK")
    print()

    if high:
        print("HIGH risk (review before GO):")
        for sha, title, trigger in high:
            print(f"  [{sha}] {title}")
            print(f"           trigger: {trigger}")
        print()
    if med:
        print("MED risk:")
        for sha, title, trigger in med:
            print(f"  [{sha}] {title}")
        print()
    if low:
        print(f"LOW risk: {len(low)} PR(s) (details omitted)")

    sys.exit(1 if block else 0)


if __name__ == "__main__":
    main()
