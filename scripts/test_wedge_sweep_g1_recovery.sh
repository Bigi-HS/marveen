#!/bin/bash
# c12-equivalent logic harness for the G1 (enter-stuck) send-Enter RECOVERY
# mechanism (card 9644ed7c S3). This is the FIRST new-live-effect slice: it adds a
# real `send-keys Enter` to the confirmed-2-strike G1 path. Detection (the :G1 flag)
# is UNCHANGED from S2 -- S3 adds ONLY the recovery side-effect.
#
# Safety model (marveen S3 guardrail #20524), three guards before the send:
#   (a) confirmed 2-strike  -- reuses wedge_arm_2strike g1 (persistent, not a flash)
#   (b) TOCTOU re-verify    -- re-capture DIRECTLY before the send; if the
#                              'Press Enter' marker is GONE, ABORT (the agent
#                              self-resolved; never inject into a healthy session)
#   (c) effect_drain_check  -- an actively inbox-draining agent is NOT stuck -> suppress
# The send-keys is a NEW LIVE EFFECT and is destructive on a live agent, so it fires
# ONLY under DETECTOR_COMMON_ENABLED=1 (flag=0 = detect-only = exact pre-S3 behaviour).
# flag=1 only activates at the family-end single canary flip, so in prod the send
# never fires until then.
#
# The effect-probe proves BOTH directions on this SANDBOX harness (never a live
# agent): marker-present + 2strike + not-draining -> send FIRES with the correct
# pane-selector; marker-GONE at re-verify -> send does NOT fire (TOCTOU abort). The
# negative-control (abort) is as important as the positive.
#
# INSTALL_DIR=$TMP -> classify_cli absent -> Phase-3 degraded path. Phase-2 calls the
# IDENTICAL helper (g1_apply_send_enter), so exercising the degraded path proves the
# mechanism for both (S1/S2 precedent).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/store/.fleet-supervisor"
INSTALL_DIR="$TMP"; STORE="$TMP/store"; STATE_DIR="$TMP/store/.fleet-supervisor"
SEND_KEYS_FILE="$TMP/send-keys.log"; : > "$SEND_KEYS_FILE"
TMUX_BIN="mock_tmux"
CURL=""          # no dashboard POST in the harness
export FLEET_WEDGE_SWEEP_INTERVAL=0   # never throttle between sweeps

# --- stubs: keep the sweep deterministic + offline --------------------------
session_alive()    { return 0; }
is_sleep_eligible(){ return 1; }
wedge_sleep_suppress() { return 1; }          # never napping in these cases
resolve_live_db()  { printf '%s' "$TMP/noa.db"; }
# effect_drain_check stub: MOCK_DRAINING=1 -> agent is draining (healthy -> suppress).
MOCK_DRAINING=0
effect_drain_check() { [ "$MOCK_DRAINING" = "1" ]; }

ENTER_TEXT="$(printf 'Some output\nPress Enter to continue\n')"
IDLE_TEXT="$(printf 'normal idle\n> ')"
pane_enter()   { printf '%s\n' "$ENTER_TEXT" > "$TMP/pane-$1"; }
pane_healthy() { printf '%s\n' "$IDLE_TEXT"  > "$TMP/pane-$1"; }
pane_set()     { printf '%s\n' "$2"          > "$TMP/pane-$1"; }

# Plain mock: capture-pane returns the per-agent pane file; send-keys is logged.
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
    send-keys) printf '%s\n' "$*" >> "$SEND_KEYS_FILE" ;;
    *) return 0 ;;
  esac
}

RF="$TMP/run.log"
log() { printf '%s\n' "$*" >> "$RF"; }     # capture supervisor log lines
summary() { cat "$RF" 2>/dev/null; }
sk()      { cat "$SEND_KEYS_FILE" 2>/dev/null; }
sk_count(){ wc -l < "$SEND_KEYS_FILE" | tr -d ' '; }
run_sweep() { : > "$RF"; fleet_wedge_sweep; }
flagged() { grep -q "wedged:[^Z]*$1" "$RF"; }

g1_strike_reset() { rm -f "$STATE_DIR"/strike-g1-* "$STATE_DIR"/strike-latch-g1-* 2>/dev/null; }

echo "=== S3 increment 1: G1 send-Enter recovery mechanism (effect-probe both directions) ==="

# ---- flag=1: recovery ACTIVE ------------------------------------------------
export DETECTOR_COMMON_ENABLED=1

