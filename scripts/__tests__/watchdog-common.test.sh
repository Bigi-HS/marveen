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
{ [ "$rc" -eq 3 ] && [ "$out" = "claude-sonnet-4-6" ]; } \
  && ok "wd_read_model: missing file -> default model, rc=3" \
  || bad "wd_read_model: missing file (got rc=$rc out='$out')"

C="$(tmpcfg 'not json at all {{{')"
out="$(wd_read_model "$C" 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 3 ] && [ "$out" = "claude-sonnet-4-6" ]; } \
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
{ [ "$rc" -eq 4 ] && [ "$out" = "claude-sonnet-4-6" ]; } \
  && ok "wd_read_model: no model field -> default model, rc=4" \
  || bad "wd_read_model: no model field (got rc=$rc out='$out')"
rm -f "$C"

C="$(tmpcfg '{"model":""}')"
out="$(wd_read_model "$C" 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 4 ] && [ "$out" = "claude-sonnet-4-6" ]; } \
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
{ [ "$rc" -eq 3 ] && [ "$out" = "claude-sonnet-4-6" ] && [ ! -e "/tmp/wd_pwned_$$" ]; } \
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
  [ "$r" -eq 3 ] && [ "$o" = "claude-sonnet-4-6" ]
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
    3) echo claude-sonnet-4-6 ;;
    *) echo claude-sonnet-4-6 ;;
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
  { grep -q '\. "\$(dirname "\$0")/lib/watchdog-common.sh" || { log "FATAL' "$f" \
      && grep -q 'wd_read_model "\$ACONF"' "$f" \
      && ! grep -q "json.load(open('\$ACONF')" "$f"; } \
    && ok "${w}-watchdog.sh: sources lib w/ F1 guard, calls wd_read_model, inline block removed" \
    || bad "${w}-watchdog.sh: wiring incomplete (guard/call/inline-removal)"
done

echo "----"
echo "watchdog-common: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
