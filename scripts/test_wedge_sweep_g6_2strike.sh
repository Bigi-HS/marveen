#!/bin/bash
# c12-equivalent logic harness for fleet_wedge_sweep() G6 2-strike persistence
# + auto-dismiss wiring (cards b0e189fb / OPS-232 + e167dd08).
#
# Current code: survey pane -> immediate G6 flag (no persistence, no dismiss).
# After fix:
#   - 1st G6 detection  : record $STATE_DIR/strike-g6-<n>, no flag
#   - 2nd consecutive   : inbox drain check -> if backed-up + modal re-confirmed -> send-keys 0 + dismissed
#   - non-consecutive   : healthy pane between strikes resets the counter
#   - inbox draining    : suppress on 2nd strike (agent healthy despite modal)
#   - stale strike file : treated as 1st strike (window exceeded)
#   - auto-dismiss TOCTOU: re-verify before send-keys; skip if modal already cleared
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# Source the REAL supervisor (--dry-run returns before running the daemon).
source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/store/.fleet-supervisor"
# INSTALL_DIR=$TMP -> classify_cli path absent -> degraded fallback (bare-substring)
INSTALL_DIR="$TMP"; STORE="$TMP/store"; STATE_DIR="$TMP/store/.fleet-supervisor"
DRY_RUN=0
CURL=""                   # no alert delivery (avoids real network)
TMUX_BIN=mock_tmux
# Exercise the ACTIVATED detector-common path (card 9644ed7c). The migration ships
# inert behind this flag; cases (g)-(p) assert the flag=1 shared-helper behaviour
# (strike-g6-<n> filenames, confirmed-latch). Case (q) flips it to 0 to prove the
# inert default preserves the exact legacy inline behaviour.
export DETECTOR_COMMON_ENABLED=1

SEND_KEYS_FILE="$TMP/sendkeys"

RF="$TMP/sweeplog"
log() { printf '%s\n' "$*" >> "$RF"; }

session_alive()    { return 0; }
is_sleep_eligible(){ return 1; }
resolve_live_db()  { printf '%s' "$TMP/noa.db"; }

# g6_inbox_draining mock: MOCK_DRAINING=1 -> agent is draining (healthy).
MOCK_DRAINING=0
g6_inbox_draining() { [ "$MOCK_DRAINING" = "1" ]; }

# Pane text: stored per agent in $TMP/pane-<name> for fine-grained control.
SURVEY_TEXT="$(printf 'How is Claude doing this session?\nShare feedback\n')"
IDLE_TEXT="$(printf 'normal idle\n> ')"

pane_survey()  { printf '%s\n' "$SURVEY_TEXT" > "$TMP/pane-$1"; }
pane_healthy() { printf '%s\n' "$IDLE_TEXT"   > "$TMP/pane-$1"; }

mock_tmux() {
  # Extract agent name from '=agent-<n>:0.0' positional arg (must iterate "$@",
  # not parse "$*" -- ${*#...} strips per-arg and rejoins, so the prefix-strip
  # leaves ALL positional params not just the matching one).
  local _n="" _arg
  for _arg in "$@"; do
    case "$_arg" in =agent-*) _n="${_arg#=agent-}"; _n="${_n%%:*}" ;; esac
  done
  case "$1" in
    has-session) return 0 ;;
    capture-pane)
      local _pf="$TMP/pane-${_n:-_none}"
      [ -f "$_pf" ] && cat "$_pf" || printf '%s\n' "$IDLE_TEXT" ;;
    send-keys)
      # File-based counter (survives subshell, lesson from 66ee9265).
      printf '%s\n' "$*" >> "$SEND_KEYS_FILE" ;;
    *) return 0 ;;
  esac
}

run_sweep() {
  : > "$RF"
  rm -f "$STATE_DIR/fleet-wedge-sweep.last"
  fleet_wedge_sweep
}
summary()       { tr '\n' ' ' < "$RF"; }
sk_count()      { [ -f "$SEND_KEYS_FILE" ] && wc -l < "$SEND_KEYS_FILE" || echo 0; }