# (a) first-strike SILENT: one sweep with 'Press Enter' -> NOT flagged, NO send.
g1_strike_reset; : > "$SEND_KEYS_FILE"
pane_enter g1a
export FLEET_TEST_SWEEP_AGENTS="g1a"
run_sweep
if ! flagged "g1a:G1"; then ok "(a1) flag=1 first strike: NOT flagged (silent)"
else bad "(a1) flag=1 first strike: unexpectedly flagged"; fi
[ "$(sk_count)" -eq 0 ] && ok "(a2) flag=1 first strike: NO send-keys" \
  || bad "(a2) flag=1 first strike: spurious send-keys ($(sk))"

# (b) POSITIVE-CONTROL: 2nd consecutive sweep, marker present, not draining ->
#     flagged :G1 AND send-keys Enter fired with the correct pane-selector.
: > "$SEND_KEYS_FILE"; MOCK_DRAINING=0
run_sweep    # 2nd strike -> confirmed
if flagged "g1a:G1"; then ok "(b1) flag=1 confirmed: flagged :G1 (detection preserved)"
else bad "(b1) flag=1 confirmed: NOT flagged"; fi
case "$(sk)" in
  *"=agent-g1a:0.0 Enter"*) ok "(b2) POSITIVE-CONTROL: send-keys Enter to =agent-g1a:0.0" ;;
  *) bad "(b2) POSITIVE-CONTROL: Enter NOT sent to the right selector (got: '$(sk)')" ;;
esac
case "$(summary)" in
  *"G1 auto-recover: sent Enter"*) ok "(b3) POSITIVE-CONTROL: recovery log line present" ;;
  *) bad "(b3) POSITIVE-CONTROL: no recovery log (got: $(summary))" ;;
esac

# (c) NEGATIVE-CONTROL (TOCTOU abort): confirmed 2nd strike, but the re-verify
#     capture shows the marker GONE -> send does NOT fire. The classification
#     capture (Phase-1) must still see 'Press Enter' so 2-strike confirms.
g1_strike_reset; : > "$SEND_KEYS_FILE"; MOCK_DRAINING=0
pane_enter g1t
export FLEET_TEST_SWEEP_AGENTS="g1t"
run_sweep    # 1st strike (silent)
# For the confirming sweep, make capture return 'Press Enter' for Phase-1 (count 1)
# and healthy for the re-verify (count 2). Reset the per-agent capture counter.
rm -f "$TMP/cap-count-g1t"
mock_tmux() {
  local _n="" _arg
  for _arg in "$@"; do
    case "$_arg" in =agent-*) _n="${_arg#=agent-}"; _n="${_n%%:*}" ;; esac
  done
  case "$1" in
    has-session) return 0 ;;
    capture-pane)
      local _cf="$TMP/cap-count-${_n:-_none}" _c
      _c=$(cat "$_cf" 2>/dev/null || echo 0); _c=$((_c+1)); printf '%s\n' "$_c" > "$_cf"
      if [ "$_c" -le 1 ]; then printf '%s\n' "$ENTER_TEXT"   # Phase-1 classify: marker present
      else printf '%s\n' "$IDLE_TEXT"; fi ;;                 # Phase-3 re-verify: marker gone
    send-keys) printf '%s\n' "$*" >> "$SEND_KEYS_FILE" ;;
    *) return 0 ;;
  esac
}
run_sweep    # 2nd strike -> confirmed, but re-verify sees healthy -> ABORT
[ "$(sk_count)" -eq 0 ] && ok "(c1) NEGATIVE-CONTROL: marker gone at re-verify -> NO send (abort)" \
  || bad "(c1) NEGATIVE-CONTROL: DANGEROUS send to a self-resolved pane ($(sk))"
case "$(summary)" in
  *"TOCTOU guard"*) ok "(c2) NEGATIVE-CONTROL: TOCTOU-abort log present" ;;
  *) bad "(c2) NEGATIVE-CONTROL: no TOCTOU-abort log (got: $(summary))" ;;
esac
# restore plain mock
mock_tmux() {
  local _n="" _arg
  for _arg in "$@"; do
    case "$_arg" in =agent-*) _n="${_arg#=agent-}"; _n="${_n%%:*}" ;; esac
  done
  case "$1" in
    has-session) return 0 ;;
    capture-pane) local _pf="$TMP/pane-${_n:-_none}"; [ -f "$_pf" ] && cat "$_pf" || printf '%s\n' "$IDLE_TEXT" ;;
    send-keys) printf '%s\n' "$*" >> "$SEND_KEYS_FILE" ;;
    *) return 0 ;;
  esac
}

# ---- flag=0: INERT -- detect-only, NEVER send (deploy-neutral == pre-S3) -----
export DETECTOR_COMMON_ENABLED=0

