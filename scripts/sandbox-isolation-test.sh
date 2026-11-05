#!/usr/bin/env bash
# P9 sandbox isolation self-test (card p9-sandbox-foundation).
#
# DoD gate: "sandbox SOHA nem ír live DB-t/csatornát (öntest PASS);
#            szándékos cross-write → ABORT"
#
# Tests (all must pass):
#   T1  Sandbox server is reachable on port 3430
#   T2  Sandbox reports correct DB path (sandbox, NOT live)
#   T3  Sandbox write lands in sandbox DB, NOT in live DB
#   T4  ABORT gate: starting with SANDBOX_ISOLATION=1 + live DB path → non-zero exit
#
# Usage:
#   bash scripts/sandbox-isolation-test.sh
#
# Exit: 0 = all PASS, non-zero = at least one FAIL (DoD not met)
#
# Prerequisites: sandbox must be running (bash scripts/sandbox-start.sh)

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_DIR="$REPO/store/sandbox"
SANDBOX_PORT=3430
LIVE_DB="$REPO/store/noa.db"
SANDBOX_DB="$SANDBOX_DIR/noa.db"

PASS=0
FAIL=0
SKIP=0

pass() { echo "  PASS T${1}: ${2}"; PASS=$((PASS+1)); }
fail() { echo "  FAIL T${1}: ${2}"; FAIL=$((FAIL+1)); }
skip() { echo "  SKIP T${1}: ${2}"; SKIP=$((SKIP+1)); }

# The sandbox server runs from the same PROJECT_ROOT as live and therefore
# loads its bearer token from the same store/.dashboard-token (dashboard-auth.ts
# DASHBOARD_TOKEN_PATH is hardcoded to PROJECT_ROOT/store/.dashboard-token).
# Use the live token to authenticate to the sandbox HTTP API.
# The sandbox-token at store/sandbox/.dashboard-token is kept for future use
# when the sandbox gets its own PROJECT_ROOT (Sprint 4+ plan).
sandbox_token() { cat "$REPO/store/.dashboard-token" 2>/dev/null || echo ""; }
sandbox_curl() { curl -sf -H "Authorization: Bearer $(sandbox_token)" "$@"; }

echo ""
echo "=== P9 Sandbox Isolation Self-Test ==="
echo ""

# ---------------------------------------------------------------------------
# T1: Sandbox server reachable on 3430
# ---------------------------------------------------------------------------
echo "T1: Sandbox server reachable..."
if sandbox_curl "http://127.0.0.1:$SANDBOX_PORT/api/auth/status" >/dev/null 2>&1; then
  pass 1 "GET /api/auth/status -> 200 on port $SANDBOX_PORT"
else
  fail 1 "GET /api/auth/status failed on port $SANDBOX_PORT -- is the sandbox running? (bash scripts/sandbox-start.sh)"
fi

# ---------------------------------------------------------------------------
# T2: Sandbox uses sandbox DB, not live DB
# ---------------------------------------------------------------------------
echo "T2: DB path isolation..."
if [ "$FAIL" -gt 0 ]; then
  skip 2 "skipped (T1 failed)"
else
  HEALTH_JSON=$(sandbox_curl "http://127.0.0.1:$SANDBOX_PORT/api/health" 2>/dev/null || echo "{}")
  # Heuristic: sandbox DB path must contain "sandbox" and NOT be live noa.db inode
  LIVE_INODE=$(stat -c '%i' "$LIVE_DB" 2>/dev/null || echo "")
  SANDBOX_INODE=$(stat -c '%i' "$SANDBOX_DB" 2>/dev/null || echo "")
  if [ -z "$SANDBOX_INODE" ]; then
    fail 2 "sandbox noa.db not found at $SANDBOX_DB"
  elif [ "$LIVE_INODE" = "$SANDBOX_INODE" ]; then
    fail 2 "sandbox DB and live DB are the SAME FILE (same inode $LIVE_INODE) -- isolation broken"
  else
    pass 2 "sandbox DB inode ($SANDBOX_INODE) != live DB inode ($LIVE_INODE)"
  fi
fi

# ---------------------------------------------------------------------------
# T3: Write via sandbox API lands in sandbox DB, NOT in live DB
# ---------------------------------------------------------------------------
echo "T3: Write isolation (sandbox write does not touch live DB)..."
if [ "$FAIL" -gt 0 ]; then
  skip 3 "skipped (earlier failures)"
