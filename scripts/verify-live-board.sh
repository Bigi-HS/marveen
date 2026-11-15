#!/bin/bash
# verify-live-board.sh -- one-shot pre-GO snapshot combining three advisory sources.
#
# Mechanizes lesson-orchestrator-status-lag-verify-live-before-rebuild-1114:
# the orchestrator must never act on stale context; always fetch the live
# develop HEAD, gate status, and open kanban cards before any GO decision.
#
# Sections:
#   (1) DEVELOP HEAD  -- git fetch + log -1 --oneline origin/develop
#   (2) GATE          -- GET /api/gate/check via noa-api.py
#   (3) OPEN CARDS    -- GET /api/kanban, filter out status==done, print top rows
#
# Strictly READ-ONLY: no store/ writes, no POST endpoints, no mutations.
# Exit 0 always -- this is advisory, never a gate itself.
#
# Override NOA_API_CMD for testing (default: python3 <repo>/scripts/noa-api.py GET).
#
# Run: bash scripts/verify-live-board.sh

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
_TMP="$(mktemp -d)"
trap 'rm -rf "$_TMP"' EXIT

# Resolve the API GET command. Tests override NOA_API_CMD to inject a stub.
# Default delegates to the committed guard-safe helper (noa-api.py).
_api_get() {
  local endpoint="$1"
  if [ -n "${NOA_API_CMD:-}" ]; then
    $NOA_API_CMD "$endpoint"
  else
    python3 "$INSTALL_DIR/scripts/noa-api.py" GET "$endpoint"
  fi
}

echo "=== verify-live-board: pre-GO snapshot ==="
echo

# ---------------------------------------------------------------------------
# Section 1: DEVELOP HEAD
# ---------------------------------------------------------------------------
echo "--- (1) DEVELOP HEAD ---"
if git -C "$INSTALL_DIR" fetch -q origin develop 2>&1; then
  git -C "$INSTALL_DIR" log -1 --oneline origin/develop
else
  echo "git fetch: unavailable (offline or no remote)"
fi
echo

# ---------------------------------------------------------------------------
# Section 2: GATE
# ---------------------------------------------------------------------------
echo "--- (2) GATE ---"
gate_file="$_TMP/gate.json"
_api_get /api/gate/check > "$gate_file" 2>/dev/null && gate_rc=0 || gate_rc=$?
if [ $gate_rc -ne 0 ] || [ ! -s "$gate_file" ]; then
  echo "gate: unavailable"
else
  python3 - "$gate_file" <<'PY'
import sys, json
path = sys.argv[1]
try:
    with open(path) as f:
        d = json.load(f)
    status = d.get("status") or d.get("state") or d.get("result", "?")
    print("gate status:", status)
    for k, v in d.items():
        if k not in ("status", "state", "result") and not isinstance(v, (dict, list)):
            print(" ", k + ":", v)
except Exception:
    with open(path) as f:
        print(f.read())
PY
fi
echo

# ---------------------------------------------------------------------------
# Section 3: OPEN CARDS
# ---------------------------------------------------------------------------
echo "--- (3) OPEN CARDS ---"
kanban_file="$_TMP/kanban.json"
_api_get /api/kanban > "$kanban_file" 2>/dev/null && kanban_rc=0 || kanban_rc=$?
if [ $kanban_rc -ne 0 ] || [ ! -s "$kanban_file" ]; then
  echo "kanban: unavailable"
else
  python3 - "$kanban_file" <<'PY'
import sys, json
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
    if isinstance(data, list):
        cards = data
    elif isinstance(data, dict):
        cards = data.get("cards") or data.get("data") or []
    else:
        cards = []
    open_cards = [c for c in cards if c.get("status") != "done"]
    print("open cards:", len(open_cards))
    if open_cards:
        print("  {:<8}  {:<11}  {:<8}  {}".format("ID", "STATUS", "PRIORITY", "TITLE"))
        print("  {:<8}  {:<11}  {:<8}  {}".format("-"*8, "-"*11, "-"*8, "-"*50))
        for c in open_cards[:20]:
            cid      = str(c.get("id", ""))[:8]
            status   = str(c.get("status", ""))[:11]
            priority = str(c.get("priority", ""))[:8]
            title    = str(c.get("title", ""))[:50]
            print("  {:<8}  {:<11}  {:<8}  {}".format(cid, status, priority, title))
except Exception as e:
    sys.stderr.write("kanban parse error: {}\n".format(e))
    print("kanban: parse error (see stderr)")
PY
fi
echo

exit 0
