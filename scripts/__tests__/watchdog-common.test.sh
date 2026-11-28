#!/bin/bash
# Tests for scripts/lib/watchdog-common.sh -- the shared watchdog helpers
# (card 0b282eb0, A1 dedup, phase 1: wd_read_model only).
#
# What this proves:
#  1. wd_read_model prints the configured .model for a valid agent-config.json
#     (byte-equivalent to the inline read_model it replaced in thor/hibiki/bond).
#  2. It fails "soft-closed": on a missing/unparseable config or absent model
#     field it emits a LOUD WARN (log + stderr) and prints the DEFAULT model, so
#     the agent is never hard-stopped -- exactly the original inline behaviour.
#  3. F7: the config path is passed via argv, never string-interpolated, so a
#     path containing shell/python metacharacters cannot inject code.
#  4. F4: the lib and wd_read_model are `set -u` safe.
#  5. F1 [CRITICAL]: a broken (syntax-error) lib makes the mandated sourcing
#     guard `. lib || { log FATAL; exit 1; }` exit 1 -- it does NOT silently
#     continue into a false-healthy loop.
#
# Run: bash scripts/__tests__/watchdog-common.test.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$ROOT/scripts/lib/watchdog-common.sh"
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# shellcheck disable=SC1090
. "$LIB"

tmpcfg() { local d; d="$(mktemp)"; printf '%s' "$1" > "$d"; printf '%s' "$d"; }

# ---- wd_read_model: happy path ---------------------------------------------
C="$(tmpcfg '{"model":"claude-opus-4-8","displayName":"Thor"}')"
out="$(wd_read_model "$C")"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$out" = "claude-opus-4-8" ]; } \
  && ok "wd_read_model: valid config prints model, rc=0" \
  || bad "wd_read_model: valid config (got rc=$rc out='$out')"
rm -f "$C"

C="$(tmpcfg '{"model":"claude-sonnet-4-6"}')"
out="$(wd_read_model "$C")"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$out" = "claude-sonnet-4-6" ]; } \
  && ok "wd_read_model: model-only config prints model" \
  || bad "wd_read_model: model-only config (got rc=$rc out='$out')"
rm -f "$C"

# ---- wd_read_model: missing / unparseable -> WARN + DEFAULT, rc=3 -----------
# (byte-equivalent to the inline block: prints default, never hard-stops)
out="$(wd_read_model "/no/such/file.json" 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 3 ] && [ "$out" = "claude-sonnet-5-5" ]; } \
  && ok "wd_read_model: missing file -> default model, rc=3" \
  || bad "wd_read_model: missing file (got rc=$rc out='$out')"

C="$(tmpcfg 'not json at all {{{')"
out="$(wd_read_model "$C" 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 3 ] && [ "$out" = "claude-sonnet-5-5" ]; } \
  && ok "wd_read_model: unparseable json -> default model, rc=3" \
  || bad "wd_read_model: unparseable (got rc=$rc out='$out')"
rm -f "$C"

# WARN must be LOUD: written to stderr AND to $WD_LOG_FILE when set.
C="$(tmpcfg 'garbage')"
LOGF="$(mktemp)"
err="$(WD_LOG_FILE="$LOGF" wd_read_model "$C" 2>&1 >/dev/null)"
{ printf '%s' "$err" | grep -q 'WARN read_model' && grep -q 'WARN read_model' "$LOGF"; } \
  && ok "wd_read_model: LOUD warn goes to BOTH stderr and WD_LOG_FILE" \
  || bad "wd_read_model: warn not on both stderr+log (stderr='$err')"
rm -f "$C" "$LOGF"

# ---- wd_read_model: absent / empty model field -> WARN + DEFAULT, rc=4 ------
C="$(tmpcfg '{"displayName":"x"}')"
out="$(wd_read_model "$C" 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 4 ] && [ "$out" = "claude-sonnet-5-5" ]; } \
  && ok "wd_read_model: no model field -> default model, rc=4" \
  || bad "wd_read_model: no model field (got rc=$rc out='$out')"
rm -f "$C"

C="$(tmpcfg '{"model":""}')"
out="$(wd_read_model "$C" 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 4 ] && [ "$out" = "claude-sonnet-5-5" ]; } \
  && ok "wd_read_model: empty model -> default model, rc=4" \
  || bad "wd_read_model: empty model (got rc=$rc out='$out')"
rm -f "$C"