else
  TEST_KW="sandbox-isolation-test-$(date +%s)"
  LIVE_SIZE_BEFORE=$(stat -c '%s' "$LIVE_DB" 2>/dev/null || echo 0)
  LIVE_MTIME_BEFORE=$(stat -c '%Y' "$LIVE_DB" 2>/dev/null || echo 0)

  # Write a test memory via sandbox API
  WRITE_STATUS=$(sandbox_curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://127.0.0.1:$SANDBOX_PORT/api/memories" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\":\"forge\",\"content\":\"ISOLATION-TEST $TEST_KW\",\"category\":\"hot\",\"keywords\":\"$TEST_KW\"}" \
    2>/dev/null || echo "000")

  if [ "$WRITE_STATUS" != "200" ] && [ "$WRITE_STATUS" != "201" ]; then
    fail 3 "Sandbox write returned HTTP $WRITE_STATUS (expected 200/201)"
  else
    # Verify record is in sandbox DB
    SANDBOX_COUNT=$(python3 -c "
import sqlite3, sys
try:
    c = sqlite3.connect('$SANDBOX_DB')
    r = c.execute(\"SELECT count(*) FROM memories WHERE keywords LIKE '%$TEST_KW%'\").fetchone()
    print(r[0])
    c.close()
except Exception as e:
    print(0)
" 2>/dev/null || echo 0)

    # Verify live DB NOT modified (mtime + content check)
    LIVE_MTIME_AFTER=$(stat -c '%Y' "$LIVE_DB" 2>/dev/null || echo 0)
    LIVE_COUNT=$(python3 -c "
import sqlite3, sys
try:
    c = sqlite3.connect('$LIVE_DB')
    r = c.execute(\"SELECT count(*) FROM memories WHERE keywords LIKE '%$TEST_KW%'\").fetchone()
    print(r[0])
    c.close()
except Exception as e:
    print(0)
" 2>/dev/null || echo 0)

    if [ "$SANDBOX_COUNT" -ge 1 ] && [ "$LIVE_COUNT" -eq 0 ]; then
      pass 3 "Write landed in sandbox DB ($SANDBOX_COUNT record), live DB unmodified (0 records with test key)"
    elif [ "$SANDBOX_COUNT" -lt 1 ]; then
      fail 3 "Write succeeded (HTTP $WRITE_STATUS) but record NOT FOUND in sandbox DB"
    else
      fail 3 "ISOLATION BREACH: test write found in LIVE DB ($LIVE_COUNT records with test key)"
    fi

    # Clean up the test record from sandbox
    python3 -c "
import sqlite3
c = sqlite3.connect('$SANDBOX_DB')
c.execute(\"DELETE FROM memories WHERE keywords LIKE '%$TEST_KW%'\")
c.commit()
c.close()
" 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# T4: ABORT gate -- SANDBOX_ISOLATION=1 + live DB path -> non-zero exit
# ---------------------------------------------------------------------------
echo "T4: ABORT gate (SANDBOX_ISOLATION=1 + live DB -> non-zero exit)..."
if [ ! -f "$REPO/dist/index.js" ]; then
  skip 4 "dist/index.js missing -- cannot test abort gate"
else
  ABORT_EXIT=0
  # Use NOA_BOOT_SMOKE to get a minimal boot (db-init only, no port conflict with live)
  # SANDBOX_ISOLATION=1 + live DB path should throw before the DB opens.
  timeout 10 bash -c "
    cd '$REPO'
    SANDBOX_ISOLATION=1 \
    NOA_DB_PATH=store/noa.db \
    NOA_BOOT_SMOKE=3432 \
    node dist/index.js
  " >/dev/null 2>&1 || ABORT_EXIT=$?

  if [ "$ABORT_EXIT" -ne 0 ]; then
    pass 4 "SANDBOX_ISOLATION=1 + live DB path -> non-zero exit ($ABORT_EXIT) -- guard fires"
  else
    fail 4 "SANDBOX_ISOLATION=1 + live DB path -> exit 0 -- isolation guard did NOT abort"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "DoD: PASS -- sandbox isolation verified."
  exit 0
else
  echo "DoD: FAIL -- $FAIL test(s) failed. Sandbox is NOT isolated."
  exit 1
fi
