#!/usr/bin/env bash
# test_wire_context7_pin.sh -- guard that wire-context7-agent.sh pins the
# context7 MCP to an audited version instead of floating to npm 'latest'.
#
# Rationale (card 44bba215, acquisition-path gate 2026-08-04): a floating
# `npx -y @upstash/context7-mcp` re-fetches whatever is latest at launch, so any
# one-time supply-chain audit is only valid until the next upstream release.
# The wiring MUST pin the exact audited version. This test asserts on the wiring
# BEHAVIOUR (the dry-run spec it would write), not on source formatting.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/scripts/wire-context7-agent.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }

[ -f "$SCRIPT" ] || fail "wire script not found: $SCRIPT"

# 1) A concrete pinned version constant must exist in the script.
grep -qE 'C7_VERSION="[0-9]+\.[0-9]+\.[0-9]+"' "$SCRIPT" \
  || fail "no concrete pinned C7_VERSION in wire script"

# 2) The dry-run (behaviour) must write a VERSIONED spec, never bare 'latest'.
OUT="$(bash "$SCRIPT" dave --dry-run 2>&1 || true)"
echo "$OUT" | grep -qE '@upstash/context7-mcp@[0-9]+\.[0-9]+\.[0-9]+' \
  || fail "dry-run does not write a pinned (versioned) context7 spec. Got:\n$OUT"

# 3) The dry-run must NOT write a floating spec (package name with no @version).
if echo "$OUT" | grep -oE '@upstash/context7-mcp[^@0-9]' | grep -q .; then
  fail "dry-run writes a floating (unversioned) context7 spec. Got:\n$OUT"
fi

echo "PASS: wire-context7-agent.sh pins context7 to a concrete version"