# ---- optional [default-model] override -------------------------------------
out="$(wd_read_model "/no/such/file.json" "claude-haiku-x" 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 3 ] && [ "$out" = "claude-haiku-x" ]; } \
  && ok "wd_read_model: honours explicit default-model arg" \
  || bad "wd_read_model: default override (got rc=$rc out='$out')"

# ---- F7: path is argv, not interpolated (no code injection) ----------------
# A path whose NAME contains python/shell metacharacters must be treated as a
# literal (nonexistent) path -> default, NOT executed. If it were interpolated
# into open('...'), this would raise/execute differently; argv keeps it inert.
EVIL="/tmp/does not exist')+__import__('os').system('touch /tmp/wd_pwned_$$');#"
rm -f "/tmp/wd_pwned_$$"
out="$(wd_read_model "$EVIL" 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 3 ] && [ "$out" = "claude-sonnet-5-5" ] && [ ! -e "/tmp/wd_pwned_$$" ]; } \
  && ok "wd_read_model: F7 metachar path is inert argv (no injection)" \
  || bad "wd_read_model: F7 injection surface (rc=$rc out='$out' pwned=$( [ -e /tmp/wd_pwned_$$ ] && echo YES ))"
rm -f "/tmp/wd_pwned_$$"

# ---- F4: set -u safe (called with no WD_LOG_FILE, no default arg) -----------
( set -u
  unset WD_LOG_FILE 2>/dev/null || true
  C2="$(mktemp)"; printf '{"model":"m1"}' > "$C2"
  o="$(wd_read_model "$C2")"; r=$?
  rm -f "$C2"
  [ "$r" -eq 0 ] && [ "$o" = "m1" ]
) && ok "wd_read_model: F4 set -u safe (unset WD_LOG_FILE, happy path)" \
  || bad "wd_read_model: F4 set -u regression"

( set -u
  unset WD_LOG_FILE 2>/dev/null || true
  o="$(wd_read_model "/no/such" 2>/dev/null)"; r=$?
  [ "$r" -eq 3 ] && [ "$o" = "claude-sonnet-5-5" ]
) && ok "wd_read_model: F4 set -u safe on WARN branch (no unbound var)" \
  || bad "wd_read_model: F4 set -u regression on WARN branch"

# ---- byte-equivalence vs the original inline block -------------------------
# Reconstruct the ORIGINAL inline read_model exactly (thor-watchdog.sh:24-46,
# pre-dedup) and assert identical stdout for the same inputs.
orig_read_model() {
  local ACONF="$1" model
  model="$(python3 -c "import json,sys
try:
    m=json.load(open('$ACONF')).get('model')
except Exception:
    sys.exit(3)
if not m:
    sys.exit(4)
print(m)" 2>/dev/null)"
  case "$?" in
    0) printf '%s\n' "$model" ;;
    3) echo claude-sonnet-5-5 ;;  # card df481439: default updated to 5-5
    *) echo claude-sonnet-5-5 ;;  # card df481439: default updated to 5-5
  esac
}
equiv_ok=1
for payload in '{"model":"claude-opus-4-8"}' '{"model":"x-y-z"}' '{"displayName":"a"}' '{"model":""}' 'garbage{{{'; do
  C="$(tmpcfg "$payload")"
  a="$(orig_read_model "$C" 2>/dev/null)"
  b="$(wd_read_model "$C" 2>/dev/null)"
  [ "$a" = "$b" ] || { equiv_ok=0; echo "  DIFF payload='$payload' orig='$a' new='$b'"; }
  rm -f "$C"
done
a="$(orig_read_model "/no/such" 2>/dev/null)"; b="$(wd_read_model "/no/such" 2>/dev/null)"
[ "$a" = "$b" ] || { equiv_ok=0; echo "  DIFF missing-file orig='$a' new='$b'"; }
[ "$equiv_ok" -eq 1 ] \
  && ok "wd_read_model: stdout byte-equivalent to original inline block" \
  || bad "wd_read_model: stdout DIVERGES from original inline block"

# ---- F1 [CRITICAL]: broken lib -> sourcing guard exits 1, no silent-continue -
# Simulate the exact mandated sourcing line against a CORRUPTED lib (syntax
# error). The guard must run the failure branch (exit 1), NOT fall through.
BROKEN="$(mktemp)"
printf 'wd_read_model() {\n  this is not valid bash ((( \n' > "$BROKEN"   # unterminated func
GUARD_OUT="$(
  bash -c '
    log() { echo "LOGGED: $*"; }
    . "'"$BROKEN"'" || { log "FATAL: watchdog-common.sh source failed"; exit 1; }
    echo "REACHED-AFTER-SOURCE"   # must NEVER print on a broken lib
  ' 2>/dev/null
)"
GUARD_RC=$?
{ [ "$GUARD_RC" -eq 1 ] \
    && printf '%s' "$GUARD_OUT" | grep -q 'FATAL' \
    && ! printf '%s' "$GUARD_OUT" | grep -q 'REACHED-AFTER-SOURCE'; } \
  && ok "F1: broken lib -> guard exits 1 + FATAL log, never continues (fail-closed)" \
  || bad "F1: broken lib did NOT fail closed (rc=$GUARD_RC out='$GUARD_OUT')"
