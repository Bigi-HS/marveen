#!/bin/bash
# N2 adversarial fixture: fleet_wedge_sweep mktemp -d failure guard (card 66ee9265).
#
# Adversarial contract (assertion-direction-check):
#   DANGEROUS direction: mktemp -d fails -> sweep_tmp="" -> pane writes go to
#   /$n (filesystem root) and trap "rm -rf ''" is set. Silent success is wrong.
#   SAFE direction: guard detects failure -> log error -> return non-zero -> no
#   pane capture, no filesystem writes outside tmp.
#
# ADV-N2-1: mktemp -d failure -> function returns non-zero (fail-closed).
# ADV-N2-2: mktemp -d failure -> no pane capture attempted (tmux not called).
# ADV-N2-3: mktemp -d failure -> error logged (not silent).
# ADV-N2-4: happy-path (mktemp succeeds) -> sweep runs normally (regression check).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/store/.fleet-supervisor"
INSTALL_DIR="$TMP"; STORE="$TMP/store"; STATE_DIR="$TMP/store/.fleet-supervisor"
DRY_RUN=0
CURL=""
# Override TMUX_BIN to our mock name so function lookup fires (not PATH binary).
TMUX_BIN=mock_tmux

RF="$TMP/sweeplog"
TMUX_CALL_FILE="$TMP/tmux-calls"
log() { printf '%s\n' "$*" >> "$RF"; }

session_alive()     { return 0; }
is_sleep_eligible() { return 1; }
resolve_live_db()   { printf '%s' "$TMP/noa.db"; }
sg_should_wake()    { return 1; }

# File-based call tracker: subshell modifications don't propagate via variables,
# but appending to a file does persist. Each capture-pane call appends one line.
mock_tmux() {
  case "$*" in
    *capture-pane*) printf 'call\n' >> "$TMUX_CALL_FILE"; printf 'normal idle\n' ;;
    *) return 0 ;;
  esac
}

run_sweep() {
  : > "$RF"
  : > "$TMUX_CALL_FILE"
  rm -f "$STATE_DIR/fleet-wedge-sweep.last"
  fleet_wedge_sweep
}

export FLEET_TEST_SWEEP_AGENTS="alpha"

# --- ADV-N2-1..3: override mktemp to simulate failure ---
mktemp() { return 1; }

run_sweep
RC=$?

# ADV-N2-1: fail-closed (non-zero return)
if [ "$RC" -ne 0 ]; then ok "ADV-N2-1: mktemp failure -> fleet_wedge_sweep returns non-zero (fail-closed)"
else bad "ADV-N2-1: mktemp failure -> sweep returned 0 (silent pass-through, DANGEROUS)"; fi

# ADV-N2-2: no pane capture (no mock_tmux call after early return)
tmux_calls=$(wc -l < "$TMUX_CALL_FILE" 2>/dev/null || echo 0)
tmux_calls="${tmux_calls// /}"
if [ "$tmux_calls" -eq 0 ]; then ok "ADV-N2-2: mktemp failure -> no capture-pane call (early return before loop)"
else bad "ADV-N2-2: capture-pane called $tmux_calls time(s) despite mktemp failure (loop ran, DANGEROUS)"; fi

# ADV-N2-3: error logged (not silent)
if grep -q "mktemp" "$RF" 2>/dev/null; then ok "ADV-N2-3: mktemp failure -> error logged (not silent)"
else bad "ADV-N2-3: mktemp failure -> no error log entry (silent failure)"; fi

# --- ADV-N2-4: restore mktemp; happy-path still works ---
unset -f mktemp

run_sweep
RC_OK=$?
calls_ok=$(wc -l < "$TMUX_CALL_FILE" 2>/dev/null || echo 0)
calls_ok="${calls_ok// /}"
if [ "$RC_OK" -eq 0 ] && [ "$calls_ok" -gt 0 ]; then
  ok "ADV-N2-4: happy-path (real mktemp) -> sweep runs (tmux calls=$calls_ok, rc=$RC_OK)"
else
  bad "ADV-N2-4: happy-path broken after fix (tmux calls=$calls_ok, rc=$RC_OK)"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
