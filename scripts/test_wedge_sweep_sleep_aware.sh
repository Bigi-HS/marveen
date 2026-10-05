#!/bin/bash
# c12-equivalent logic harness for fleet_wedge_sweep() sleep-awareness
# (card OPS/aec0be4a). The live sweep classifies a session-alive pane as G2
# (usage-limit) / G1 (Press-Enter) purely on pane text, with NO sleep-awareness:
# a channel-less sleep-managed agent that is briefly session-alive in its ~31min
# wake-to-check window and shows a usage-limit marker gets flagged wedged:<n>:G2
# even though it has ZERO wake-obligations and is sleeping correctly. This mirrors
# the 0c6f8263/OPS-247 "managed-sleep != down" fix onto the alive-pane branch.
#
# A `smoke` cannot exercise this (it only proves launch+survive+ping), so the
# c12-equivalent is a logic harness over the REAL extracted fleet_wedge_sweep,
# mocking tmux/session_alive/is_sleep_eligible/sg_should_wake/resolve_live_db and
# capturing the summary via a mocked log(). Covers BOTH directions + mutation.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# Source the REAL supervisor (--dry-run returns before running the daemon). This
# defines fleet_wedge_sweep + session_alive + is_sleep_eligible + resolve_live_db,
# and (after the fix) sources sleep-guard.sh so sg_should_wake exists.
source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/store/.fleet-supervisor"
INSTALL_DIR="$TMP"; STORE="$TMP/store"; STATE_DIR="$TMP/store/.fleet-supervisor"
DRY_RUN=0
CURL=""                 # empty -> alert delivery returns before any network call
TMUX_BIN=tmux           # so "$TMUX_BIN" resolves to the tmux() mock below

RF="$TMP/sweeplog"      # captured summary line(s) from the mocked log()
log() { printf '%s\n' "$*" >> "$RF"; }

# All test agents are session-alive (we exercise the alive-pane classifier).
session_alive() { return 0; }

# Sleep-eligible iff the agent name contains "sleep".
is_sleep_eligible() { case "$1" in *sleep*) return 0 ;; *) return 1 ;; esac; }

# resolve_live_db is not hit for real (sg_should_wake is mocked) but must exist.
resolve_live_db() { printf '%s' "$TMP/noa.db"; }

# Wake-obligation verdict, mocked deterministically by agent name: a name
# containing "obl" has an obligation (should wake) -> must STILL be flagged.
# MOCK_FORCE_WAKE=1 forces every agent to "has obligation" (mutation lever).
MOCK_FORCE_WAKE=0
sg_should_wake() {
  [ "$MOCK_FORCE_WAKE" = "1" ] && return 0
  case "$2" in *obl*) return 0 ;; *) return 1 ;; esac
}

# Pane text keyed by agent name (the arg is: capture-pane -t =agent-<n>:0.0 -p).
tmux() {
  case "$*" in
    *capture-pane*)
      case "$*" in
        *usage*) printf 'some header\nUsage limit reached\n> ' ;;
        *enter*) printf 'some output\nPress Enter to continue\n' ;;
        *g6*)    printf 'How is Claude doing this session?\nShare feedback\n' ;;
        *)       printf 'normal idle prompt\n> ' ;;
      esac ;;
    *) return 0 ;;
  esac
}

run_sweep() {
  : > "$RF"
  rm -f "$STATE_DIR/fleet-wedge-sweep.last"   # defeat the 300s throttle per run
  fleet_wedge_sweep
}
summary() { tr '\n' ' ' < "$RF"; }

# --- Main scenario: all shapes in one sweep (a real wedge coexists so the -----
#     summary is logged; a pure-sleeper-only case is tested separately below).
export FLEET_TEST_SWEEP_AGENTS="sleepusage plainusage sleepusageobl sleepenter plainenter sleepg6 plainhealthy"
run_sweep
S="$(summary)"