rm -f "$BROKEN"

# ---- F1 corollary: a MISSING lib file also fails closed --------------------
GUARD_OUT="$(
  bash -c '
    log() { echo "LOGGED: $*"; }
    . "/no/such/lib/watchdog-common.sh" || { log "FATAL: watchdog-common.sh source failed"; exit 1; }
    echo "REACHED-AFTER-SOURCE"
  ' 2>/dev/null
)"
GUARD_RC=$?
{ [ "$GUARD_RC" -eq 1 ] && ! printf '%s' "$GUARD_OUT" | grep -q 'REACHED-AFTER-SOURCE'; } \
  && ok "F1: missing lib file -> guard exits 1, never continues" \
  || bad "F1: missing lib did NOT fail closed (rc=$GUARD_RC out='$GUARD_OUT')"

# ---- every phase-1 watchdog actually carries the F1 guard + wrapper --------
# thor/hibiki/bond were the PR#423 pilot; the rest are wired in this change.
# Every read_model-bearing watchdog ON DEVELOP must source the lib with the
# fail-CLOSED guard, call wd_read_model, and no longer carry the inline python
# heredoc. (scout-watchdog.sh is untracked / not yet on develop -> wired when it
# lands upstream, deliberately excluded here.)
for w in thor hibiki bond agent bigben chad claudia dave devil-advocate forge gyore percy; do
  f="$ROOT/scripts/${w}-watchdog.sh"
  # Match the fail-CLOSED source-guard independent of the dirname form: some
  # watchdogs use `$(dirname "$0")`, others the equivalent-or-better
  # `$(dirname "${BASH_SOURCE[0]}")`. Both are correct; assert the stable,
  # variant-independent tail `/lib/watchdog-common.sh" || { log "FATAL` so a
  # legitimate BASH_SOURCE variant is not a false-negative (was: gyore red).
  { grep -q '/lib/watchdog-common.sh" || { log "FATAL' "$f" \
      && grep -q 'wd_read_model "\$ACONF"' "$f" \
      && ! grep -q "json.load(open('\$ACONF')" "$f"; } \
    && ok "${w}-watchdog.sh: sources lib w/ F1 guard, calls wd_read_model, inline block removed" \
    || bad "${w}-watchdog.sh: wiring incomplete (guard/call/inline-removal)"
done

# ---- ROLLOUT GATE (card 1e87e051, OPS-127) ---------------------------------
# R1: gate CLOSED (default) -> reads from config AND logs "gate CLOSED"
C="$(tmpcfg '{"model":"claude-opus-4-8"}')"
gate_err="$(WD_READ_MODEL_ENABLED=0 WD_LOG_FILE="" wd_read_model "$C" 2>&1 >/dev/null)"
gate_out="$(WD_READ_MODEL_ENABLED=0 wd_read_model "$C" 2>/dev/null)"
{ [ "$gate_out" = "claude-opus-4-8" ] && printf '%s' "$gate_err" | grep -q "gate CLOSED"; } \
  && ok "R1: gate CLOSED -> reads config model + logs 'gate CLOSED'" \
  || bad "R1: gate CLOSED (out='$gate_out' log='$gate_err')"
rm -f "$C"

# R2: gate OPEN -> reads from config AND logs "gate OPEN"
C="$(tmpcfg '{"model":"claude-haiku-4-5"}')"
gate_err="$(WD_READ_MODEL_ENABLED=1 WD_LOG_FILE="" wd_read_model "$C" 2>&1 >/dev/null)"
gate_out="$(WD_READ_MODEL_ENABLED=1 wd_read_model "$C" 2>/dev/null)"
{ [ "$gate_out" = "claude-haiku-4-5" ] && printf '%s' "$gate_err" | grep -q "gate OPEN"; } \
  && ok "R2: gate OPEN -> reads config model + logs 'gate OPEN'" \
  || bad "R2: gate OPEN (out='$gate_out' log='$gate_err')"
rm -f "$C"

