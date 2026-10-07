#!/bin/bash
# c12-equivalent logic harness for fleet_wedge_sweep() G1 (enter-stuck) + G2
# (usage-limit) DETECTION migration (card 9644ed7c S2).
#
# S2 refined scope (per-arm FP mapping, marveen per-arm-FP-binding gate):
#   - G2 (usage-limit): real FP root = stale-scrollback. The Phase-2 node
#     classifier is already tail-scoped (src/pane-state.ts LIMIT_MENU_TAIL_LINES);
#     the Phase-3 DEGRADED fallback (node CLI absent) matched the FULL pane buffer
#     and so re-opened the stale-scrollback FP. Fix = tail-scope the fallback.
#     G2 gets NO strike_gate (2-strike would MASK a persistently-visible stale
#     banner, not close it -- the root is tail-scope).
#   - G1 (enter-stuck): FP classes = stale-scrollback (Phase-2 tail-scoped;
#     fallback must mirror) + transient-flash (needs 2-strike). Fix = tail-scope
#     the fallback AND add strike_gate 2-strike, behind DETECTOR_COMMON_ENABLED.
#
# Every flag=1 behaviour is gated on DETECTOR_COMMON_ENABLED so the migration
# ships INERT: flag=0 == pre-S2-develop BYTE-IDENTICAL. This INCLUDES the degraded
# fallback tail-scope -- it is flag-gated like every other S2 change (code:
# fleet-supervisor.sh gates `_g2_scan`/`_g1_scan = tail ...` behind the flag; under
# flag=0 the fallback matches the FULL pane and still flags a stale banner, proved
# by the flag=0 inert cases below). The tail-scope must NOT leak into flag=0, else
# the slice is no longer deploy-neutral and the one-canary-flip-at-S5-end rollout
# breaks. (marveen invariant-preservation refinement, 2026-10-07.)
#
# Degraded-fallback depth = TAIL-ONLY (no staleness-guard), by necessity: the
# Phase-2 staleness-guard (limitResetTimeIsStale, src/pane-state.ts) parses the
# reset-time out of the banner in the node classifier, which is ABSENT on this
# degraded bash path. So the fallback mirrors Phase-2's tail-scope but not its
# staleness-reset check. RESIDUAL FP: a stale banner that scrolls INTO the last
# 18/10 lines would still flag (the tail window alone does not defend against a
# freshly-scrolled stale banner). Acceptable for the degraded path (the node CLI
# is present on the live host, so this path is the rare fallback); a bash-side
# staleness-guard is a possible future card. (marveen fallback-depth refinement,
# 2026-10-07.)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# Source the REAL supervisor (--dry-run returns before running the daemon).
source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/store/.fleet-supervisor"
# INSTALL_DIR=$TMP -> classify_cli path absent -> DEGRADED fallback (bare-substring).
# This harness exercises the Phase-3 degraded path (the one that had the FP gap).
INSTALL_DIR="$TMP"; STORE="$TMP/store"; STATE_DIR="$TMP/store/.fleet-supervisor"
DRY_RUN=0
CURL=""                   # no alert delivery
TMUX_BIN=mock_tmux

RF="$TMP/sweeplog"
log() { printf '%s\n' "$*" >> "$RF"; }

session_alive()    { return 0; }
is_sleep_eligible(){ return 1; }
resolve_live_db()  { printf '%s' "$TMP/noa.db"; }
# No draining by default (effect_drain_check / g6_inbox_draining unused by G1/G2).

# Pane text per agent in $TMP/pane-<name>.
pane_set() { printf '%s' "$2" > "$TMP/pane-$1"; }

mock_tmux() {
  local _n="" _arg
  for _arg in "$@"; do
    case "$_arg" in =agent-*) _n="${_arg#=agent-}"; _n="${_n%%:*}" ;; esac
  done
  case "$1" in
    has-session) return 0 ;;
    capture-pane)
      local _pf="$TMP/pane-${_n:-_none}"
      [ -f "$_pf" ] && cat "$_pf" || printf '> healthy\n' ;;
    send-keys) : ;;   # G1/G2 detection migration adds NO send-keys (recovery deferred)
    *) return 0 ;;
  esac
}