# ==========================================================================
# (g) First G6 detection: NOT flagged, strike file created
# ==========================================================================
export FLEET_TEST_SWEEP_AGENTS="g6alpha"
pane_survey g6alpha
: > "$SEND_KEYS_FILE"
run_sweep
S="$(summary)"

case "$S" in
  *"g6alpha:G6"*) bad "(g1) 1st G6 strike should NOT be flagged yet (got: $S)" ;;
  *)              ok  "(g1) 1st G6 strike: no flag" ;;
esac
if [ -f "$STATE_DIR/strike-g6-g6alpha" ]; then
  ok  "(g2) 1st G6 strike: state file created"
else
  bad "(g2) 1st G6 strike: state file NOT created"
fi
SK=$(sk_count)
[ "$SK" -eq 0 ] && ok "(g3) 1st G6 strike: no send-keys called" || bad "(g3) 1st G6 strike: spurious send-keys (got: $SK)"

# ==========================================================================
# (h) Second consecutive G6 + inbox NOT draining: auto-dismiss + dismissed list
# ==========================================================================
: > "$SEND_KEYS_FILE"
run_sweep
S="$(summary)"

case "$S" in
  # Check dismissed FIRST: "dismissed:g6alpha:G6" also contains "g6alpha:G6"
  # as a substring; dismissed must win over the raw-G6-wedge pattern.
  *"dismissed:"*"g6alpha:G6"*) ok "(h1) 2nd strike: appears in dismissed list" ;;
  *"wedged:"*"g6alpha:G6"*) bad "(h1) 2nd strike should be dismissed, not raw wedged (got: $S)" ;;
  *) bad "(h1) 2nd strike: g6alpha missing from summary (got: $S)" ;;
esac
SK=$(sk_count)
[ "$SK" -gt 0 ] && ok "(h2) 2nd strike: send-keys 0 called ($SK)" || bad "(h2) 2nd strike: send-keys NOT called"
[ ! -f "$STATE_DIR/strike-g6-g6alpha" ] && ok "(h3) 2nd strike: strike file cleaned up" || bad "(h3) 2nd strike: strike file should be removed"

# ==========================================================================
# (i) G6 -> healthy pane -> G6 again: counter reset, 3rd detection = 1st strike
# ==========================================================================
# Set pane to healthy first (clears strike).
pane_healthy g6alpha
run_sweep
[ ! -f "$STATE_DIR/strike-g6-g6alpha" ] && ok "(i1) healthy pane: strike file removed" || bad "(i1) healthy pane: strike file should be gone"

# Now G6 again -> must be 1st strike (NOT flagged).
pane_survey g6alpha
: > "$SEND_KEYS_FILE"
run_sweep
S="$(summary)"
case "$S" in
  *"g6alpha:G6"*|*"dismissed:"*"g6alpha"*) bad "(i2) re-detected G6 after clear: should be 1st strike again (got: $S)" ;;
  *) ok "(i2) re-detected G6 after clear: 1st strike, no flag" ;;
esac
SK=$(sk_count)
[ "$SK" -eq 0 ] && ok "(i3) no send-keys on re-1st strike" || bad "(i3) send-keys on re-1st strike (got: $SK)"

# ==========================================================================
# (j) Second strike but inbox draining: suppress, no send-keys
# ==========================================================================
# Ensure strike file exists from the previous test (it was 1st strike above).
[ -f "$STATE_DIR/strike-g6-g6alpha" ] || printf '%s\n' "$(( $(date +%s) - 10 ))" > "$STATE_DIR/strike-g6-g6alpha"
MOCK_DRAINING=1
: > "$SEND_KEYS_FILE"
run_sweep
S="$(summary)"
MOCK_DRAINING=0