# R3: gate UNSET (no env) -> defaults to CLOSED behaviour (reads config, logs CLOSED)
C="$(tmpcfg '{"model":"claude-sonnet-4-6"}')"
gate_err="$(unset WD_READ_MODEL_ENABLED 2>/dev/null; WD_LOG_FILE="" wd_read_model "$C" 2>&1 >/dev/null)"
gate_out="$(unset WD_READ_MODEL_ENABLED 2>/dev/null; wd_read_model "$C" 2>/dev/null)"
{ [ "$gate_out" = "claude-sonnet-4-6" ] && printf '%s' "$gate_err" | grep -q "gate CLOSED"; } \
  && ok "R3: gate UNSET -> defaults to CLOSED (reads config, logs CLOSED)" \
  || bad "R3: gate UNSET (out='$gate_out' log='$gate_err')"
rm -f "$C"
# ---- Stuck-detection guard (card e6ab511d, OPS-038) -----------------------
# S1: wd_stuck_count returns 0 for a missing state file.
STATE="$(mktemp)"
rm -f "$STATE"  # ensure absent
[ "$(wd_stuck_count "$STATE")" -eq 0 ] \
  && ok "S1: wd_stuck_count returns 0 for missing state file" \
  || bad "S1: expected 0, got $(wd_stuck_count "$STATE")"

# S2: wd_stuck_record increments count for the same error type.
STATE="$(mktemp)"
wd_stuck_record "$STATE" "crash"
wd_stuck_record "$STATE" "crash"
wd_stuck_record "$STATE" "crash"
[ "$(wd_stuck_count "$STATE")" -eq 3 ] \
  && ok "S2: wd_stuck_record increments count for same error type (3x crash)" \
  || bad "S2: expected 3, got $(wd_stuck_count "$STATE")"
rm -f "$STATE"

# S3: wd_stuck_record resets count on type change.
STATE="$(mktemp)"
wd_stuck_record "$STATE" "crash"
wd_stuck_record "$STATE" "crash"
wd_stuck_record "$STATE" "timeout"  # different type -> resets to 1
[ "$(wd_stuck_count "$STATE")" -eq 1 ] \
  && ok "S3: wd_stuck_record resets count on error-type change" \
  || bad "S3: expected 1, got $(wd_stuck_count "$STATE")"
rm -f "$STATE"

# S4: wd_stuck_reset removes the state file (count -> 0).
STATE="$(mktemp)"
wd_stuck_record "$STATE" "crash"
wd_stuck_reset "$STATE"
[ "$(wd_stuck_count "$STATE")" -eq 0 ] \
  && ok "S4: wd_stuck_reset clears state (count returns 0)" \
  || bad "S4: expected 0 after reset, got $(wd_stuck_count "$STATE")"

# S5: wd_stuck_should_intervene returns true (0) at threshold.
wd_stuck_should_intervene 3 3 \
  && ok "S5: wd_stuck_should_intervene fires at count=threshold (3>=3)" \
  || bad "S5: expected intervention at 3 >= 3"

# S6: wd_stuck_should_intervene returns false (1) below threshold.
wd_stuck_should_intervene 2 3
[ $? -ne 0 ] \
  && ok "S6: wd_stuck_should_intervene does NOT fire below threshold (2<3)" \
  || bad "S6: should not intervene at 2 < 3"

# S7: set -u safe -- wd_stuck_* with no args must not crash.
( set -u
  out1=$(wd_stuck_count "" 2>/dev/null); r1=$?
  wd_stuck_reset "" 2>/dev/null; r2=$?
  [ "$r1" -eq 0 ] && [ "$r2" -eq 0 ]
) && ok "S7: wd_stuck_count/reset safe under set -u with empty args" \
  || bad "S7: set -u regression on empty args"

# ---- Budget-pause guard (card e6ab511d, OPS-038) ----------------------------
# Helpers: write a marker with a given expiresAt (epoch-ms).
STORE_TMP="$(mktemp -d)"
write_marker() {
  local agent="$1" expires_at="$2"
  printf '{"expiresAt":%s,"weekStartMs":0,"triggeredAtPct":85}' "$expires_at" \
    > "${STORE_TMP}/.${agent}-budget-pause"
}

# B1: missing marker -> not paused (fail-safe).
rm -f "${STORE_TMP}/.b1test-budget-pause"
wd_budget_paused "b1test" "$STORE_TMP"
[ $? -ne 0 ] \
  && ok "B1: missing marker -> not paused (fail-safe)" \
  || bad "B1: missing marker should return 1 (not paused)"