# Helper: run one sweep for a single agent, return the posted wedged_list via $RF.
# The sweep logs "fleet-wedge-sweep: wedged:... dismissed:..." only when non-empty.
sweep_one() {
  local agent="$1"
  : > "$RF"
  rm -f "$STATE_DIR/fleet-wedge-sweep.last"
  FLEET_TEST_SWEEP_AGENTS="$agent" fleet_wedge_sweep
}
flagged() {  # flagged <agent>:<class>  -> 0 if present in last sweep log
  grep -q "wedged:[^Z]*$1" "$RF" 2>/dev/null
}

# Build a pane: a leading banner line, then N healthy filler lines so the banner
# sits BEYOND the tail window (stale-scrollback within the visible capture).
pane_banner_then_filler() {  # <banner> <filler_count>
  local banner="$1" n="$2" i
  local out="$banner"$'\n'
  for ((i=0;i<n;i++)); do out="$out""idle line $i"$'\n'; done
  out="$out> "    # healthy prompt at the very bottom
  printf '%s' "$out"
}

echo "=== S2 increment 1: degraded-fallback tail-scope (G1=10, G2=18) ==="
# Proof model (marveen-corrected): flag=1 = new tail-scoped behaviour (drops the
# stale-scrollback FP); flag=0 == pre-S2-develop (byte-identical, still flags the
# stale banner = inert preservation). The tail-scope ships behind
# DETECTOR_COMMON_ENABLED like every S2 change, so one canary flip activates it.

# Stale panes: marker ABOVE the tail window (25 filler > 18 for G2, 15 > 10 for G1).
pane_set g2stale "$(pane_banner_then_filler 'Usage limit reached -- weekly limit' 25)"
pane_set g1stale "$(pane_banner_then_filler 'Press Enter to continue' 15)"
# Active panes: marker WITHIN the tail window.
pane_set g2live  "$(pane_banner_then_filler 'Usage limit reached -- weekly limit' 5)"
pane_set g1live  "$(pane_banner_then_filler 'Press Enter to continue' 3)"

# ---- flag=1: tail-scope ACTIVE (the fix) ------------------------------------
export DETECTOR_COMMON_ENABLED=1

# (a) FP-catch G2: stale 'Usage limit' beyond last-18 -> NOT flagged.
#     Documented FP-class: stale-scrollback (lesson capture-pane-selector + b0e189fb).
sweep_one g2stale
if ! flagged "g2stale:G2"; then
  ok "flag=1 G2: stale 'Usage limit' beyond last-18 NOT flagged (tail-scope closes stale-scrollback FP)"
else
  bad "flag=1 G2: FALSE-POSITIVE -- stale-scrollback 'Usage limit' flagged G2"
fi

# (b) fail-direction G2: active 'Usage limit' within last-18 -> flagged.
sweep_one g2live
if flagged "g2live:G2"; then
  ok "flag=1 G2: active 'Usage limit' within last-18 IS flagged (fail-direction)"
else
  bad "flag=1 G2: MISS -- active usage-limit not flagged"
fi

# (c) FP-catch G1: stale 'Press Enter' beyond last-10 -> NOT flagged even across
#     TWO sweeps. Two sweeps PROVE tail-scope (not merely 2-strike silence): a
#     broken tail would detect the marker and confirm on sweep 2.
rm -f "$STATE_DIR/strike-g1-g1stale" "$STATE_DIR/strike-latch-g1-g1stale"
sweep_one g1stale; sweep_one g1stale
if ! flagged "g1stale:G1"; then
  ok "flag=1 G1: stale 'Press Enter' beyond last-10 NOT flagged across 2 sweeps (tail-scope)"
else
  bad "flag=1 G1: FALSE-POSITIVE -- stale-scrollback 'Press Enter' flagged G1"
fi

# (d) fail-direction G1: active 'Press Enter' within last-10 -> flagged after the
#     confirmed 2nd strike (within-tail marker reaches the detector; G1 is 2-strike).
rm -f "$STATE_DIR/strike-g1-g1live" "$STATE_DIR/strike-latch-g1-g1live"
sweep_one g1live; sweep_one g1live
if flagged "g1live:G1"; then
  ok "flag=1 G1: active 'Press Enter' within last-10 IS flagged after 2nd strike (fail-direction)"
else
  bad "flag=1 G1: MISS -- active press-enter not flagged"
fi

# ---- flag=0: INERT preservation (byte-identical to pre-S2-develop) ----------
export DETECTOR_COMMON_ENABLED=0

