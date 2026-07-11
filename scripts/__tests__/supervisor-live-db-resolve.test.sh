#!/bin/bash
# Unit tests for resolve_live_db() and its use by agent_has_open_obligation in
# fleet-supervisor.sh (card 57480c07 / retire PR2).
#
# The idle-nudge obligation query used to read a hardcoded $STORE/claudeclaw.db.
# Post-cutover that file is the FROZEN legacy: agent_messages there is stale, so
# the watchdog was blind to live obligations (split-brain). resolve_live_db()
# mirrors resolveNoaDbPath (src/db-path.ts) / the python hooks: an explicit
# NOA_DB_PATH env override wins if it names a .db under the install root, else
# the STORE-relative live default (noa.db). The frozen db is never the default.
#
# Run: bash scripts/__tests__/supervisor-live-db-resolve.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
refute_contains() { if echo "$3" | grep -q "$2"; then fail "$1 (unexpected '$2' in '$3')"; else pass "$1"; fi; }

# Source the supervisor with an isolated store. The source-guard skips the daemon.
export FLEET_SUPERVISOR_STORE="$TMP/store"
mkdir -p "$FLEET_SUPERVISOR_STORE"
# Default-case tests must not inherit a caller's NOA_DB_PATH.
unset NOA_DB_PATH
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

# --- resolve_live_db: default (NOA_DB_PATH unset) -> STORE-relative noa.db ----
unset NOA_DB_PATH
assert_eq "unset -> STORE/noa.db" "$STORE/noa.db" "$(resolve_live_db)"
refute_contains "unset default is NOT the frozen legacy" "claudeclaw.db" "$(resolve_live_db)"

# --- resolve_live_db: blank / whitespace -> default --------------------------
export NOA_DB_PATH=""
assert_eq "blank -> STORE/noa.db" "$STORE/noa.db" "$(resolve_live_db)"
export NOA_DB_PATH="   "
assert_eq "whitespace -> STORE/noa.db" "$STORE/noa.db" "$(resolve_live_db)"

# --- resolve_live_db: valid relative override (the prod cutover value) --------
export NOA_DB_PATH="store/noa.db"
assert_eq "relative store/noa.db -> INSTALL_DIR/store/noa.db" "$INSTALL_DIR/store/noa.db" "$(resolve_live_db)"

# --- resolve_live_db: valid absolute override under install root -------------
export NOA_DB_PATH="$INSTALL_DIR/store/migrated.db"
assert_eq "absolute .db under root -> honored" "$INSTALL_DIR/store/migrated.db" "$(resolve_live_db)"

# --- resolve_live_db: non-.db suffix -> rejected, safe default ---------------
export NOA_DB_PATH="store/evil.txt"
assert_eq "non-.db suffix -> default" "$STORE/noa.db" "$(resolve_live_db)"

# --- resolve_live_db: parent-dir traversal -> rejected -----------------------
export NOA_DB_PATH="store/../../etc/passwd.db"
assert_eq "traversal -> default" "$STORE/noa.db" "$(resolve_live_db)"

# --- resolve_live_db: absolute path outside install root -> rejected ---------
export NOA_DB_PATH="/tmp/outside.db"
assert_eq "absolute outside root -> default" "$STORE/noa.db" "$(resolve_live_db)"

# --- integration: agent_has_open_obligation reads the LIVE db, not frozen ----
unset NOA_DB_PATH   # -> resolve_live_db == $STORE/noa.db
LIVE="$STORE/noa.db"
FROZEN="$STORE/claudeclaw.db"
now=$(date +%s)

seed_db() {
  # $1=path $2=to_agent $3=status $4=created_at
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import sqlite3, sys
path, to_agent, status, created = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
con = sqlite3.connect(path)
con.execute("""CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, to_agent TEXT, status TEXT,
    completed_at INTEGER, created_at INTEGER)""")
con.execute("INSERT INTO agent_messages (to_agent, status, completed_at, created_at) VALUES (?,?,NULL,?)",
            (to_agent, status, created))
con.commit(); con.close()
PY
}

# Open obligation lives in the LIVE db -> function must see it.
rm -f "$LIVE" "$FROZEN"
seed_db "$LIVE" "testagent" "delivered" "$now"
agent_has_open_obligation "testagent"; assert_eq "open obligation in live noa.db -> detected" 0 "$?"

# Obligation ONLY in the frozen legacy, live db empty -> function must NOT see it
# (proves the query is keyed to noa.db, not claudeclaw.db).
rm -f "$LIVE" "$FROZEN"
seed_db "$LIVE" "testagent" "done" "$now"          # live: a completed (non-open) row
python3 - "$LIVE" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("UPDATE agent_messages SET completed_at=1 WHERE to_agent='testagent'")
con.commit(); con.close()
PY
seed_db "$FROZEN" "testagent" "delivered" "$now"   # frozen: an OPEN row that must be ignored
agent_has_open_obligation "testagent"; assert_eq "open obligation only in frozen db -> NOT detected" 1 "$?"

# Stale obligation outside the lookback window -> not counted.
rm -f "$LIVE" "$FROZEN"
seed_db "$LIVE" "testagent" "delivered" "$(( now - IDLE_NUDGE_LOOKBACK_SECONDS - 100 ))"
agent_has_open_obligation "testagent"; assert_eq "obligation older than lookback -> not detected" 1 "$?"

# --- TOTAL -------------------------------------------------------------------
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
else
  echo "$FAIL FAILED"
  exit 1
fi