# B2: active marker (expires far in future) -> paused.
write_marker "b2test" "$(python3 -c 'import time; print(int((time.time()+86400)*1000))')"
wd_budget_paused "b2test" "$STORE_TMP"
[ $? -eq 0 ] \
  && ok "B2: active marker (future expiresAt) -> paused (returns 0)" \
  || bad "B2: expected paused (rc=0) for future expiresAt"

# B3: expired marker (expiresAt in the past) -> not paused.
write_marker "b3test" "1000"   # epoch-ms 1 = 1970; always expired
wd_budget_paused "b3test" "$STORE_TMP"
[ $? -ne 0 ] \
  && ok "B3: expired marker (past expiresAt) -> not paused (fail-safe)" \
  || bad "B3: expired marker should return 1 (not paused)"

# B4: corrupt / non-JSON marker -> not paused (fail-safe).
printf 'not json {{{' > "${STORE_TMP}/.b4test-budget-pause"
wd_budget_paused "b4test" "$STORE_TMP"
[ $? -ne 0 ] \
  && ok "B4: corrupt marker -> not paused (fail-safe)" \
  || bad "B4: corrupt marker should return 1 (not paused)"

# B5: empty agent arg -> not paused (no state file path constructed).
wd_budget_paused "" "$STORE_TMP"
[ $? -ne 0 ] \
  && ok "B5: empty agent arg -> not paused" \
  || bad "B5: empty agent should return 1"

rm -rf "$STORE_TMP"

# ---- wd_relaunch: restart-throttle chokepoint (step5, card 05c1671f) --------
# What this proves:
#  W1  gate CLOSED (default) -> plain relaunch, throttle NOT consulted (so a
#      call-site migration is behaviour-neutral).
#  W2  gate OPEN + throttle check=ok -> relaunch happens.
#  W3  [FALSIFYING, dangerous side] gate OPEN + throttle check=HALTED -> tmux
#      new-session is NOT called (no extra "double-restart"); returns 1. This is
#      the Thor #886 FLAG-1 ordering guarantee: the check is unskippable.
#  W4  gate OPEN + record-restart trips halt -> THIS launch still happens; halt
#      blocks the NEXT call (threshold = the max-th restart is allowed).
#  W5  missing args -> return 1, no relaunch.
#  W6  set -u safe with empty args.
#
# Mocking: `tmux` is shadowed by a shell function that records calls to a log
# file (bash functions take precedence over external commands). throttle.py is
# replaced by tiny python fakes passed as the 4th arg (argv[1] = subcommand).
RELDIR="$(mktemp -d)"
TMUX_LOG="$RELDIR/tmux.log"
: > "$TMUX_LOG"
tmux() { echo "TMUX_CALLED $*" >> "$TMUX_LOG"; return 0; }

FAKE_OK="$RELDIR/throttle_ok.py"       # check -> 0, record-restart -> 0
printf '%s\n' 'import sys' 'sub=sys.argv[1] if len(sys.argv)>1 else ""' 'print("{}")' 'sys.exit(0)' > "$FAKE_OK"
FAKE_HALT="$RELDIR/throttle_halt.py"   # check -> 1 (halted/unreadable), else 0
printf '%s\n' 'import sys' 'sub=sys.argv[1] if len(sys.argv)>1 else ""' 'sys.exit(1 if sub=="check" else 0)' > "$FAKE_HALT"
FAKE_TRIP="$RELDIR/throttle_trip.py"   # check -> 0, record-restart -> 1 (just tripped)
printf '%s\n' 'import sys' 'sub=sys.argv[1] if len(sys.argv)>1 else ""' 'print("{}")' 'sys.exit(1 if sub=="record-restart" else 0)' > "$FAKE_TRIP"

# W1: gate CLOSED (default) -> relaunch via tmux, throttle NOT consulted.
: > "$TMUX_LOG"
( unset WD_THROTTLE_ENABLED 2>/dev/null
  wd_relaunch "wtest" "agent-wtest" "sleep 1" "$FAKE_HALT" ) >/dev/null 2>&1
rc=$?
{ [ "$rc" -eq 0 ] && grep -q 'TMUX_CALLED new-session -d -s agent-wtest' "$TMUX_LOG"; } \
  && ok "W1: gate CLOSED -> plain relaunch, throttle ignored (even a HALT fake)" \
  || bad "W1: gate CLOSED (rc=$rc tmux='$(cat "$TMUX_LOG")')"