# (e) G2 inert: under flag=0 the degraded fallback matches the FULL pane, so the
#     stale banner STILL flags (exact pre-S2 behaviour -> deploy-neutral).
sweep_one g2stale
if flagged "g2stale:G2"; then
  ok "flag=0 G2: stale 'Usage limit' STILL flagged (inert == pre-S2-develop)"
else
  bad "flag=0 G2: inert preservation broken -- flag=0 changed behaviour"
fi

# (f) G1 inert: same, flag=0 preserves the pre-S2 full-pane match.
sweep_one g1stale
if flagged "g1stale:G1"; then
  ok "flag=0 G1: stale 'Press Enter' STILL flagged (inert == pre-S2-develop)"
else
  bad "flag=0 G1: inert preservation broken -- flag=0 changed behaviour"
fi

export DETECTOR_COMMON_ENABLED=1
echo ""

echo "=== S2 increment 2: G1 2-strike (transient-flash) + G2 no-strike proof ==="
# Per the per-arm mapping: G1's transient-flash FP needs strike_gate (2-strike);
# G2's root is tail-scope (above), so G2 must NOT gain a strike gate.
clear_g1() { rm -f "$STATE_DIR/strike-g1-$1" "$STATE_DIR/strike-latch-g1-$1"; }

# Active "Press Enter" within the tail -> the detector sees it every sweep.
pane_set g1flash "$(pane_banner_then_filler 'Press Enter to continue' 3)"

# ---- flag=1: 2-strike persistence (transient-flash FP) ----------------------
export DETECTOR_COMMON_ENABLED=1

# (g) 1st strike is SILENT (a one-sweep flash must not flag).
clear_g1 g1flash
sweep_one g1flash
if ! flagged "g1flash:G1"; then
  ok "flag=1 G1: 1st strike silent (transient-flash not flagged on one sweep)"
else
  bad "flag=1 G1: 1st strike flagged -- no 2-strike persistence"
fi

# (h) 2nd consecutive strike within window -> flag.
sweep_one g1flash
if flagged "g1flash:G1"; then
  ok "flag=1 G1: 2nd consecutive strike flags (confirmed transient->persistent)"
else
  bad "flag=1 G1: 2nd strike did not flag -- persistence broken"
fi

# (i) healthy-reset: a healthy pane BETWEEN strikes clears the counter, so the
#     next enter is a fresh 1st strike (enforces CONSECUTIVE strikes).
clear_g1 g1flash
sweep_one g1flash                 # strike 1 (silent)
pane_set g1flash "$(pane_banner_then_filler 'ok' 3)"   # healthy (no enter marker)
sweep_one g1flash                 # healthy -> must clear g1 strike
pane_set g1flash "$(pane_banner_then_filler 'Press Enter to continue' 3)"  # enter again
sweep_one g1flash                 # should be a FRESH 1st strike -> silent
if ! flagged "g1flash:G1"; then
  ok "flag=1 G1: healthy pane between strikes resets -> next enter is 1st strike (silent)"
else
  bad "flag=1 G1: non-consecutive strikes falsely confirmed (healthy-reset missing)"
fi

# ---- flag=0: G1 immediate flag (inert == pre-S2) ----------------------------
export DETECTOR_COMMON_ENABLED=0
clear_g1 g1flash
pane_set g1flash "$(pane_banner_then_filler 'Press Enter to continue' 3)"
sweep_one g1flash
if flagged "g1flash:G1"; then
  ok "flag=0 G1: immediate flag on 1st sweep (inert == pre-S2-develop)"
else
  bad "flag=0 G1: inert preservation broken -- flag=0 added 2-strike"
fi

# ---- G2 must NOT have gained a strike gate (mapping: G2 root = tail-scope) ---
export DETECTOR_COMMON_ENABLED=1
# Active usage-limit within the tail -> must flag on the VERY FIRST sweep even at
# flag=1 (proves G2 is immediate, not 2-strike).
rm -f "$STATE_DIR/strike-g2-g2now" "$STATE_DIR/strike-latch-g2-g2now"
pane_set g2now "$(pane_banner_then_filler 'Usage limit reached -- weekly limit' 5)"
sweep_one g2now
if flagged "g2now:G2"; then
  ok "flag=1 G2: active usage-limit flags on 1st sweep (G2 is immediate, NOT 2-strike)"
else
  bad "flag=1 G2: usage-limit NOT flagged on 1st sweep -- G2 wrongly gained a strike gate"
fi

export DETECTOR_COMMON_ENABLED=1
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