# (d) flag=0 deploy-neutral: 'Press Enter' -> flagged :G1 IMMEDIATELY (pre-S3
#     detection, no 2-strike) AND NO send-keys EVER (recovery does not exist at flag=0).
g1_strike_reset; : > "$SEND_KEYS_FILE"
pane_enter g1z
export FLEET_TEST_SWEEP_AGENTS="g1z"
run_sweep
if flagged "g1z:G1"; then ok "(d1) flag=0: flagged :G1 immediately (pre-S3 detection)"
else bad "(d1) flag=0: NOT flagged (detection regressed)"; fi
[ "$(sk_count)" -eq 0 ] && ok "(d2) flag=0 DEPLOY-NEUTRAL: NO send-keys (recovery inert)" \
  || bad "(d2) flag=0: send-keys fired at flag=0 -- NOT deploy-neutral ($(sk))"

# (e) GUARD (c) drain-suppress: flag=1, confirmed 2nd strike, marker present, but the
#     agent is actively draining its inbox -> NOT stuck -> suppress the send. Still
#     flagged :G1 (detection over-reports safely; the dangerous ACTION is suppressed).
export DETECTOR_COMMON_ENABLED=1
g1_strike_reset; : > "$SEND_KEYS_FILE"; MOCK_DRAINING=1
pane_enter g1d
export FLEET_TEST_SWEEP_AGENTS="g1d"
run_sweep    # 1st strike
run_sweep    # 2nd strike confirmed, but draining -> suppress
if flagged "g1d:G1"; then ok "(e1) drain-suppress: still flagged :G1 (safe over-report)"
else bad "(e1) drain-suppress: NOT flagged"; fi
[ "$(sk_count)" -eq 0 ] && ok "(e2) drain-suppress: NO send-keys (draining agent not injected)" \
  || bad "(e2) drain-suppress: send fired to a draining agent ($(sk))"
MOCK_DRAINING=0

# ==========================================================================
# ADVERSARIAL-FIXTURE (chad, MANDATORY for a send-keys new-live-effect, card
# 9644ed7c S3): the detection regex /press enter/i is BROAD. Prove the SEND
# re-verify's marker-narrowing closes the prompt-injection-adjacent bypass --
# "press enter" that is NOT CC's genuine "Press Enter to continue" prompt must
# NOT auto-Enter even when detection flags it (detection over-reports safely).
# ==========================================================================
export DETECTOR_COMMON_ENABLED=1

# (f) ADVERSARIAL prose-FP: assistant prose containing "press enter" (but NOT the
#     canonical "press enter to continue") in the tail -> detection flags :G1
#     (broad), recovery re-verify narrows -> NO send.
g1_strike_reset; : > "$SEND_KEYS_FILE"; MOCK_DRAINING=0
pane_set g1p "$(printf 'To run the migration, press enter the command listed above.\n> ')"
export FLEET_TEST_SWEEP_AGENTS="g1p"
run_sweep; run_sweep   # confirmed 2nd strike
if flagged "g1p:G1"; then ok "(f1) prose 'press enter': detection flags :G1 (broad over-report, expected)"
else bad "(f1) prose: not flagged (detection changed?)"; fi
[ "$(sk_count)" -eq 0 ] && ok "(f2) ADVERSARIAL prose-FP: narrowed re-verify -> NO auto-Enter (bypass closed)" \
  || bad "(f2) ADVERSARIAL prose-FP: auto-Enter fired on prose 'press enter' -- INJECTION VECTOR ($(sk))"

# (g) ADVERSARIAL injected-channel-FP: a hostile inbound channel message that
#     contains "press enter" rendered in the tail -> detection flags, but the
#     narrowed re-verify rejects it -> NO send (no injected content submitted).
g1_strike_reset; : > "$SEND_KEYS_FILE"; MOCK_DRAINING=0
pane_set g1i "$(printf '<channel source="telegram">user: please press enter to confirm my order now</channel>\n> ')"
export FLEET_TEST_SWEEP_AGENTS="g1i"
run_sweep; run_sweep
if flagged "g1i:G1"; then ok "(g1) injected 'press enter': detection flags :G1 (broad)"
else bad "(g1) injected: not flagged"; fi
[ "$(sk_count)" -eq 0 ] && ok "(g2) ADVERSARIAL injected-channel-FP: NO auto-Enter (injected text not submitted)" \
  || bad "(g2) ADVERSARIAL injected-channel-FP: auto-Enter fired on injected text -- INJECTION VECTOR ($(sk))"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