case "$S" in
  *"g6alpha"*) bad "(j1) 2nd strike + draining: should be suppressed (got: $S)" ;;
  *)           ok  "(j1) 2nd strike + inbox draining: suppressed (no flag)" ;;
esac
SK=$(sk_count)
[ "$SK" -eq 0 ] && ok "(j2) 2nd strike + draining: no send-keys" || bad "(j2) 2nd strike + draining: spurious send-keys (got: $SK)"
# Strike file should be cleared (we don't want it to re-check indefinitely).
[ ! -f "$STATE_DIR/strike-g6-g6alpha" ] && ok "(j3) 2nd strike + draining: strike file cleared" || bad "(j3) 2nd strike + draining: strike file should be removed"

# ==========================================================================
# (k) Stale strike file (older than G6_STRIKE_WINDOW): reset to 1st strike
# ==========================================================================
export G6_STRIKE_WINDOW=5   # 5 second window for test speed
# Clear the confirmed-latch left by (j)'s 2nd-strike confirm, otherwise the latch
# (default latch_window == strike window) would suppress this sweep and the
# stale-strike RESET branch would never be exercised (latch takes precedence).
rm -f "$STATE_DIR/strike-latch-g6-g6alpha"
# Write a strike file that is older than the window.
printf '%s\n' "$(( $(date +%s) - 20 ))" > "$STATE_DIR/strike-g6-g6alpha"
pane_survey g6alpha
: > "$SEND_KEYS_FILE"
run_sweep
S="$(summary)"

case "$S" in
  *"g6alpha:G6"*|*"dismissed:"*"g6alpha"*) bad "(k1) stale strike: should reset to 1st strike, not flag (got: $S)" ;;
  *)                                        ok  "(k1) stale strike: reset to 1st strike, no flag" ;;
esac
SK=$(sk_count)
[ "$SK" -eq 0 ] && ok "(k2) stale strike: no send-keys" || bad "(k2) stale strike: spurious send-keys"
[ -f "$STATE_DIR/strike-g6-g6alpha" ] && ok "(k3) stale strike: new strike file written" || bad "(k3) stale strike: strike file not reset"
unset G6_STRIKE_WINDOW

# ==========================================================================
# (l) Auto-dismiss TOCTOU guard: modal clears between snapshot and re-verify
# ==========================================================================
# Setup: strike file from (k) re-detection (1st new strike).
[ -f "$STATE_DIR/strike-g6-g6alpha" ] || printf '%s\n' "$(( $(date +%s) - 10 ))" > "$STATE_DIR/strike-g6-g6alpha"
# Now change pane to HEALTHY BEFORE the 2nd sweep (simulates modal self-clearing).
# When fleet_wedge_sweep re-captures for classification, pane is still survey
# (Phase 1 reads from the saved files in sweep_tmp which were captured at sweep start).
# But the re-verify call (TOCTOU guard) reads the pane AGAIN in Phase 3.
# We simulate TOCTOU: Phase 1 capture = survey (pane file), re-verify = healthy.
# To do this: set pane to healthy NOW (re-verify in Phase 3 will see healthy).
# The Phase 1 capture already happened with the stale pane text.
# But we can't split Phase 1 vs Phase 3 in the same run_sweep call.
# Workaround: use a secondary pane file only for re-verify. We override mock_tmux
# to return survey for Phase 1 (capture-pane in the sweep loop) and healthy for
# Phase 3 re-verify (a 2nd capture-pane call to the same agent).
#
# Implementation: track call count per agent in $TMP/cap-count-<n>.
TOCTOU_AGENT="toctou"
pane_survey "$TOCTOU_AGENT"
printf '%s\n' "$(( $(date +%s) - 10 ))" > "$STATE_DIR/strike-g6-$TOCTOU_AGENT"
: > "$SEND_KEYS_FILE"
export FLEET_TEST_SWEEP_AGENTS="$TOCTOU_AGENT"