# W2: gate OPEN + check ok -> relaunch happens.
: > "$TMUX_LOG"
( WD_THROTTLE_ENABLED=1 wd_relaunch "wtest" "agent-wtest" "sleep 1" "$FAKE_OK" ) >/dev/null 2>&1
rc=$?
{ [ "$rc" -eq 0 ] && grep -q 'TMUX_CALLED new-session -d -s agent-wtest' "$TMUX_LOG"; } \
  && ok "W2: gate OPEN + check ok -> relaunch performed" \
  || bad "W2: gate OPEN check-ok (rc=$rc tmux='$(cat "$TMUX_LOG")')"

# W3 [FALSIFYING]: gate OPEN + check HALTED -> tmux NOT called, return 1.
: > "$TMUX_LOG"
( WD_THROTTLE_ENABLED=1 wd_relaunch "wtest" "agent-wtest" "sleep 1" "$FAKE_HALT" ) >/dev/null 2>&1
rc=$?
{ [ "$rc" -eq 1 ] && ! grep -q 'TMUX_CALLED' "$TMUX_LOG"; } \
  && ok "W3: gate OPEN + HALTED -> NO relaunch (no double-restart), rc=1 [Thor #886 FLAG-1]" \
  || bad "W3: HALTED still relaunched! (rc=$rc tmux='$(cat "$TMUX_LOG")')"

# W4: gate OPEN + record-restart trips halt -> this launch STILL happens (rc 0).
: > "$TMUX_LOG"
( WD_THROTTLE_ENABLED=1 wd_relaunch "wtest" "agent-wtest" "sleep 1" "$FAKE_TRIP" ) >/dev/null 2>&1
rc=$?
{ [ "$rc" -eq 0 ] && grep -q 'TMUX_CALLED' "$TMUX_LOG"; } \
  && ok "W4: gate OPEN + record-restart trips -> launch still occurs; halt blocks NEXT call" \
  || bad "W4: trip-on-record (rc=$rc tmux='$(cat "$TMUX_LOG")')"

# W5: missing args -> return 1, no relaunch.
: > "$TMUX_LOG"
( WD_THROTTLE_ENABLED=1 wd_relaunch "wtest" "" "sleep 1" "$FAKE_OK" ) >/dev/null 2>&1
rc=$?
{ [ "$rc" -eq 1 ] && ! grep -q 'TMUX_CALLED' "$TMUX_LOG"; } \
  && ok "W5: missing session arg -> return 1, no relaunch" \
  || bad "W5: missing-arg (rc=$rc tmux='$(cat "$TMUX_LOG")')"

# W6: set -u safe with empty args.
( set -u
  WD_THROTTLE_ENABLED=1 wd_relaunch "" "" "" 2>/dev/null; r=$?
  [ "$r" -eq 1 ] ) \
  && ok "W6: wd_relaunch safe under set -u with empty args" \
  || bad "W6: set -u regression on empty args"

# W7 [FALSIFYING, diagnosability side -- FLAG-2, Thor #887]: gate OPEN + the
# throttle check emits a diagnostic on stderr -> that stderr is routed to
# WD_LOG_FILE (NOT fully swallowed), so a post-canary-flip halt is debuggable.
# Falsifying the dangerous side: if stderr were `>/dev/null 2>&1`-swallowed (the
# pre-fix behaviour), the diagnostic would NOT appear in the log and this fails.
: > "$TMUX_LOG"
FAKE_HALT_NOISY="$RELDIR/throttle_halt_noisy.py"   # check -> stderr + exit 1
printf '%s\n' 'import sys' 'sub=sys.argv[1] if len(sys.argv)>1 else ""' 'sys.stderr.write("THROTTLE_DIAG halt-reason agent\n")' 'sys.exit(1 if sub=="check" else 0)' > "$FAKE_HALT_NOISY"
W7LOG="$RELDIR/w7.log"; : > "$W7LOG"
( WD_THROTTLE_ENABLED=1 WD_LOG_FILE="$W7LOG" \
    wd_relaunch "wtest" "agent-wtest" "sleep 1" "$FAKE_HALT_NOISY" ) >/dev/null 2>&1
rc=$?
{ [ "$rc" -eq 1 ] && ! grep -q 'TMUX_CALLED' "$TMUX_LOG" && grep -q 'THROTTLE_DIAG' "$W7LOG"; } \
  && ok "W7: gate OPEN + HALT -> check stderr routed to WD_LOG_FILE (FLAG-2 diagnosable), no relaunch" \
  || bad "W7: check stderr swallowed or relaunch happened (rc=$rc log='$(cat "$W7LOG")')"

unset -f tmux
rm -rf "$RELDIR"

