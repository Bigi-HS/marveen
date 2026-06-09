#!/bin/bash
# Unit tests for promote-on-drift in fleet-supervisor.sh `reconcile_agent_creds`.
#
# Background: every sub-agent symlinks its .credentials.json to the single main
# token. When a sub-agent's Claude refreshes, atomic-rename replaces that symlink
# with a fresh STANDALONE file ("drift"). The old reconcile just re-linked the
# agent back to main, DISCARDING the fresh token -- so the fleet rode the expired
# main token until something else refreshed it (the 2026-06-08 outage). The fix
# PROMOTES a drifted token UP to main when it is newer, then re-links.
#
# These tests source the supervisor (the `BASH_SOURCE == $0` guard keeps the
# daemon loop from running) with the cred paths pointed at a temp dir via
# FLEET_MAIN_CRED / FLEET_AGENTS_DIR, then drive reconcile_agent_creds directly.
#
# Run: bash scripts/__tests__/reconcile-creds-promote.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

MAIN="$TMP/home/.claude/.credentials.json"
AGENTS="$TMP/agents"
export FLEET_SUPERVISOR_STORE="$TMP/store"
export FLEET_MAIN_CRED="$MAIN"
export FLEET_AGENTS_DIR="$AGENTS"

# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

# Capture reconcile's log output AFTER sourcing so our definition wins.
CAPTURE="$TMP/log.txt"
log() { echo "$*" >> "$CAPTURE"; }

# Helpers -------------------------------------------------------------------
mkcred()    { mkdir -p "$(dirname "$1")"; printf '{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":%s}}\n' "$2" > "$1"; }
mkcorrupt() { mkdir -p "$(dirname "$1")"; printf 'not-json-at-all' > "$1"; }
agentcred() { echo "$AGENTS/$1/.claude-config/.credentials.json"; }
reset()     { rm -rf "$AGENTS" "$TMP/home"; mkdir -p "$(dirname "$MAIN")"; : > "$CAPTURE"; }
is_symlink_to_main() { [ -L "$1" ] && [ "$(readlink "$1")" = "$MAIN" ]; }

# --- Case 1: drifted standalone NEWER than main -> promoted -----------------
reset
mkcred "$MAIN" 1000
mkcred "$(agentcred alpha)" 5000   # standalone, newer
reconcile_agent_creds
assert_eq "newer drift promoted to main"        5000 "$(cred_expires_at "$MAIN")"
is_symlink_to_main "$(agentcred alpha)" && pass "alpha re-linked to main" || fail "alpha re-linked to main"
grep -q "promoted to main" "$CAPTURE" && pass "logs promotion" || fail "logs promotion"
ls "$(agentcred alpha)".drift-* >/dev/null 2>&1 && pass "drift backup written" || fail "drift backup written"

# --- Case 2: drifted standalone OLDER than main -> NOT promoted -------------
reset
mkcred "$MAIN" 9000
mkcred "$(agentcred beta)" 2000    # standalone, older
reconcile_agent_creds
assert_eq "older drift does NOT change main"    9000 "$(cred_expires_at "$MAIN")"
is_symlink_to_main "$(agentcred beta)" && pass "beta re-linked to main" || fail "beta re-linked to main"
grep -q "not newer" "$CAPTURE" && pass "logs not-newer" || fail "logs not-newer"

# --- Case 3: already-correct symlink -> untouched (no promote, no backup) ---
reset
mkcred "$MAIN" 4000
mkdir -p "$(dirname "$(agentcred gamma)")"
ln -sf "$MAIN" "$(agentcred gamma)"
reconcile_agent_creds
assert_eq "main unchanged for correct symlink"  4000 "$(cred_expires_at "$MAIN")"
ls "$(agentcred gamma)".drift-* >/dev/null 2>&1 && fail "no backup for correct symlink" || pass "no backup for correct symlink"
[ -s "$CAPTURE" ] && fail "no log for correct symlink" || pass "no log for correct symlink"

# --- Case 4: main corrupt + valid drifted token -> promoted (healing) -------
reset
mkcorrupt "$MAIN"
mkcred "$(agentcred delta)" 7000
reconcile_agent_creds
assert_eq "valid drift heals corrupt main"      7000 "$(cred_expires_at "$MAIN")"
is_symlink_to_main "$(agentcred delta)" && pass "delta re-linked after heal" || fail "delta re-linked after heal"

# --- Case 5: drifted token itself corrupt -> NOT promoted, still re-linked --
reset
mkcred "$MAIN" 6000
mkcorrupt "$(agentcred epsilon)"
reconcile_agent_creds
assert_eq "corrupt drift does NOT change main"  6000 "$(cred_expires_at "$MAIN")"
is_symlink_to_main "$(agentcred epsilon)" && pass "epsilon re-linked despite corrupt" || fail "epsilon re-linked despite corrupt"

# --- Case 6: two drifted agents -> main converges to the NEWEST -------------
reset
mkcred "$MAIN" 1000
mkcred "$(agentcred a_low)"  3000
mkcred "$(agentcred z_high)" 8000
reconcile_agent_creds
assert_eq "main converges to newest of many"    8000 "$(cred_expires_at "$MAIN")"
is_symlink_to_main "$(agentcred a_low)"  && pass "a_low re-linked"  || fail "a_low re-linked"
is_symlink_to_main "$(agentcred z_high)" && pass "z_high re-linked" || fail "z_high re-linked"

# --- Case 7: main missing -> safe no-op (cannot promote without a target) ---
reset
rm -f "$MAIN"
mkcred "$(agentcred zeta)" 5000
reconcile_agent_creds
[ -e "$MAIN" ] && fail "main missing stays absent" || pass "main missing stays absent (no-op)"

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; else echo "$FAIL FAILURE(S)"; fi
exit "$FAIL"
