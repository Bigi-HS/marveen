#!/bin/bash
# vault-lint-nightly-full.sh
# Phase 2 integration: Run vault-lint L2 + TM-1 executor in nightly heartbeat
# Called by: ~/.claude/scheduled-tasks/vault-lint-l2-nightly (applegate heartbeat)

set -e

MARVEEN_DIR="/home/domin/marveen"
SCRIPTS_DIR="$MARVEEN_DIR/scripts"

echo "=== Nightly vault-lint L2 + TM-1 executor ===" >&2

# Step 1: Run vault-lint Layer 2
echo "Step 1: Running vault-lint Layer 2..." >&2
cd "$MARVEEN_DIR"
python3 "$SCRIPTS_DIR/vault-lint-layer2.py" --json > /tmp/vl2-out.json 2>/tmp/vl2-err.txt

# Check if proposals were generated
if [ ! -f "$MARVEEN_DIR/store/vault-lint-l2-proposals.json" ]; then
  echo "ERROR: vault-lint-layer2.py did not generate proposals.json" >&2
  exit 1
fi

# Step 2: Run TM-1 executor (applies safe tier-migrations)
echo "Step 2: Running TM-1 executor..." >&2
python3 "$SCRIPTS_DIR/vault-lint-tm1-executor.py" 2>&1 || {
  echo "WARNING: TM-1 executor failed (non-critical for heartbeat)" >&2
}

echo "=== Nightly run complete ===" >&2