# Override mock_tmux to return survey on 1st capture, healthy on 2nd (TOCTOU sim).
# Must iterate "$@" for correct agent-name extraction (see main mock_tmux comment).
mock_tmux() {
  local _n="" _arg
  for _arg in "$@"; do
    case "$_arg" in =agent-*) _n="${_arg#=agent-}"; _n="${_n%%:*}" ;; esac
  done
  case "$1" in
    has-session) return 0 ;;
    capture-pane)
      local _cf="$TMP/cap-count-${_n:-_none}"
      local _count
      _count=$(cat "$_cf" 2>/dev/null || echo 0); _count=$(( _count + 1 ))
      printf '%s\n' "$_count" > "$_cf"
      if [ "$_count" -le 1 ]; then
        # 1st capture (Phase 1 classification): modal present
        printf '%s\n' "$SURVEY_TEXT"
      else
        # 2nd capture (Phase 3 re-verify): modal already cleared
        printf '%s\n' "$IDLE_TEXT"
      fi ;;
    send-keys)
      printf '%s\n' "$*" >> "$SEND_KEYS_FILE" ;;
    *) return 0 ;;
  esac
}

run_sweep
S="$(summary)"
SK=$(sk_count)

case "$S" in
  *"$TOCTOU_AGENT:G6"*) bad "(l1) TOCTOU: should not add to wedged list (got: $S)" ;;
  *"dismissed:"*"$TOCTOU_AGENT"*) bad "(l1) TOCTOU: should not be dismissed when modal cleared (got: $S)" ;;
  *) ok "(l1) TOCTOU guard: modal cleared -> no flag, no send" ;;
esac
[ "$SK" -eq 0 ] && ok "(l2) TOCTOU guard: no send-keys when modal cleared" || bad "(l2) TOCTOU guard: send-keys sent to cleared modal (DANGEROUS; got: $SK)"
# A "cleared" log line should be present.
case "$(summary)" in
  *"TOCTOU guard"*) ok "(l3) TOCTOU guard: log entry present" ;;
  *) bad "(l3) TOCTOU guard: no TOCTOU log entry (got: $(summary))" ;;
esac

# Restore plain mock_tmux for remaining tests.
mock_tmux() {
  local _n="" _arg
  for _arg in "$@"; do
    case "$_arg" in =agent-*) _n="${_arg#=agent-}"; _n="${_n%%:*}" ;; esac
  done
  case "$1" in
    has-session) return 0 ;;
    capture-pane)
      local _pf="$TMP/pane-${_n:-_none}"
      [ -f "$_pf" ] && cat "$_pf" || printf '%s\n' "$IDLE_TEXT" ;;
    send-keys)
      printf '%s\n' "$*" >> "$SEND_KEYS_FILE" ;;
    *) return 0 ;;
  esac
}

# ==========================================================================
# (m) Roster guard: path-like token does not escape into wedged/dismissed
# ==========================================================================
# Note: no pane_survey for path-like names (file write would require mkdir).
# The mock returns idle text by default; the roster guard should reject the
# token before it reaches the wedge classifier.
export FLEET_TEST_SWEEP_AGENTS="scripts/fleet-supervisor.sh"
run_sweep
S="$(summary)"
case "$S" in
  *"scripts/fleet-supervisor.sh"*) bad "(m) path-like token should be rejected (got: $S)" ;;
  *) ok "(m) roster guard: path-like token rejected" ;;
esac

