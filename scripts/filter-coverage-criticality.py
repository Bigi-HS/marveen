#!/usr/bin/env python3
"""Filter uncovered code lines by coverage-criticality tier (Thor QA authority).

TIER-1 (BLOCKER -- security/auth/data integrity):
  src/web/dashboard-auth.ts, src/web/aidefence-guard.ts, src/web/vault.ts,
  src/web/channel-token-durability.ts, src/web/routes/messages.ts

TIER-2 (FLAG -- channel/lifecycle integrity):
  src/web/channel-provider.ts, src/web/channel-monitor.ts,
  src/web/channel-health-monitor.ts, src/web/channel-poller-reap.ts,
  src/web/agent-process.ts, src/web/agent-config.ts,
  src/web/agent-preflight.ts, src/db.ts

TIER-3 (informational -- API surface):
  src/web/routes/*.ts (other), src/**/*.test.ts, src/__tests__/*, etc.

Usage:
    cat uncovered-lines.txt | ./filter-coverage-criticality.py
    ./filter-coverage-criticality.py < uncovered-lines.txt

Input format: "file:line-range" or "file L12-L34"
Output format: "[TIER-1] file..." or "[TIER-2] file..." or "[TIER-3] file..."
"""

import sys
import re
from pathlib import Path


def extract_file(line):
    """Extract file path from line like 'src/web/dashboard-auth.ts:200-220' or 'src/db.ts L45-67'"""
    match = re.match(r'^([^:\s]+)', line.strip())
    return match.group(1) if match else None


def categorize_tier(filepath):
    """Return 'TIER-1', 'TIER-2', or 'TIER-3' based on file path (Thor QA definition)."""
    if not filepath:
        return 'TIER-3'

    # TIER-1: security/auth/data integrity (blocker)
    tier1_patterns = [
        r'^src/web/dashboard-auth\.ts$',
        r'^src/web/aidefence-guard\.ts$',
        r'^src/web/vault\.ts$',
        r'^src/web/channel-token-durability\.ts$',
        r'^src/web/routes/messages\.ts$',
    ]

    # TIER-2: channel/lifecycle integrity (flag)
    tier2_patterns = [
        r'^src/web/channel-provider\.ts$',
        r'^src/web/channel-monitor\.ts$',
        r'^src/web/channel-health-monitor\.ts$',
        r'^src/web/channel-poller-reap\.ts$',
        r'^src/web/agent-process\.ts$',
        r'^src/web/agent-config\.ts$',
        r'^src/web/agent-preflight\.ts$',
        r'^src/db\.ts$',
    ]

    # Check TIER-1 patterns
    for pattern in tier1_patterns:
        if re.match(pattern, filepath):
            return 'TIER-1'

    # Check TIER-2 patterns
    for pattern in tier2_patterns:
        if re.match(pattern, filepath):
            return 'TIER-2'

    # Default to TIER-3 (informational, conservative)
    return 'TIER-3'


def main():
    for line in sys.stdin:
        line = line.rstrip('\n')
        if not line:
            continue

        file = extract_file(line)
        tier = categorize_tier(file)
        print(f"[{tier}] {line}")


if __name__ == '__main__':
    main()