# ---- CALL-SITE MIGRATION completeness (step5 Phase-5b, card 05c1671f) -------
# Every standard per-agent watchdog relaunches THROUGH the wd_relaunch chokepoint
# (so the throttle cannot be bypassed) and no longer carries a raw relaunch
# `tmux new-session -d -s "$SESSION" "$cmd"`. The gate stays default-CLOSED, so
# the migration is behaviour-neutral until the Boss-gated canary -- but the WIRING
# must be complete now. (servo-skull-watchdog.sh is untracked / not yet on develop
# -> migrated when it lands upstream, deliberately excluded, mirroring the F1 list.)
for w in agent bigben blackbart bond buster chad claudia dave devil-advocate \
         forge gyore hibiki local-agent percy scout sleep-agent thor; do
  f="$ROOT/scripts/${w}-watchdog.sh"
  [ -f "$f" ] || { bad "${w}-watchdog.sh: missing (cannot verify call-site migration)"; continue; }
  # Must route through the chokepoint with the uniform agent-id derivation...
  { grep -q 'wd_relaunch "${SESSION#agent-}" "$SESSION" "$cmd"' "$f" \
      && ! grep -q 'tmux new-session -d -s "$SESSION" "$cmd"' "$f"; } \
    && ok "${w}-watchdog.sh: relaunch migrated to wd_relaunch chokepoint, no raw tmux relaunch" \
    || bad "${w}-watchdog.sh: call-site migration incomplete (missing wd_relaunch or raw tmux relaunch remains)"
done

# ---- wd_check_telegram_pipe: MCP-pipe liveness probe (card 1c024355) --------
# State JSON schema: { "consecutiveDead": N, "lastHealthyTs": N|null,
#                      "alerted": bool, "lastCheckedTs": N|null }
# Returns:
#   0 = pipe ALIVE (fresh state file, consecutiveDead==0)
#   1 = pipe DEAD  (fresh state file, consecutiveDead>0 OR stale file)
#   2 = INCONCLUSIVE (file absent, gate CLOSED, or parse-error/unreadable)
#
# Helper: write a state JSON with the given consecutiveDead into a temp store dir.
# The mtime is current (fresh) unless the caller adjusts it afterwards.
PIPE_STORE="$(mktemp -d)"
write_pipe_state() {
  local agent="$1" consecutive_dead="$2"
  printf '{"consecutiveDead":%s,"alerted":false,"lastHealthyTs":null,"lastCheckedTs":null}' \
    "$consecutive_dead" > "${PIPE_STORE}/pipe-watchdog.${agent}.state.json"
}

# T1: state file absent -> rc=2 (inconclusive)
rm -f "${PIPE_STORE}/pipe-watchdog.t1test.state.json"
WD_PIPE_CHECK_ENABLED=1 wd_check_telegram_pipe "t1test" "$PIPE_STORE" 2>/dev/null
[ $? -eq 2 ] \
  && ok "T1: absent state file -> rc=2 (inconclusive)" \
  || bad "T1: absent state file should give rc=2 (inconclusive)"

# T2: state file exists, fresh, consecutiveDead=0 -> rc=0 (alive)
write_pipe_state "t2test" 0
WD_PIPE_CHECK_ENABLED=1 wd_check_telegram_pipe "t2test" "$PIPE_STORE" 2>/dev/null
[ $? -eq 0 ] \
  && ok "T2: fresh state, consecutiveDead=0 -> rc=0 (alive)" \
  || bad "T2: expected rc=0 (alive)"

# T3: state file exists, fresh, consecutiveDead=2 -> rc=1 (dead)
write_pipe_state "t3test" 2
WD_PIPE_CHECK_ENABLED=1 wd_check_telegram_pipe "t3test" "$PIPE_STORE" 2>/dev/null
[ $? -eq 1 ] \
  && ok "T3: fresh state, consecutiveDead=2 -> rc=1 (dead)" \
  || bad "T3: expected rc=1 (dead)"

# T4: state file stale (mtime > 6 min ago) -> rc=1 (dead/stale)
write_pipe_state "t4test" 0
# Set mtime to 10 minutes ago (600s ago)
OLD_TS="$(date -d '10 minutes ago' '+%Y%m%d%H%M.%S' 2>/dev/null || date -v-10M '+%Y%m%d%H%M.%S' 2>/dev/null || true)"
if [ -n "$OLD_TS" ]; then
  touch -t "$OLD_TS" "${PIPE_STORE}/pipe-watchdog.t4test.state.json"
  WD_PIPE_CHECK_ENABLED=1 wd_check_telegram_pipe "t4test" "$PIPE_STORE" 2>/dev/null
  [ $? -eq 1 ] \
    && ok "T4: stale state file (mtime > 6min) -> rc=1 (dead/stale)" \
    || bad "T4: expected rc=1 for stale state"
