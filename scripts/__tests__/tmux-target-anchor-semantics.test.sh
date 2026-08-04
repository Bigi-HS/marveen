#!/usr/bin/env bash
# Behaviour regression for the 2026-08-04 04:56:52 incident (card OPS-106).
#
# The lint (scripts/lint-tmux-session-targets.py) enforces the anchored FORM
# across the tree. This file proves the SEMANTICS the anchor relies on, against a
# real tmux, so that a future tmux release changing them fails here loudly
# instead of silently re-arming the fault. A static guard alone would keep
# passing while the ground moved underneath it.
#
# What happened: `marveen` is a prefix of `marveen-channels`. When `marveen` went
# away, the unanchored liveness check answered 0 about the ORCHESTRATOR session,
# so fleet-supervisor logged "session up but :3420 not responding"; then the
# unanchored kill took `marveen-channels`, rc=0 and no message. Because
# channels.sh starts without --continue, each of those 47 events dropped
# Genesis's entire conversation. It was never just downtime.
#
# Every session here is uniquely named after $$ and every kill in this file is
# anchored, so the live fleet cannot be a target of this suite.
#
# Run: bash scripts/__tests__/tmux-target-anchor-semantics.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SUPERVISOR="$INSTALL_DIR/scripts/fleet-supervisor.sh"
FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMUX_BIN="$(command -v tmux || true)"
if [[ -z "$TMUX_BIN" ]]; then
  echo "  SKIP: no tmux on PATH -- these are semantics tests against the real binary"
  exit 0
fi

BASE="anchortest-$$"
SESSIONS=""
cleanup() {
  local s
  for s in $SESSIONS; do env -u TMUX "$TMUX_BIN" kill-session -t "=$s" 2>/dev/null || true; done
}
trap cleanup EXIT

# Read a session's creation stamp WITHOUT display-message: list-sessions plus an
# exact name match is the only form that both resolves and distinguishes absence
# (no line) from failure. See case 4 for why display-message cannot be used here.
stamp() {
  local out
  out=$(env -u TMUX "$TMUX_BIN" list-sessions -F '#{session_name}|#{session_created}' 2>/dev/null \
        | awk -F'|' -v n="$1" '$1 == n { print $2 }')
  if [[ -n "$out" ]]; then printf '%s\n' "$out"; else printf 'absent\n'; fi
}

# Create a session and PROVE it came up. A case that assumes its fixture exists
# compares two absences and passes without testing anything.
mk() {
  SESSIONS="$SESSIONS $1"
  env -u TMUX "$TMUX_BIN" new-session -d -s "$1" 'sleep 120' 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    [[ "$(stamp "$1")" != "absent" ]] && return 0
    sleep 0.1
  done
  return 1
}

echo "tmux target anchoring semantics (tmux $("$TMUX_BIN" -V | awk '{print $2}'))"

# --- 1. THE DEFECT: an unanchored kill aimed at an ABSENT session takes the
#        sibling that has its name as a prefix. This is the exact shape of the
#        incident, reproduced on throwaway names.
if ! mk "${BASE}-channels"; then
  fail "could not create fixture session ${BASE}-channels -- the cases below would be vacuous"
else
  before=$(stamp "${BASE}-channels")
  env -u TMUX "$TMUX_BIN" kill-session -t "$BASE" 2>/dev/null; rc=$?  # tmux-anchor-lint: ignore
  after=$(stamp "${BASE}-channels")
  if [[ "$before" != "absent" && "$after" == "absent" ]]; then
    pass "unanchored kill of an absent '<name>' destroys '<name>-channels' (rc=$rc, silently)"
  else
    fail "expected the unanchored kill to take the sibling (before=$before after=$after rc=$rc)"
  fi
fi

# --- 2. THE FIX: the same command with the anchor refuses instead, and the
#        sibling lives. `|| true` at the call sites stays necessary: a missing
#        session is now a non-zero exit rather than a silent success.
if ! mk "${BASE}2-channels"; then
  fail "could not create fixture session ${BASE}2-channels"
else
  before=$(stamp "${BASE}2-channels")
  env -u TMUX "$TMUX_BIN" kill-session -t "=${BASE}2" 2>/dev/null; rc=$?
  after=$(stamp "${BASE}2-channels")
  if [[ "$rc" -ne 0 && "$before" == "$after" && "$after" != "absent" ]]; then
    pass "anchored kill of an absent '<name>' refuses (rc=$rc) and the sibling survives"
  else
    fail "anchored kill should have refused and spared the sibling (before=$before after=$after rc=$rc)"
  fi
fi

# --- 3. THE MASKING HALF, and the reason the log said "session up". The liveness
#        check has the same fallback, so it reports the SIBLING as the answer.
if ! mk "${BASE}3-channels"; then
  fail "could not create fixture session ${BASE}3-channels"
