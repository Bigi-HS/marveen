#!/bin/bash
# LIVE-ACTIVATION GATE for the autopilot restart-throttle chokepoint `wd_relaunch`
# (scripts/lib/watchdog-common.sh §2.1.1, card 05c1671f; throttle MAG throttle.py
# TB-01/INV9). This is item-3 of the step5 activation work.
#
# WHY A STUBBED HARNESS, NOT A LIVE CRASH-LOOP (c12-chameleon-test skill, PR#269):
# the chameleon `smoke` only proves launch+survive+ping -- it CANNOT exercise a
# relaunch-throttle decision, because that needs an agent to die fast N times,
# i.e. crash-looping a real claude process (token spend + risk). The correct
# c12-equivalent for a *.sh watchdog decision change is a LOGIC HARNESS OVER THE
# REAL EXTRACTED CODE with every external mocked. We source the REAL wd_relaunch
# from watchdog-common.sh and drive it with:
#   * a FAKE `tmux` on PATH that only logs its argv to a file (never spawns or
#     kills any session -- this is strictly SAFER than touching real tmux),
#   * a throwaway AUTOPILOT_STORE_DIR (mktemp -d) so throttle.py writes its state
#     into a temp dir and NEVER touches the real store/autopilot-throttle-*.json,
#   * the REAL throttle.py (pure/offline; the injected store dir makes it inert).
#
# HARD SAFETY INVARIANTS (modelled on per-agent-watchdog-buster-sim.sh; do NOT
# weaken):
#   * ZERO interaction with any live agent. Every operation is scoped to the
#     fake agent 'buster' and a FAKE session name "sim-agent-buster-<pid>". No
#     real tmux session is ever created, listed, signalled, or killed -- the
#     `tmux` binary itself is shadowed by a logging stub for the whole run.
#   * No real PID is ever identified or signalled. (The prod harness that must
#     touch a real pane does it by ANCESTRY, never pkill -f / path-match; here we
#     touch NO process at all, which is the strongest form of that discipline.)
#   * Leave no residue: the temp store dir + stub dir + log are removed on EXIT
#     (trap). No real store/autopilot-throttle-*.json or store/autopilot-halt-*.json
#     is written, because AUTOPILOT_STORE_DIR is redirected to the temp dir.
#   * set -euo pipefail; prints `SIM: PASS` / `SIM: FAIL -- <reason>`; exits
#     non-zero on any failed assertion.
#
# NO PRECONDITION on a running buster: unlike the pipe-watchdog sim this harness
# spawns nothing, so it does not require (or want) agent-buster to be up. It is
# fully offline and deterministic.
#
# Usage: scripts/autopilot-throttle-buster-sim.sh

set -euo pipefail

# ROOT is the repo root: derived from this script's own location (scripts/..) so
# the harness runs correctly from the main checkout OR an isolated worktree,
# without hardcoding /home/domin/marveen.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WDC="$ROOT/scripts/lib/watchdog-common.sh"
THROTTLE="$ROOT/scripts/autopilot/throttle.py"
TICK="$ROOT/scripts/autopilot/tick.py"

AGENT=buster
# A FAKE session name -- the tmux stub logs it but never creates it. Scoped to
# buster + this pid so it can never collide with a real "agent-<x>" session.
FAKE_SESSION="sim-agent-buster-$$"
FAKE_CMD="true"   # never executed: the tmux stub does not run its command arg.

fail() { echo "SIM: FAIL -- $*" >&2; exit 1; }
note() { echo "SIM: $*"; }

# --- preconditions (files present, nothing live) ---------------------------
[ -f "$WDC" ]      || fail "watchdog-common.sh missing ($WDC)"
[ -f "$THROTTLE" ] || fail "throttle.py missing ($THROTTLE)"
[ -f "$TICK" ]     || fail "tick.py missing ($TICK)"
command -v python3 >/dev/null 2>&1 || fail "python3 not on PATH"

# --- disposable sandbox: temp store + a logging tmux stub on PATH ----------
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/throttle-bustersim.XXXXXX")"
export AUTOPILOT_STORE_DIR="$TMPROOT/store"   # throttle.py honours this (module STORE_DIR)
mkdir -p "$AUTOPILOT_STORE_DIR"
STUBDIR="$TMPROOT/bin"
mkdir -p "$STUBDIR"
TMUX_LOG="$TMPROOT/tmux-calls.log"
: > "$TMUX_LOG"