# ==========================================================================
# (n) Phase-1 roster guard: path-like token rejected before dead_list addition
# ==========================================================================
# Override session_alive to return 1 for sessions with '/' (simulating tmux
# failing on malformed session names). Without Phase-1 guard, path-like token
# hits the session_alive check and ends up in dead_list. With the guard it is
# rejected before session_alive is even called.
export FLEET_TEST_SWEEP_AGENTS="g6alpha scripts/fleet-supervisor.sh"
# Ensure g6alpha's 2nd strike fires so the log message is emitted (dead field visible).
printf '%s\n' "$(( $(date +%s) - 10 ))" > "$STATE_DIR/strike-g6-g6alpha"
pane_survey g6alpha
: > "$SEND_KEYS_FILE"
session_alive_orig() { return 0; }
session_alive() {
  # Real path-like session names fail has-session; simulate that here.
  case "$1" in */*) return 1 ;; *) return 0 ;; esac
}
run_sweep
S="$(summary)"
session_alive() { return 0; }  # restore

case "$S" in
  *"dismissed:"*"g6alpha"*) ok "(n1) Phase-1 guard: survey agent dismissed (log fired)" ;;
  *) bad "(n1) Phase-1 guard: expected g6alpha dismissed -- log may not have fired (got: $S)" ;;
esac
case "$S" in
  *"scripts/fleet-supervisor.sh"*)
    bad "(n2) Phase-1 guard: path-like token appeared in log -- guard missing (got: $S)" ;;
  *)
    ok "(n2) Phase-1 guard: path-like token NOT in log (rejected at Phase 1)" ;;
esac
export FLEET_TEST_SWEEP_AGENTS="g6alpha"

# ==========================================================================
# (p) Confirmed-latch anti-flap: after a 2nd-strike dismiss, a modal that keeps
# reappearing every turn must NOT drive a fresh confirm->dismiss cycle for the
# whole latch window. This is the detector-common migration's value-add over the
# old inline 2-strike (no latch -> re-dismisses every other sweep).
# Four sweeps are required to exercise the latch: the confirm REMOVES the strike
# file, so sweep3 is a first-strike either way -- only sweep4 would re-confirm
# WITHOUT the latch. Proof-of-non-vacuity: latch_window=0 makes sweep4 re-dismiss
# (SK=2) -> (p3)+(p4) flip.
# NOTE: must run BEFORE (o) -- (o) re-sources the supervisor, which clobbers the
# test's log() override (summary would then read empty).
# ==========================================================================
export FLEET_TEST_SWEEP_AGENTS="g6latch"
MOCK_DRAINING=0
rm -f "$STATE_DIR/strike-g6-g6latch" "$STATE_DIR/strike-latch-g6-g6latch"
pane_survey g6latch
: > "$SEND_KEYS_FILE"

run_sweep   # sweep1: 1st strike, no flag/send
run_sweep   # sweep2: 2nd strike confirmed -> dismiss (send-keys #1), latch written
S="$(summary)"
case "$S" in
  *"dismissed:"*"g6latch:G6"*) ok "(p1) 2nd strike dismissed (baseline for latch)" ;;
  *) bad "(p1) expected g6latch dismissed on 2nd strike (got: $S)" ;;
esac
[ -f "$STATE_DIR/strike-latch-g6-g6latch" ] \
  && ok "(p2) confirmed-latch written after dismiss" \
  || bad "(p2) latch file not written after confirmed dismiss"

run_sweep   # sweep3: latch active -> suppressed (no strike re-armed)
run_sweep   # sweep4: WITH latch still suppressed (SK stays 1); WITHOUT latch this
            #         would be a 2nd strike -> re-dismiss (SK=2)
S="$(summary)"
SK=$(sk_count)
case "$S" in
  *"g6latch:G6"*) bad "(p3) latch window: re-detected modal should NOT re-flag (got: $S)" ;;
  *)             ok  "(p3) latch window: re-detected modal suppressed, no re-flag" ;;
esac
[ "$SK" -eq 1 ] \
  && ok "(p4) latch anti-flap: exactly ONE send-keys across 4 sweeps (no re-dismiss)" \
  || bad "(p4) latch anti-flap: expected 1 send-keys, got $SK (latch not suppressing re-dismiss)"
export FLEET_TEST_SWEEP_AGENTS="g6alpha"

# ==========================================================================
# (q) Inert default: DETECTOR_COMMON_ENABLED=0 must preserve the EXACT legacy
# inline behaviour -- legacy strike filename (g6-strike-<n>, NOT strike-g6-<n>),
# NO confirmed-latch, and the 2nd-strike auto-dismiss still fires. This is the
# ship-inert guarantee: deploy changes nothing until the canary flip.
# Proof-of-non-vacuity: if the code ignored the flag and always used the shared
# helper, (q1) [legacy name used] + (q3) [no latch] would flip.
# ==========================================================================
export DETECTOR_COMMON_ENABLED=0
export FLEET_TEST_SWEEP_AGENTS="g6inert"
MOCK_DRAINING=0
rm -f "$STATE_DIR/strike-g6-g6inert" "$STATE_DIR/strike-latch-g6-g6inert" "$STATE_DIR/g6-strike-g6inert"
pane_survey g6inert
: > "$SEND_KEYS_FILE"

run_sweep   # sweep1: 1st strike -> legacy inline path
if [ -f "$STATE_DIR/g6-strike-g6inert" ] && [ ! -f "$STATE_DIR/strike-g6-g6inert" ]; then
  ok "(q1) inert default: legacy strike filename used (flag gates the migration)"
else
  bad "(q1) inert default: expected legacy g6-strike-g6inert, shared name must be absent"
fi

run_sweep   # sweep2: 2nd strike -> dismiss (legacy behaviour preserved)
S="$(summary)"
case "$S" in
  *"dismissed:"*"g6inert:G6"*) ok "(q2) inert default: 2nd-strike auto-dismiss still fires" ;;
  *) bad "(q2) inert default: 2nd-strike dismiss missing (got: $S)" ;;
esac
[ ! -f "$STATE_DIR/strike-latch-g6-g6inert" ] \
  && ok "(q3) inert default: NO confirmed-latch written (legacy has no latch)" \
  || bad "(q3) inert default: latch file written under flag=0 (should be legacy, no latch)"
export DETECTOR_COMMON_ENABLED=1
export FLEET_TEST_SWEEP_AGENTS="g6alpha"

# ==========================================================================
# (o) g6_inbox_draining argv hardening: REAL function with single-quote name
# ==========================================================================
# Calls the production g6_inbox_draining (not the suite-level mock) with an
# agent name containing a single quote.  Old code ('$n' interpolation) produces
# a Python SyntaxError; new code (AGENT_ID env-var) must return cleanly.
# Pattern: lesson-gate-verify-test-exercises-branch (PR#831).
python3 -c "
import sqlite3
c = sqlite3.connect('$TMP/noa.db')
c.execute('CREATE TABLE IF NOT EXISTS agent_messages (to_agent TEXT, delivered_at INTEGER)')
c.commit()
c.close()
" 2>/dev/null

# Re-source to get the production g6_inbox_draining, overriding suite-level mock.
unset -f g6_inbox_draining 2>/dev/null
source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1
resolve_live_db() { printf '%s' "$TMP/noa.db"; }

_o1_err_file="$TMP/o1_err"
g6_inbox_draining "test'agent" 2>"$_o1_err_file"; _o1_st=$?
_o1_err=$(cat "$_o1_err_file" 2>/dev/null)

case "$_o1_err" in
  *SyntaxError*|*Error*|*error*)
    bad "(o1) argv hardening: Python error in real g6_inbox_draining (err: $_o1_err)" ;;
  *)
    ok "(o1) argv hardening: real g6_inbox_draining safe with single-quote agent name" ;;
esac
[ "$_o1_st" -eq 1 ] \
  && ok "(o2) argv hardening: fail-open return (no msgs, not crash)" \
  || bad "(o2) argv hardening: unexpected exit $_o1_st (expected 1 = no recent msgs)"

# Restore suite mock.
g6_inbox_draining() { [ "$MOCK_DRAINING" = "1" ]; }

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
