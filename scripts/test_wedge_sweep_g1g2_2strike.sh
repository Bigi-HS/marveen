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
# ships INERT (flag=0 = exact pre-S2 immediate-flag). The tail-scope of the
# degraded fallback is NOT flag-gated: it is a pure FP-fix that mirrors the
# already-shipped Phase-2 behaviour and is behaviour-preserving for any pane whose
# marker is within the tail (the only behaviour it changes is dropping a
# stale-scrollback FP, which Phase-2 already drops).
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

# (c) FP-catch G1: stale 'Press Enter' beyond last-10 -> NOT flagged.
sweep_one g1stale
if ! flagged "g1stale:G1"; then
  ok "flag=1 G1: stale 'Press Enter' beyond last-10 NOT flagged (tail-scope closes stale-scrollback FP)"
else
  bad "flag=1 G1: FALSE-POSITIVE -- stale-scrollback 'Press Enter' flagged G1"
fi

# (d) fail-direction G1: active 'Press Enter' within last-10 -> flagged.
sweep_one g1live
if flagged "g1live:G1"; then
  ok "flag=1 G1: active 'Press Enter' within last-10 IS flagged (fail-direction)"
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
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
