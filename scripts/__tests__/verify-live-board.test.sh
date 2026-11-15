#!/bin/bash
# Tests for scripts/verify-live-board.sh (card 062f1a04).
#
# Verifies the pre-GO snapshot tool is strictly read-only and advisory:
#   - OPEN CARDS section excludes done cards and includes open ones
#   - Script exits 0 even when the gate source is unavailable (empty/non-zero)
#   - Script exits 0 even when both API sources are unavailable
#
# Stubs the noa-api.py call via the NOA_API_CMD env override so no live
# dashboard is needed and no token is read.
#
# Run: bash scripts/__tests__/verify-live-board.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/verify-live-board.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

[ -f "$SCRIPT" ] || { echo "FATAL: $SCRIPT missing"; exit 1; }

# ---------------------------------------------------------------------------
# Fixture kanban JSON: mix of done + open cards
# ---------------------------------------------------------------------------
KANBAN_FIXTURE='[
  {"id": "aabbccdd1122", "status": "done",        "priority": "normal", "title": "Finished task that must be excluded"},
  {"id": "11223344aabb", "status": "in_progress",  "priority": "high",   "title": "Active work item"},
  {"id": "deadbeef5678", "status": "planned",      "priority": "urgent", "title": "Planned card to show"},
  {"id": "cafebabe9012", "status": "waiting",      "priority": "low",    "title": "Waiting on dependency"}
]'

# ---------------------------------------------------------------------------
# Stub factories
# ---------------------------------------------------------------------------

# make_api_stub <dir> <kanban_body> <gate_body> <gate_rc>
#   Creates $dir/api-stub.sh that is used as NOA_API_CMD.
#   The stub prints kanban_body for /api/kanban, gate_body for /api/gate/check.
#   gate_rc controls the exit code for the gate endpoint.
make_api_stub() {
  local dir="$1" kanban_body="$2" gate_body="$3" gate_rc="$4"
  mkdir -p "$dir"
  # Write fixture files so the stub can cat them (avoids quoting headaches)
  printf '%s' "$kanban_body" > "$dir/kanban.json"
  printf '%s' "$gate_body"   > "$dir/gate.json"
  printf '%d' "$gate_rc"     > "$dir/gate.rc"
  cat > "$dir/stub.sh" <<'STUB'
#!/bin/bash
DIR="$(dirname "$0")"
endpoint="$1"
case "$endpoint" in
  /api/kanban*)
    cat "$DIR/kanban.json"
    exit 0
    ;;
  /api/gate/check*)
    cat "$DIR/gate.json"
    exit "$(cat "$DIR/gate.rc")"
    ;;
  *)
    exit 1
    ;;
esac
STUB
  chmod +x "$dir/stub.sh"
}

# ---------------------------------------------------------------------------
# Test 1: OPEN CARDS excludes 'done', includes in_progress/planned/waiting
# ---------------------------------------------------------------------------
echo "--- Test 1: OPEN CARDS filters out done cards ---"
STUB1="$TMP/stub1"
make_api_stub "$STUB1" "$KANBAN_FIXTURE" '{"status":"pass"}' 0

out=$(NOA_API_CMD="bash $STUB1/stub.sh" bash "$SCRIPT" 2>/dev/null)
rc=$?

[ "$rc" -eq 0 ] && pass "exit 0 with healthy stubs" || fail "exit non-zero ($rc) with healthy stubs"

# done card must NOT appear
if echo "$out" | grep -q "Finished task that must be excluded"; then
  fail "OPEN CARDS section contains the done card (should be excluded)"
else
  pass "done card is excluded from OPEN CARDS"
fi

# open cards must appear
if echo "$out" | grep -q "Active work item"; then
  pass "in_progress card present in OPEN CARDS"
else
  fail "in_progress card missing from OPEN CARDS"
fi

if echo "$out" | grep -q "Planned card to show"; then
  pass "planned card present in OPEN CARDS"
else
  fail "planned card missing from OPEN CARDS"
fi

if echo "$out" | grep -q "Waiting on dependency"; then
  pass "waiting card present in OPEN CARDS"
else
  fail "waiting card missing from OPEN CARDS"
fi

# count line must say 3 (3 open cards)
if echo "$out" | grep -q "open cards: 3"; then
  pass "open card count is 3"
else
  fail "open card count line missing or wrong (expected 'open cards: 3')"
fi
echo

# ---------------------------------------------------------------------------
# Test 2: exit 0 when gate returns empty (unavailable)
# ---------------------------------------------------------------------------
echo "--- Test 2: exit 0 when gate unavailable (empty body, non-zero rc) ---"
STUB2="$TMP/stub2"
make_api_stub "$STUB2" "$KANBAN_FIXTURE" '' 1

out2=$(NOA_API_CMD="bash $STUB2/stub.sh" bash "$SCRIPT" 2>/dev/null)
rc2=$?

[ "$rc2" -eq 0 ] && pass "exit 0 when gate is unavailable" || fail "exit non-zero ($rc2) when gate unavailable"

if echo "$out2" | grep -q "gate: unavailable"; then
  pass "GATE section prints 'gate: unavailable' when endpoint fails"
else
  fail "GATE section did not print 'gate: unavailable'"
fi
echo

# ---------------------------------------------------------------------------
# Test 3: exit 0 when BOTH kanban and gate are unavailable
# ---------------------------------------------------------------------------
echo "--- Test 3: exit 0 when all API sources unavailable ---"
STUB3="$TMP/stub3"
make_api_stub "$STUB3" '' '' 1
# Override kanban stub to also fail
cat > "$STUB3/stub.sh" <<'STUB'
#!/bin/bash
# All endpoints fail
exit 1
STUB
chmod +x "$STUB3/stub.sh"

out3=$(NOA_API_CMD="bash $STUB3/stub.sh" bash "$SCRIPT" 2>/dev/null)
rc3=$?

[ "$rc3" -eq 0 ] && pass "exit 0 when all sources unavailable" || fail "exit non-zero ($rc3) when all sources unavailable"

if echo "$out3" | grep -q "gate: unavailable"; then
  pass "GATE: unavailable when endpoint fails"
else
  fail "GATE section missing 'unavailable' message"
fi

if echo "$out3" | grep -q "kanban: unavailable"; then
  pass "KANBAN: unavailable when endpoint fails"
else
  fail "KANBAN section missing 'unavailable' message"
fi
echo

# ---------------------------------------------------------------------------
# Test 4: bash -n syntax check
# ---------------------------------------------------------------------------
echo "--- Test 4: syntax check ---"
bash -n "$SCRIPT" && pass "syntax check passes" || fail "syntax check failed"
echo

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [ "$FAIL" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "$FAIL TEST(S) FAILED"
  exit 1
fi
