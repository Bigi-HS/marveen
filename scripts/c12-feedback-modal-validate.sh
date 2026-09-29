#!/bin/bash
# C12 Feedback Modal Live-Verification Script (9644ed7c G6)
#
# Gate requirement (marveen 2026-09-29): the feedback-modal regex must be
# validated against a real pane capture from C12/Buster BEFORE production deploy.
# This script captures the pane, tests the regex, and stores evidence.
#
# Usage (run on C12/Buster when a real feedback modal appears):
#   bash scripts/c12-feedback-modal-validate.sh
#
# Prerequisites:
#   - Claude Code survey modal must be visible on the Buster pane
#   - Must be run from the project root
#   - Requires: tmux, node/tsx

set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STORE="${PROJECT_ROOT}/store"
EVIDENCE_DIR="${STORE}/incident-evidence"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
PANE_CAPTURE_FILE="${EVIDENCE_DIR}/c12-feedback-modal-live-${TIMESTAMP}.txt"
BUSTER_SESSION="agent-buster"

# The regex that must match a real modal (from src/pane-state.ts)
FEEDBACK_MODAL_RX="how is claude doing this session"
FEEDBACK_MODAL_TAIL_LINES=10

mkdir -p "$EVIDENCE_DIR"

echo "[c12-feedback-modal-validate] Capturing Buster pane..."
if ! PANE_OUTPUT=$(tmux capture-pane -p -t "=${BUSTER_SESSION}:" 2>/dev/null); then
  echo "ERROR: Could not capture ${BUSTER_SESSION} pane. Is the session running?"
  exit 1
fi

# Store the raw pane for evidence
echo "$PANE_OUTPUT" > "$PANE_CAPTURE_FILE"
echo "[c12-feedback-modal-validate] Pane captured to: $PANE_CAPTURE_FILE"

# Extract the last N lines (same logic as detectsFeedbackModal)
TAIL_LINES=$(echo "$PANE_OUTPUT" | tail -n "$FEEDBACK_MODAL_TAIL_LINES")

# Test the regex (case-insensitive)
if echo "$TAIL_LINES" | grep -qi "$FEEDBACK_MODAL_RX"; then
  echo "[c12-feedback-modal-validate] ✓ PASS: Regex correctly detected feedback modal in tail"

  # Store validation result
  echo "PASS: Regex detected feedback modal in last ${FEEDBACK_MODAL_TAIL_LINES} lines" \
    >> "${EVIDENCE_DIR}/c12-feedback-modal-live-${TIMESTAMP}-result.txt"

  echo ""
  echo "Evidence stored:"
  echo "  Pane capture: $PANE_CAPTURE_FILE"
  echo "  Validation result: ${EVIDENCE_DIR}/c12-feedback-modal-live-${TIMESTAMP}-result.txt"
  echo ""
  echo "Next: commit these files and reference in PR/gate as gate-verified."
  exit 0
else
  echo "[c12-feedback-modal-validate] ✗ FAIL: Regex did NOT detect modal in tail"
  echo "ERROR: Modal may not be rendering as expected, or regex needs adjustment"

  # Store failure evidence
  {
    echo "FAIL: Regex did not detect modal"
    echo ""
    echo "Last ${FEEDBACK_MODAL_TAIL_LINES} lines of pane:"
    echo "$TAIL_LINES"
  } >> "${EVIDENCE_DIR}/c12-feedback-modal-live-${TIMESTAMP}-result.txt"

  exit 1
fi
