#!/bin/bash
# vault-lint-nightly-full.sh
# Phase 2 integration: Run vault-lint L2 + TM-1 executor in nightly heartbeat
# Called by: ~/.claude/scheduled-tasks/vault-lint-l2-nightly (applegate heartbeat)
#
# FIX A (card 12e74f5e): unique per-run temp files (mktemp) + cleanup trap, so
# two overlapping runs (manual + ~23:00 nightly) can't clobber each other's temp.
# FIX B (card 12e74f5e): emit the DETERMINISTIC daily-log entry from the shell
# itself. It previously lived in the scheduled-task PROMPT (applegate heartbeat)
# and silently skipped whenever the heartbeat wasn't processed (sleep/wedge/token).
# The agent-interactive narrative inter-agent summary stays in the prompt.

set -e

MARVEEN_DIR="${MARVEEN_DIR:-/home/domin/marveen}"
SCRIPTS_DIR="$MARVEEN_DIR/scripts"
DASH_URL="${DASH_URL:-http://localhost:3420}"
PROPOSALS_JSON="$MARVEEN_DIR/store/vault-lint-l2-proposals.json"

# FIX A: unique temp files, cleaned up on exit.
VL2_OUT="$(mktemp "${TMPDIR:-/tmp}/vl2-out.XXXXXX.json")"
VL2_ERR="$(mktemp "${TMPDIR:-/tmp}/vl2-err.XXXXXX.txt")"
trap 'rm -f "$VL2_OUT" "$VL2_ERR"' EXIT

echo "=== Nightly vault-lint L2 + TM-1 executor ===" >&2

# Step 1: Run vault-lint Layer 2
echo "Step 1: Running vault-lint Layer 2..." >&2
cd "$MARVEEN_DIR"
python3 "$SCRIPTS_DIR/vault-lint-layer2.py" --json > "$VL2_OUT" 2> "$VL2_ERR"

# Check if proposals were generated
if [ ! -f "$PROPOSALS_JSON" ]; then
  echo "ERROR: vault-lint-layer2.py did not generate proposals.json" >&2
  exit 1
fi

# Step 2: Run TM-1 executor (applies safe tier-migrations)
echo "Step 2: Running TM-1 executor..." >&2
python3 "$SCRIPTS_DIR/vault-lint-tm1-executor.py" 2>&1 || {
  echo "WARNING: TM-1 executor failed (non-critical for heartbeat)" >&2
}

# Step 3 (FIX B): deterministic daily-log entry, emitted by the shell so it is
# guaranteed even when the applegate heartbeat does not process the prompt. The
# counts are data-driven from proposals.json; the agent-interactive narrative
# inter-agent summary (TM-2 FP caveat etc.) remains the prompt's responsibility.
TOKEN_FILE="$MARVEEN_DIR/store/.dashboard-token"
if [ -f "$PROPOSALS_JSON" ] && [ -f "$TOKEN_FILE" ]; then
  LOG_LINE="$(python3 - "$PROPOSALS_JSON" <<'PY'
import collections, json, sys
with open(sys.argv[1]) as fh:
    data = json.load(fh)
counts = data.get("counts", {})
tm = counts.get("tier_migration", 0)
dedup = counts.get("dedup_candidates", 0)
rules = collections.Counter(
    p.get("rule") for p in data.get("tier_migration_proposals", []) if p.get("rule")
)
tm_break = " ".join(f"{k}={rules[k]}" for k in sorted(rules)) or "-"
tops = sorted(
    (p.get("jaccard", 0) for p in data.get("dedup_candidates", [])), reverse=True
)[:3]
top_str = ", ".join(f"{j:.2f}" for j in tops) or "-"
print(
    f"## ~23:00 -- Nightly vault-lint L2 | TM={tm} ({tm_break}) "
    f"dedup={dedup} (top jaccard {top_str}) | auto/shell deterministic emit"
)
PY
)"
  TOKEN="$(cat "$TOKEN_FILE")"
  PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"agent_id":"applegate","content":sys.argv[1]}))' "$LOG_LINE")"
  if curl -s -X POST "$DASH_URL/api/daily-log" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" >/dev/null 2>&1; then
    echo "Step 3: daily-log entry emitted (deterministic)" >&2
  else
    echo "WARNING: daily-log POST failed (non-critical)" >&2
  fi
else
  echo "WARNING: proposals.json or dashboard-token missing; skipped daily-log emit" >&2
fi

echo "=== Nightly run complete ===" >&2