# (a) sleep + usage-limit + no obligation -> NOT wedged, IS napping.
case "$S" in *"sleepusage:G2"*) bad "(a) sleep+usage+no-obl should NOT be wedged G2 (got: $S)" ;;
             *"napping:"*sleepusage*|*sleepusage*"napping"*) ok "(a) sleep+usage+no-obl suppressed (napping, not G2)" ;;
             *) bad "(a) sleepusage neither G2 nor napping (got: $S)" ;; esac

# (b) non-sleep + usage-limit -> STILL wedged G2.
case "$S" in *"plainusage:G2"*) ok "(b) non-sleep+usage still flagged G2" ;;
             *) bad "(b) plainusage should be wedged G2 (got: $S)" ;; esac

# (c) sleep + usage-limit + WITH obligation -> STILL wedged G2 (don't swallow a real wedge).
case "$S" in *"sleepusageobl:G2"*) ok "(c) sleep+usage+WITH-obligation still flagged G2" ;;
             *) bad "(c) sleepusageobl should stay wedged G2 (got: $S)" ;; esac

# (d) sleep + Press-Enter + no obligation -> suppressed (napping), not G1.
case "$S" in *"sleepenter:G1"*) bad "(d) sleep+enter+no-obl should NOT be wedged G1 (got: $S)" ;;
             *sleepenter*) ok "(d) sleep+enter+no-obl suppressed (not G1)" ;;
             *) bad "(d) sleepenter missing from napping (got: $S)" ;; esac

# (e) non-sleep + Press-Enter -> STILL wedged G1.
case "$S" in *"plainenter:G1"*) ok "(e) non-sleep+enter still flagged G1" ;;
             *) bad "(e) plainenter should be wedged G1 (got: $S)" ;; esac

# (f) G6 2-strike (b0e189fb): 1st detection in this single sweep -> NOT flagged yet.
#     Sleep-awareness does not apply to G6 (aec0be4a), but b0e189fb adds 2-strike
#     persistence: a first-time G6 pane must NOT produce a wedge flag. The detailed
#     multi-sweep 2-strike logic is covered in test_wedge_sweep_g6_2strike.sh.
case "$S" in *"sleepg6:G6"*) bad "(f) G6 first strike should NOT be flagged yet (got: $S)" ;;
             *) ok "(f) G6 first strike: no flag (b0e189fb 2-strike pending)" ;; esac

# --- Pure-sleeper-only sweep: the ONLY would-be-flag is a suppressed sleeper ->
#     no wedge -> function returns silently, NO alert/summary logged (quiet). ---
export FLEET_TEST_SWEEP_AGENTS="sleepusage"
run_sweep
if [ ! -s "$RF" ]; then ok "(g) pure sleeper -> silent sweep, no alert logged"
else bad "(g) pure sleeper should be silent (got: $(summary))"; fi

# --- Mutation 1: force wake-obligation true for everyone -> the sleeper that was
#     suppressed in (a) MUST flip back to wedged G2 (proves !sg_should_wake gates).
export FLEET_TEST_SWEEP_AGENTS="sleepusage"
MOCK_FORCE_WAKE=1
run_sweep
case "$(summary)" in *"sleepusage:G2"*) ok "(mut1) obligation forced -> sleeper flips to G2 (guard non-vacuous)" ;;
                     *) bad "(mut1) sleeper with forced obligation should be G2 (got: $(summary))" ;; esac
MOCK_FORCE_WAKE=0

# --- Mutation 2: make the sleeper NOT sleep-eligible -> suppression must vanish
#     (proves is_sleep_eligible gates). Redefine the mock to always-false.
is_sleep_eligible() { return 1; }
export FLEET_TEST_SWEEP_AGENTS="sleepusage"
run_sweep
case "$(summary)" in *"sleepusage:G2"*) ok "(mut2) not sleep-eligible -> sleeper flips to G2 (is_sleep_eligible gates)" ;;
                     *) bad "(mut2) non-eligible sleeper should be G2 (got: $(summary))" ;; esac

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
