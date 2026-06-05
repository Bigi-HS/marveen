#!/bin/bash
# Integration test for coverage criticality filter.
# Simulates a sample PR's uncovered lines and validates categorization.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILTER_SCRIPT="$SCRIPT_DIR/filter-coverage-criticality.py"

echo "=== Coverage Criticality Filter Integration Test ==="
echo

# Sample PR uncovered lines (simulating a coverage report)
# Using Thor tier definitions: TIER-1 (security/auth), TIER-2 (channel/lifecycle), TIER-3 (info)
# Note: Using actual repo paths (not fictional web/ subdirs)
SAMPLE_UNCOVERED=$(cat << 'EOF'
src/web/dashboard-auth.ts L10-30
src/aidefence-guard.ts:45-90
src/web/vault.ts L5-25
src/channel-provider.ts L100-120
src/web/channel-monitor.ts L100-150
src/web/agent-process.ts:200-220
src/db.ts L12-34
src/web/routes/messages.ts:80-120
src/web/routes/agents.ts L40-60
src/util/retry.ts L1-10
EOF
)

echo "Sample uncovered lines:"
echo "$SAMPLE_UNCOVERED"
echo

echo "Filtered output:"
FILTERED=$(echo "$SAMPLE_UNCOVERED" | "$FILTER_SCRIPT")
echo "$FILTERED"
echo

# Count and validate
TIER1_COUNT=$(echo "$FILTERED" | grep -c "^\[TIER-1\]" || true)
TIER2_COUNT=$(echo "$FILTERED" | grep -c "^\[TIER-2\]" || true)
TIER3_COUNT=$(echo "$FILTERED" | grep -c "^\[TIER-3\]" || true)

echo "Summary:"
echo "  TIER-1 (blocker) gaps: $TIER1_COUNT"
echo "  TIER-2 (flag) gaps: $TIER2_COUNT"
echo "  TIER-3 (info) gaps: $TIER3_COUNT"
echo

# Validation checks
EXPECTED_TIER1=4  # dashboard-auth, aidefence-guard, vault, routes/messages
EXPECTED_TIER2=4  # channel-provider, channel-monitor, agent-process, db
EXPECTED_TIER3=2  # routes/agents, util/retry

if [ "$TIER1_COUNT" -eq "$EXPECTED_TIER1" ]; then
  echo "✓ TIER-1 count correct ($TIER1_COUNT/$EXPECTED_TIER1)"
else
  echo "✗ TIER-1 count mismatch (expected $EXPECTED_TIER1, got $TIER1_COUNT)"
  exit 1
fi

if [ "$TIER2_COUNT" -eq "$EXPECTED_TIER2" ]; then
  echo "✓ TIER-2 count correct ($TIER2_COUNT/$EXPECTED_TIER2)"
else
  echo "✗ TIER-2 count mismatch (expected $EXPECTED_TIER2, got $TIER2_COUNT)"
  exit 1
fi

if [ "$TIER3_COUNT" -eq "$EXPECTED_TIER3" ]; then
  echo "✓ TIER-3 count correct ($TIER3_COUNT/$EXPECTED_TIER3)"
else
  echo "✗ TIER-3 count mismatch (expected $EXPECTED_TIER3, got $TIER3_COUNT)"
  exit 1
fi

echo
echo "=== All tests passed ==="
