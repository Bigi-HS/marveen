#!/usr/bin/env python3
"""PostToolUse hook (Bash): post-merge metrics capture (Gauge-shaped, passive).

Detects a completed `git merge` (or a `gh pr merge`) Bash command and records a
one-line metric to store/merge-metrics.log: timestamp, the merged ref if it can
be parsed from the command, and the size of the resulting merge (files changed /
insertions / deletions) read from `git diff --shortstat HEAD~1..HEAD`.

Passive -- it never blocks (always exit 0). It only records, so Gauge / Forge can
trend merge cadence and change size over time without a server round-trip.

Best-effort: if the command was not actually a merge, or git can't be read, the
hook silently no-ops. It uses the hook's own cwd (from the payload) to run git so
metrics reflect the repo the merge happened in.
"""
import sys
import os
import json
import re
import subprocess
from datetime import datetime

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
METRICS_LOG = os.path.join(INSTALL_DIR, "store", "merge-metrics.log")

MERGE_RX = re.compile(r"\bgit\s+merge\b|\bgh\s+pr\s+merge\b", re.IGNORECASE)
# Parse a likely merged ref: `git merge <ref>` or `gh pr merge <n>`.
REF_RX = re.compile(r"\bgit\s+merge\s+(?:--\S+\s+)*(\S+)|\bgh\s+pr\s+merge\s+(\S+)", re.IGNORECASE)


def _shortstat(cwd):
    """Return 'N files, +I, -D' for the last commit (the merge result), or None."""
    try:
        out = subprocess.run(
            ["git", "diff", "--shortstat", "HEAD~1..HEAD"],
            cwd=cwd or None,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
    except Exception:
        return None
    if not out:
        return None
    files = ins = dels = 0
    m = re.search(r"(\d+)\s+files?\s+changed", out)
    if m:
        files = int(m.group(1))
    m = re.search(r"(\d+)\s+insertion", out)
    if m:
        ins = int(m.group(1))
    m = re.search(r"(\d+)\s+deletion", out)
    if m:
        dels = int(m.group(1))
    return f"{files} files, +{ins}, -{dels}"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if payload.get("tool_name") != "Bash":
        sys.exit(0)

    cmd = (payload.get("tool_input") or {}).get("command", "")
    if not MERGE_RX.search(cmd):
        sys.exit(0)

    cwd = payload.get("cwd") or os.getcwd()

    ref = "?"
    m = REF_RX.search(cmd)
    if m:
        ref = m.group(1) or m.group(2) or "?"

    stat = _shortstat(cwd) or "stat-unavailable"
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

    try:
        with open(METRICS_LOG, "a") as f:
            f.write(f"{ts} [merge] ref={ref} {stat} cwd={cwd}\n")
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