cleanup() { rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT

# Fake `tmux`: log argv, DO NOT run the command, return success. This is what
# makes the sim safe -- wd_relaunch's `tmux new-session -d -s <sess> <cmd>` call
# resolves to THIS, so no real session is ever spawned and no `cmd` is executed.
cat > "$STUBDIR/tmux" <<STUB
#!/bin/bash
printf '%s\n' "\$*" >> "$TMUX_LOG"
exit 0
STUB
chmod +x "$STUBDIR/tmux"
# Shadow the real tmux for the whole run (wd_relaunch calls bare \`tmux\`).
export PATH="$STUBDIR:$PATH"
command -v tmux | grep -q "^$STUBDIR/tmux$" || fail "tmux stub not shadowing real tmux (got $(command -v tmux))"

# Source the REAL chokepoint under test. We also silence its warn-log by leaving
# WD_LOG_FILE unset (warn still goes to stderr, harmless).
export MARVEEN_ROOT="$ROOT"
# shellcheck source=/dev/null
source "$WDC"
command -v wd_relaunch >/dev/null 2>&1 || fail "wd_relaunch not defined after sourcing $WDC"

# Helpers over the stub log / throttle state ---------------------------------
tmux_call_count() { wc -l < "$TMUX_LOG" | tr -d ' '; }
last_tmux_call()  { tail -1 "$TMUX_LOG" 2>/dev/null || true; }
# Invoke throttle.py via python3 (the worktree copy may not have +x; wd_relaunch
# itself also shells `python3 "$throttle"`, so this mirrors the real call path).
pytr()            { python3 "$THROTTLE" "$@"; }
throttle_state()  { pytr status --agent "$AGENT"; }
throttle_file()   { echo "$AUTOPILOT_STORE_DIR/autopilot-throttle-$AGENT.json"; }
halt_marker()     { echo "$AUTOPILOT_STORE_DIR/autopilot-halt-$AGENT.json"; }
reset_state()     { pytr reset --agent "$AGENT" >/dev/null; rm -f "$(throttle_file)"; }

note "sandbox ready: AUTOPILOT_STORE_DIR=$AUTOPILOT_STORE_DIR, tmux=STUB, agent=$AGENT, session=$FAKE_SESSION"
note "no live agent touched: tmux is a logging stub, no PID signalled, store is a temp dir"

# ===========================================================================
# A) GATE OFF (WD_THROTTLE_ENABLED unset/0): plain relaunch, NO throttle state.
# ===========================================================================
note "--- A: gate OFF -> plain relaunch, throttle state untouched"
reset_state
rm -f "$(throttle_file)" "$(halt_marker)"
unset WD_THROTTLE_ENABLED || true
before_calls=$(tmux_call_count)
set +e
wd_relaunch "$AGENT" "$FAKE_SESSION" "$FAKE_CMD" 2>/dev/null
rcA=$?
set -e
after_calls=$(tmux_call_count)
[ "$rcA" -eq 0 ] || fail "A: gate-OFF relaunch returned $rcA (expected 0)"
[ "$after_calls" -eq $((before_calls + 1)) ] || fail "A: expected exactly 1 tmux new-session call, log grew by $((after_calls - before_calls))"
echo "$(last_tmux_call)" | grep -q "new-session -d -s $FAKE_SESSION" \
  || fail "A: tmux call was not the expected new-session (got: $(last_tmux_call))"
# The whole point of gate-OFF: throttle.py must NOT have been consulted, so NO
# state file exists (byte-equivalent to the legacy raw tmux call).
[ ! -f "$(throttle_file)" ] || fail "A: gate OFF wrote throttle state ($(throttle_file)) -- must be untouched"
note "A PASS: plain relaunch (rc=0, 1 tmux call), zero throttle state"

# ===========================================================================
# B) GATE ON + healthy slow trickle: sliding window prunes -> never halts,
#    relaunch proceeds each time.
#
# wd_relaunch always calls throttle.py with the DEFAULT 600s window (it does not
# forward --window/--now), so to prove the trickle WITHOUT sleeping ~700s x N we
# pre-seed the state with restart timestamps that are already OUTSIDE the window
# (via throttle.py record-restart --now <old>), then drive several real
# wd_relaunch calls spaced by the pruning boundary. Each fresh wd_relaunch's
# record-restart (now = wall clock) prunes the stale entries, so the in-window
# count stays at 1 and never reaches the threshold of 5.
# ===========================================================================
note "--- B: gate ON + healthy trickle -> never halts, relaunch each time"
reset_state
rm -f "$(throttle_file)" "$(halt_marker)"
export WD_THROTTLE_ENABLED=1
# Pre-seed 4 OLD restarts, each > 600s in the past (so the next real event prunes
# them all). This models a long-lived agent that has restarted a few times over
# many hours -- a legitimate trickle.
now=$(date +%s)
for k in 4 3 2 1; do
  pytr record-restart --agent "$AGENT" --now $(( now - k * 700 )) >/dev/null 2>&1 || true
done
# Sanity: those pre-seeded old entries, evaluated at a fresh now, prune to a small
# in-window count (<5) and must NOT be halted.
seeded_halted=$(throttle_state | python3 -c 'import sys,json;print(json.load(sys.stdin).get("halted"))')
[ "$seeded_halted" != "True" ] || fail "B: pre-seeded trickle already halted (window not pruning)"

trickle_calls=0
for i in 1 2 3; do
  before_calls=$(tmux_call_count)
  set +e
  wd_relaunch "$AGENT" "$FAKE_SESSION" "$FAKE_CMD" 2>/dev/null
  rcB=$?
  set -e
  after_calls=$(tmux_call_count)
  [ "$rcB" -eq 0 ] || fail "B: trickle relaunch #$i returned $rcB (expected 0 -- healthy must proceed)"
  [ "$after_calls" -eq $((before_calls + 1)) ] || fail "B: trickle #$i did not relaunch (no tmux new-session)"
  trickle_calls=$((trickle_calls + 1))
done
b_halted=$(throttle_state | python3 -c 'import sys,json;print(json.load(sys.stdin).get("halted"))')
b_count=$(throttle_state | python3 -c 'import sys,json;print(json.load(sys.stdin).get("restart_count_in_window"))')
[ "$b_halted" != "True" ] || fail "B: healthy trickle FALSELY halted (over-throttle; in-window count=$b_count)"
note "B PASS: $trickle_calls trickle relaunches all proceeded, never halted (in-window count=$b_count < 5)"

# ===========================================================================
# C) GATE ON + crash-loop burst (>=5 within window): after the threshold the
#    CHECK returns HALTED and wd_relaunch SKIPS the relaunch (NO tmux new-session)
#    and returns 1. This asserts the DANGEROUS/falsifying direction: the relaunch
#    did NOT happen.
# ===========================================================================
note "--- C: gate ON + crash-loop burst -> halt trips, relaunch SKIPPED"
reset_state
rm -f "$(throttle_file)" "$(halt_marker)"
export WD_THROTTLE_ENABLED=1

# Drive rapid relaunches (all trivially within the 600s window at wall-clock
# speed). Threshold is >=5: wd_relaunch records AFTER launching, so:
#   call 1..4 -> check ok, launch, record (count 1..4, not halted)
#   call 5    -> check ok (still <5 at check time), launch, record -> trips halt
#   call 6    -> check=HALTED -> SKIP (no tmux), rc 1  <-- the falsifying assert
launched=0
skipped_rc1=0
for i in 1 2 3 4 5 6; do
  before_calls=$(tmux_call_count)
  set +e
  wd_relaunch "$AGENT" "$FAKE_SESSION" "$FAKE_CMD" 2>/dev/null
  rcC=$?
  set -e
  after_calls=$(tmux_call_count)
  grew=$((after_calls - before_calls))
  if [ "$i" -le 5 ]; then
    # First five must each actually relaunch (check still passes at check-time).
    [ "$rcC" -eq 0 ] || fail "C: burst call #$i returned $rcC (expected 0 -- not yet halted at check)"
    [ "$grew" -eq 1 ] || fail "C: burst call #$i did not relaunch (tmux calls grew by $grew)"
    launched=$((launched + 1))
  else
    # Sixth: halt has tripped -> CHECK fail-closed -> SKIP relaunch, rc 1.
    [ "$rcC" -eq 1 ] || fail "C: post-threshold call #$i returned $rcC (expected 1 == HALTED skip)"
    # THE FALSIFYING ASSERTION: the relaunch did NOT happen (no new tmux call).
    [ "$grew" -eq 0 ] || fail "C: HALTED agent was RELAUNCHED anyway (tmux new-session fired post-halt) -- FAIL-OPEN, worst case"
    skipped_rc1=$((skipped_rc1 + 1))
  fi
done
[ "$launched" -eq 5 ]    || fail "C: expected 5 pre-halt relaunches, got $launched"
[ "$skipped_rc1" -eq 1 ] || fail "C: expected 1 post-halt SKIP, got $skipped_rc1"
c_halted=$(throttle_state | python3 -c 'import sys,json;print(json.load(sys.stdin).get("halted"))')
[ "$c_halted" = "True" ] || fail "C: crash-loop burst did NOT halt (state halted=$c_halted) -- throttle failed to trip"
note "C PASS: 5 relaunches then HALT; the 6th CHECK=HALTED, relaunch SKIPPED (rc=1, NO tmux new-session)"

# Extra falsification: a direct `check` on the halted state must itself exit 1
# (the chokepoint relies on this exit code; prove it independently of wd_relaunch).
set +e
pytr check --agent "$AGENT" >/dev/null 2>&1
check_rc=$?
set -e
[ "$check_rc" -eq 1 ] || fail "C: throttle.py check on halted agent returned $check_rc (expected 1)"
note "C PASS (extra): throttle.py check exits 1 on halted state (fail-closed contract holds)"

# ===========================================================================
# D) HALT MARKER CONTRACT. On halt trip, the durable marker
#    ${AUTOPILOT_STORE_DIR}/autopilot-halt-<agent>.json must exist with at least
#    {agent, halted_at, halt_reason, restart_count_in_window, notified:false}
#    so the notify-halt.py consumer (item-2, built in parallel) can fire.
#
#    *** ITEM-2 DEPENDENCY ***  As of this branch, throttle.py does NOT yet write
#    this separate marker (it only writes autopilot-throttle-<agent>.json with
#    halted/halted_at/halt_reason/restart_count_in_window). This assertion
#    therefore DEPENDS ON the item-2 marker-emit landing in throttle.py
#    record-restart. We do NOT fake a pass: if the marker is absent we report the
#    dependency as PENDING (non-fatal here, by design) rather than green.
#    When item-2 lands, flip MARKER_REQUIRED=1 below (or set it in the env) to
#    make this a hard gate.
# ===========================================================================
note "--- D: durable halt-marker contract (item-2 dependency)"
MARKER="$(halt_marker)"
MARKER_REQUIRED="${MARKER_REQUIRED:-0}"   # item-2 not yet landed -> default soft
if [ -f "$MARKER" ]; then
  # Validate the shape if present.
  python3 - "$MARKER" "$AGENT" <<'PY' || fail "D: halt marker present but malformed/contract-violating"
import json, sys
path, agent = sys.argv[1], sys.argv[2]
with open(path) as fh:
    m = json.load(fh)
need = ["agent", "halted_at", "halt_reason", "restart_count_in_window", "notified"]
missing = [k for k in need if k not in m]
assert not missing, f"marker missing keys: {missing}"
assert m["agent"] == agent, f"marker agent={m['agent']} != {agent}"
assert m["notified"] is False, f"marker notified must start False, got {m['notified']!r}"
assert isinstance(m["restart_count_in_window"], int) and m["restart_count_in_window"] >= 5, \
    f"restart_count_in_window should be >=5 at trip, got {m['restart_count_in_window']!r}"
print("D: halt marker present and contract-valid")
PY
  note "D PASS: durable halt marker present and contract-valid ($MARKER)"
else
  if [ "$MARKER_REQUIRED" = "1" ]; then
    fail "D: durable halt marker MISSING ($MARKER) but MARKER_REQUIRED=1 -- item-2 regression"
  fi
  note "D PENDING: durable halt marker NOT written by current throttle.py."
  note "D PENDING: this is the ITEM-2 dependency (notify-halt.py marker). NOT faked green."
  note "D PENDING: when item-2 lands, run with MARKER_REQUIRED=1 to enforce the contract here."
fi

# ===========================================================================
# E) tick.py gate smoke (agent 'buster'):
#    AUTOPILOT_TICK_ENABLED unset -> DISABLED line, exit 0 inert;
#    AUTOPILOT_TICK_ENABLED=1     -> normal preamble.
#
#    *** DEPENDENCY NOTE ***  As of this branch, tick.py does NOT yet gate on
#    AUTOPILOT_TICK_ENABLED (that enable-flag is a parallel step). We detect
#    which contract is live and assert accordingly, without faking a pass:
#      - If tick.py honours the flag: assert BOTH modes (disabled-inert / enabled).
#      - If it does not yet: assert the two modes are at least invoked inertly
#        against the fake agent (no crash, exit code sane) and report the flag as
#        a PENDING dependency. tick.py shells to classify/stuck but both
#        fail-SAFE on error, so this never touches a live agent.
# ===========================================================================
note "--- E: tick.py gate smoke (buster, two modes)"
TICK_GATED=0
if grep -q "AUTOPILOT_TICK_ENABLED" "$TICK"; then
  TICK_GATED=1
fi

run_tick() {  # $1 = value for AUTOPILOT_TICK_ENABLED ("unset" to unset)
  local val="$1"
  if [ "$val" = "unset" ]; then
    ( unset AUTOPILOT_TICK_ENABLED; python3 "$TICK" "$AGENT" "$FAKE_SESSION" 2>&1; echo "RC=$?" )
  else
    ( export AUTOPILOT_TICK_ENABLED="$val"; python3 "$TICK" "$AGENT" "$FAKE_SESSION" 2>&1; echo "RC=$?" )
  fi
}

OUT_OFF="$(run_tick unset)"
rc_off="${OUT_OFF##*RC=}"
OUT_ON="$(run_tick 1)"
rc_on="${OUT_ON##*RC=}"

if [ "$TICK_GATED" -eq 1 ]; then
  # Flag is live: disabled mode must print a DISABLED line and exit 0 inert.
  echo "$OUT_OFF" | grep -qiE "disabled|inert" \
    || fail "E: AUTOPILOT_TICK_ENABLED unset did not print a DISABLED/inert line"
  [ "$rc_off" = "0" ] || fail "E: disabled tick did not exit 0 inert (rc=$rc_off)"
  # Enabled mode must print the normal preamble marker.
  echo "$OUT_ON" | grep -q "AUTOPILOT TICK" \
    || fail "E: AUTOPILOT_TICK_ENABLED=1 did not print the normal tick preamble"
  [ "$rc_on" = "0" ] || [ "$rc_on" = "1" ] || fail "E: enabled tick exit code $rc_on not in {0,1}"
  note "E PASS: tick.py honours AUTOPILOT_TICK_ENABLED (disabled->inert exit0, enabled->preamble)"
else
  # Flag not yet wired. Prove the two invocations run inertly (no crash) against
  # the FAKE agent and emit the tick preamble (current unconditional behaviour).
  echo "$OUT_ON" | grep -q "AUTOPILOT TICK" \
    || fail "E: tick.py did not emit a preamble for buster (enabled mode)"
  [ "$rc_on" = "0" ] || [ "$rc_on" = "1" ] || fail "E: tick exit code $rc_on not in {0,1}"
  [ "$rc_off" = "0" ] || [ "$rc_off" = "1" ] || fail "E: tick (unset) exit code $rc_off not in {0,1}"
  note "E PENDING: tick.py does NOT yet gate on AUTOPILOT_TICK_ENABLED (parallel step)."
  note "E PENDING: smoke proves both invocations run inert on the fake agent (rc off=$rc_off on=$rc_on, preamble present)."
  note "E PENDING: when the enable-flag lands, this branch flips to the full two-mode assert automatically."
fi

# ===========================================================================
# Residue check: the temp store must NOT have leaked into the real store.
# ===========================================================================
REAL_THROTTLE="$ROOT/store/autopilot-throttle-$AGENT.json"
REAL_HALT="$ROOT/store/autopilot-halt-$AGENT.json"
[ ! -f "$REAL_THROTTLE" ] || fail "RESIDUE: real store throttle state exists ($REAL_THROTTLE) -- sandbox leaked!"
[ ! -f "$REAL_HALT" ]     || fail "RESIDUE: real store halt marker exists ($REAL_HALT) -- sandbox leaked!"
note "residue check OK: no real store/autopilot-*-$AGENT.json written"

echo "SIM: PASS -- wd_relaunch throttle chokepoint proven on stubbed buster sandbox: gate OFF plain relaunch, healthy trickle proceeds, crash-loop burst HALTS + SKIPS relaunch (falsifying direction asserted). Halt-marker (D) + tick-flag (E) PENDING on their parallel items -- NOT faked green. Zero live-agent interaction."