else
  ok "T4: SKIPPED (date -d unavailable on this platform)"
fi

# T5: WD_PIPE_CHECK_ENABLED=0 (gate CLOSED) -> rc=2 always, even with alive state
write_pipe_state "t5test" 0
WD_PIPE_CHECK_ENABLED=0 wd_check_telegram_pipe "t5test" "$PIPE_STORE" 2>/dev/null
[ $? -eq 2 ] \
  && ok "T5: gate CLOSED (WD_PIPE_CHECK_ENABLED=0) -> rc=2 (inconclusive) always" \
  || bad "T5: gate CLOSED should return rc=2"

# T5b: gate UNSET (default) -> rc=2 (gate CLOSED by default)
( unset WD_PIPE_CHECK_ENABLED 2>/dev/null
  wd_check_telegram_pipe "t5test" "$PIPE_STORE" 2>/dev/null )
[ $? -eq 2 ] \
  && ok "T5b: gate UNSET -> defaults to CLOSED (rc=2)" \
  || bad "T5b: gate UNSET should default to CLOSED (rc=2)"

# T6: WD_PIPE_CHECK_ENABLED=1 (gate OPEN) + alive file -> rc=0
write_pipe_state "t6test" 0
WD_PIPE_CHECK_ENABLED=1 wd_check_telegram_pipe "t6test" "$PIPE_STORE" 2>/dev/null
[ $? -eq 0 ] \
  && ok "T6: gate OPEN (WD_PIPE_CHECK_ENABLED=1) + alive state -> rc=0 (alive)" \
  || bad "T6: gate OPEN + alive should return rc=0"

# T7: empty agent arg -> rc=2 (inconclusive, no-op)
WD_PIPE_CHECK_ENABLED=1 wd_check_telegram_pipe "" "$PIPE_STORE" 2>/dev/null
[ $? -eq 2 ] \
  && ok "T7: empty agent arg -> rc=2 (inconclusive)" \
  || bad "T7: empty agent should return rc=2"

# T8: set -u safe -- wd_check_telegram_pipe with no WD_STORE_DIR, no WD_LOG_FILE
( set -u
  unset WD_PIPE_CHECK_ENABLED 2>/dev/null || true
  unset WD_STORE_DIR 2>/dev/null || true
  unset WD_LOG_FILE 2>/dev/null || true
  wd_check_telegram_pipe "t8test" "$PIPE_STORE" 2>/dev/null; r=$?
  [ "$r" -eq 2 ]  # gate CLOSED -> inconclusive
) && ok "T8: wd_check_telegram_pipe safe under set -u (gate CLOSED, no env vars)" \
  || bad "T8: set -u regression"

# T_parse_error: corrupt JSON file (parse-error) -> rc=2 (inconclusive, fail-safe)
# Verifies that an unreadable/corrupt state file does NOT trigger recovery (card 75dfe749).
printf 'not json {{{' > "${PIPE_STORE}/pipe-watchdog.tparsetest.state.json"
WD_PIPE_CHECK_ENABLED=1 wd_check_telegram_pipe "tparsetest" "$PIPE_STORE" 2>/dev/null
[ $? -eq 2 ] \
  && ok "T_parse_error: corrupt JSON state file -> rc=2 (inconclusive, fail-safe)" \
  || bad "T_parse_error: corrupt JSON should give rc=2 (inconclusive), not rc=1 (dead)"

rm -rf "$PIPE_STORE"

# ---- hibiki-watchdog.sh: pipe-check integration (card 1c024355) ------------
# Structural checks: the patched watchdog must carry the pipe-check block.
HIBIKI_WD="$ROOT/scripts/hibiki-watchdog.sh"
{ grep -q 'WD_PIPE_CHECK_ENABLED' "$HIBIKI_WD" \
    && grep -q 'wd_check_telegram_pipe' "$HIBIKI_WD" \
    && grep -q 'pipe DEAD' "$HIBIKI_WD"; } \
  && ok "hibiki-watchdog.sh: pipe-check integration present (WD_PIPE_CHECK_ENABLED + wd_check_telegram_pipe + dead-log)" \
  || bad "hibiki-watchdog.sh: pipe-check integration missing"

echo "----"
echo "watchdog-common: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