else
  env -u TMUX "$TMUX_BIN" has-session -t "${BASE}3" 2>/dev/null; unanchored=$?  # tmux-anchor-lint: ignore
  env -u TMUX "$TMUX_BIN" has-session -t "=${BASE}3" 2>/dev/null; anchored=$?
  if [[ "$unanchored" -eq 0 && "$anchored" -ne 0 ]]; then
    pass "unanchored has-session reports a MISSING session as alive (rc=0); anchored does not (rc=$anchored)"
  else
    fail "expected false-alive unanchored / correct anchored (unanchored=$unanchored anchored=$anchored)"
  fi
fi

# --- 4. WHY THE ANCHOR IS NOT UNIVERSAL. display-message takes a PANE target, so
#        `=NAME` cannot resolve -- and it does not complain: rc=0 with EMPTY
#        output, against a session that EXISTS. A caller written as
#        `$(probe || echo absent)` therefore records '' and reads it as a
#        successful measurement. Anchoring here would manufacture the very
#        failure class this card is about, which is why the lint forbids it.
if ! mk "${BASE}4"; then
  fail "could not create fixture session ${BASE}4"
else
  plain=$(env -u TMUX "$TMUX_BIN" display-message -t "${BASE}4" -p '#{session_created}' 2>/dev/null)
  anchored_out=$(env -u TMUX "$TMUX_BIN" display-message -t "=${BASE}4" -p '#{session_created}' 2>/dev/null); arc=$?  # tmux-anchor-lint: ignore
  listed=$(stamp "${BASE}4")
  if [[ -n "$plain" && -z "$anchored_out" && "$arc" -eq 0 && "$listed" == "$plain" ]]; then
    pass "display-message with '=' yields EMPTY at rc=0 on a live session; list-sessions -F is the correct probe"
  else
    fail "display-message anchoring behaviour changed (plain=$plain anchored=[$anchored_out] rc=$arc listed=$listed)"
  fi
fi

# --- 5. THE SHIPPED PREDICATE, not a copy of it. session_alive() is lifted out of
#        fleet-supervisor.sh and exercised here, so the test fails if someone
#        edits that line back. Testing a re-typed equivalent would prove only
#        that the test agrees with itself.
#
#        THE POSITIVE CONTROL IS NOT OPTIONAL, and Thor is the reason it is here.
#        The first version asserted only the NEGATIVE ("must not say alive") and
#        extracted a single line with grep. So every way of NOT RUNNING collapsed
#        into a pass: reformat the function across several lines with the anchor
#        REMOVED -- the real regression -- and the extraction produces a syntax
#        error, the function stays undefined, the call exits 127, and 127 reads as
#        "not alive". Measured: that mutation passed. My own mutation check missed
#        it because I tried ONE mutation and happened to pick the only shape that
#        keeps the extraction valid.
#
#        So: prove the function EXISTS, prove it says ALIVE for a session that is
#        really there, and only then that it says NOT ALIVE for the missing one.
if [[ ! -r "$SUPERVISOR" ]]; then
  fail "cannot read $SUPERVISOR to extract session_alive()"
else
  # Whole block, not one line: from the definition to the first line that is just
  # a closing brace, so a multi-line reformat is still extracted.
  fn=$(awk '/^session_alive\(\)/ {f=1} f {print} f && /^}/ {exit} f && /;[[:space:]]*}[[:space:]]*$/ {exit}' "$SUPERVISOR")
  if [[ -z "$fn" ]]; then
    fail "session_alive() not found in fleet-supervisor.sh -- update this test to match"
  else
    eval "$fn" 2>/dev/null
    if ! declare -F session_alive >/dev/null; then
      fail "could not define session_alive() from the source -- the extraction is broken, so the assertions below would measure nothing: $fn"
    elif ! mk "${BASE}5"; then
      fail "could not create fixture session ${BASE}5"
    elif ! mk "${BASE}5-channels"; then
      fail "could not create fixture session ${BASE}5-channels"
    else
      TMUX_BIN="$TMUX_BIN"
      if ! session_alive "${BASE}5"; then
        fail "POSITIVE CONTROL: the shipped session_alive() says a session that EXISTS is not alive -- it is not running at all: $fn"
      else
        env -u TMUX "$TMUX_BIN" kill-session -t "=${BASE}5" 2>/dev/null || true
        if session_alive "${BASE}5"; then
          fail "the shipped session_alive() reports a MISSING session as alive: $fn"
        else
          pass "the shipped session_alive() answers alive for a real session and NOT alive once it is gone (sibling present throughout)"
        fi
      fi
    fi
  fi
fi

echo
if [[ "$FAIL" -gt 0 ]]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
