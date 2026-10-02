#!/bin/bash
# Unit harness for resolve_live_db() in fleet-supervisor.sh (card OPS/b7f9792b).
# resolve_live_db maps a NOA_DB_PATH override to a concrete DB path, falling back
# to $STORE/noa.db. The acceptance arm `case "$candidate" in "$INSTALL_DIR"/*.db)`
# uses a shell case-glob where `*` ALSO matches `/`, so an override pointing at the
# FROZEN legacy split-brain DB ($INSTALL_DIR/store/claudeclaw.db) was accepted --
# fail-open to stale data, contradicting the fn's own "never the default" contract
# (see lesson-shell-case-glob-star-matches-slash-1002). This harness pins the
# resolution for every override shape; the frozen-legacy cases are the fix target.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# Source the REAL supervisor (--dry-run returns before running the daemon); this
# defines resolve_live_db using the $INSTALL_DIR / $STORE globals, which we then
# repoint at a sandbox so the test is hermetic.
source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

INSTALL_DIR="/tmp/b7f-testroot"
STORE="$INSTALL_DIR/store"
DEFAULT="$STORE/noa.db"

# resolve <override> -> prints the resolved path (empty override = unset).
resolve() { NOA_DB_PATH="$1" resolve_live_db; }
eq() { # <desc> <override> <expected>
  local got; got="$(resolve "$2")"
  if [ "$got" = "$3" ]; then ok "$1"; else bad "$1 (override='$2' -> '$got', expected '$3')"; fi
}

# --- default / passthrough (must stay working) ------------------------------
eq "empty override -> noa.db default"                 ""                                   "$DEFAULT"
eq "whitespace-only override -> noa.db default"       "   "                                "$DEFAULT"
eq "relative store/noa.db -> accepted (live DB)"      "store/noa.db"                        "$INSTALL_DIR/store/noa.db"
eq "absolute in-root noa.db -> accepted"              "$INSTALL_DIR/store/noa.db"           "$INSTALL_DIR/store/noa.db"
eq "relative custom db under root -> accepted"        "store/experiment.db"                 "$INSTALL_DIR/store/experiment.db"

# --- traversal / outside-root (already rejected -> default) -----------------
eq "parent traversal -> default"                      "../evil.db"                          "$DEFAULT"
eq "absolute outside root -> default"                 "/etc/passwd.db"                      "$DEFAULT"
eq "bad suffix -> default"                            "store/noa.sqlite"                    "$DEFAULT"

# --- FIX TARGET: frozen legacy claudeclaw.db must NEVER be selectable --------
eq "relative claudeclaw.db -> default (NOT accepted)" "store/claudeclaw.db"                 "$DEFAULT"
eq "absolute in-root claudeclaw.db -> default"        "$INSTALL_DIR/store/claudeclaw.db"    "$DEFAULT"
eq "claudeclaw.db at root level -> default"           "claudeclaw.db"                       "$DEFAULT"
eq "nested claudeclaw.db -> default"                  "store/legacy/claudeclaw.db"          "$DEFAULT"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
