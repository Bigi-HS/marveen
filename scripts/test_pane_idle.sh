#!/bin/bash
# Unit tests for scripts/lib/pane-idle.sh (card 089e78db, FINDING-2).
#
# pane_classify is a PURE function of the captured pane text -- fed here via
# stdin from (a) REAL `capture-pane -p -e` fixtures taken from live agents and
# (b) synthetic printf cases for states not conveniently reproducible live. The
# debounce state machine (pane_idle_accrue) is driven over real temp state files.
#
# Run: bash scripts/test_pane_idle.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/scripts/__tests__/fixtures/pane"
. "$ROOT/scripts/lib/pane-idle.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
assert_eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1 (expected '$2' got '$3')"; }

# ESC helper for synthetic fixtures
E=$'\x1b'
NBSP=$'\xc2\xa0'
CHEV=$'\xe2\x9d\xaf'      # ❯

# ===========================================================================
# pane_classify -- REAL captured fixtures (ground truth)
# ===========================================================================
assert_eq "real empty composer (❯+NBSP+cursor) -> idle" \
  idle "$(pane_classify < "$FIX/real-empty-composer.txt")"
assert_eq "real ghost-text autosuggestion (faint SGR) -> idle" \
  idle "$(pane_classify < "$FIX/real-ghosttext.txt")"
# REAL busy pane: queued input -> composer shows faint "Press up to edit queued
# messages" (looks like an autosuggestion) AND footer shows TRUNCATED "esc to
# inter…". Must be working, NOT idle (this exact case false-idled pre-fix).
assert_eq "real busy pane (queued input + truncated esc-to-inter) -> working" \
  working "$(pane_classify < "$FIX/real-busy-queued.txt")"

# ===========================================================================
# pane_classify -- synthetic states
# ===========================================================================
# Working: braille spinner + esc-to-interrupt footer
printf '%s\n%s[39m%s%s%s[7m %s[0m\nesc to interrupt\n' \
  "$(printf '\xe2\xa0\x8b') Working" "$E" "$CHEV" "$NBSP" "$E" "$E" "$E" \
  | { assert_eq "spinner + esc to interrupt -> working" working "$(pane_classify)"; }

# Working: Thinking line above a clean prompt
printf 'Thinking...\n%s[39m%s%s%s[7m %s[0m\n' "$E" "$CHEV" "$NBSP" "$E" "$E" \
  | { assert_eq "Thinking -> working" working "$(pane_classify)"; }

# Real typed input: normal-intensity text after the chevron (no faint SGR)
printf '%s[39m%s%s%s[7ml%s[0mekerem a nyitott kartyakat\n' "$E" "$CHEV" "$NBSP" "$E" "$E" \
  | { assert_eq "real typed input (normal intensity) -> ambiguous" ambiguous "$(pane_classify)"; }

# Ghost-text synthetic: faint (SGR 2) suggestion after the chevron -> idle
printf '%s[39m%s%s%s[7mk%s[0;2meress ra a kartyara%s[0m\n' "$E" "$CHEV" "$NBSP" "$E" "$E" "$E" \
  | { assert_eq "synthetic faint ghost-text -> idle" idle "$(pane_classify)"; }

# Truncated "esc to inter…" footer above a clean composer -> working
# (narrow-pane truncation must still be caught by the "esc to in" prefix).
printf '%s[39m%s%s%s[7m %s[0m\n  bypass permissions on | esc to inter%s\n' \
  "$E" "$CHEV" "$NBSP" "$E" "$E" "$(printf '\xe2\x80\xa6')" \
  | { assert_eq "truncated 'esc to inter' footer -> working" working "$(pane_classify)"; }

# Faint "Press up to edit queued messages" composer hint -> working (queued input)
printf '%s[38;5;246m%s%s%s[7m%s[39mP%s[0;2mress up to edit queued messages%s[0m\n' \
  "$E" "$CHEV" "$NBSP" "$E" "$E" "$E" "$E" \
  | { assert_eq "queued-messages composer hint -> working" working "$(pane_classify)"; }

# Modal / confirmation prompt (no composer chevron line) -> ambiguous
printf 'Do you want to proceed?\n 1. Yes\n 2. No, tell Claude what to do differently\n' \
  | { assert_eq "modal confirmation (no ❯ line) -> ambiguous" ambiguous "$(pane_classify)"; }

# Hint/status bar only (double chevron ❯❯, leading spaces) must NOT be read as the
# composer prompt -> ambiguous (no real composer line present)
printf '  %s[38;5;211m%s%s bypass permissions on%s[38;5;246m (shift+tab to cycle)%s[39m\n' \
  "$E" "$CHEV" "$CHEV" "$E" "$E" \
  | { assert_eq "hint bar (❯❯) only -> ambiguous, not idle" ambiguous "$(pane_classify)"; }

# Empty capture (dead pane) -> ambiguous (conservative, never idle)
printf '' | { assert_eq "empty capture -> ambiguous" ambiguous "$(pane_classify)"; }

# Clean prompt WITH the hint bar below it (the real live layout) -> idle:
# the classifier must pick the single-chevron composer line, not the ❯❯ bar.
printf '%s[39m%s%s%s[7m %s[0m\n%s[38;5;37m--------%s[39m\n  %s[38;5;211m%s%s bypass permissions%s[39m\n' \
  "$E" "$CHEV" "$NBSP" "$E" "$E" "$E" "$E" "$E" "$CHEV" "$CHEV" "$E" \
  | { assert_eq "empty composer above ❯❯ hint bar -> idle" idle "$(pane_classify)"; }

# ===========================================================================
# _pi_has_faint_sgr -- SGR parameter discrimination
# ===========================================================================
_pi_has_faint_sgr "$E[0;2mx"      && ok "faint \\e[0;2m detected"        || bad "faint \\e[0;2m missed"
_pi_has_faint_sgr "$E[2mx"        && ok "faint \\e[2m detected"          || bad "faint \\e[2m missed"
_pi_has_faint_sgr "$E[38;5;246mx" && bad "256-grey \\e[38;5;246m false-positive faint" || ok "256-grey not faint"
_pi_has_faint_sgr "$E[22mx"       && bad "\\e[22m (normal) false-positive faint"       || ok "\\e[22m not faint"
_pi_has_faint_sgr "$E[27mx"       && bad "\\e[27m false-positive faint"                || ok "\\e[27m not faint"

# ===========================================================================
# pane_idle_accrue -- debounce state machine
# ===========================================================================
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
IDLE="$TMP/idle"; BUSY="$TMP/busy"
NOW=1700000000
reset_files() { rm -f "$IDLE" "$BUSY"; }

# working -> hard reset, echo 0, no files
reset_files; echo "$((NOW-100))" > "$IDLE"; echo 2 > "$BUSY"
r="$(pane_idle_accrue working "$IDLE" "$BUSY" "$NOW" 3)"
assert_eq "working -> echoes 0" 0 "$r"
[ ! -f "$IDLE" ] && ok "working -> idle_file removed" || bad "working -> idle_file must be removed"
[ ! -f "$BUSY" ] && ok "working -> busy_file removed" || bad "working -> busy_file must be removed"

# idle (fresh) -> creates idle_file at now, echoes now, clears busy
reset_files; echo 1 > "$BUSY"
r="$(pane_idle_accrue idle "$IDLE" "$BUSY" "$NOW" 3)"
assert_eq "idle fresh -> echoes now" "$NOW" "$r"
[ -f "$IDLE" ] && ok "idle -> idle_file created" || bad "idle -> idle_file must exist"
[ ! -f "$BUSY" ] && ok "idle -> busy_file cleared" || bad "idle -> busy_file must be cleared"

# idle (continuing) -> preserves original idle_since epoch
reset_files; echo "$((NOW-500))" > "$IDLE"
r="$(pane_idle_accrue idle "$IDLE" "$BUSY" "$NOW" 3)"
assert_eq "idle continuing -> preserves original epoch" "$((NOW-500))" "$r"

# ambiguous transient (below threshold) -> echo 0 but KEEP idle_file
reset_files; echo "$((NOW-500))" > "$IDLE"
r="$(pane_idle_accrue ambiguous "$IDLE" "$BUSY" "$NOW" 3)"
assert_eq "ambiguous #1 -> echoes 0 (never sleep mid-input)" 0 "$r"
[ -f "$IDLE" ] && ok "ambiguous #1 -> idle_file PRESERVED (transient absorb)" || bad "ambiguous #1 must keep idle_file"
assert_eq "ambiguous #1 -> busy count = 1" 1 "$(cat "$BUSY" 2>/dev/null)"
# second consecutive ambiguous, still below k=3 -> still preserved
r="$(pane_idle_accrue ambiguous "$IDLE" "$BUSY" "$NOW" 3)"
assert_eq "ambiguous #2 -> busy count = 2" 2 "$(cat "$BUSY" 2>/dev/null)"
[ -f "$IDLE" ] && ok "ambiguous #2 -> idle_file still preserved" || bad "ambiguous #2 must keep idle_file"
# third consecutive ambiguous, reaches k=3 -> sustained activity -> reset
r="$(pane_idle_accrue ambiguous "$IDLE" "$BUSY" "$NOW" 3)"
assert_eq "ambiguous #3 (>=k) -> echoes 0" 0 "$r"
[ ! -f "$IDLE" ] && ok "ambiguous #3 (>=k) -> idle_file RESET (sustained busy)" || bad "ambiguous #3 must reset idle_file"
[ ! -f "$BUSY" ] && ok "ambiguous #3 (>=k) -> busy_file cleared" || bad "ambiguous #3 must clear busy_file"

# idle after a transient ambiguous run resumes the OLD timer (no lost progress)
reset_files; echo "$((NOW-1700))" > "$IDLE"
pane_idle_accrue ambiguous "$IDLE" "$BUSY" "$NOW" 3 >/dev/null   # transient blip
r="$(pane_idle_accrue idle "$IDLE" "$BUSY" "$NOW" 3)"
assert_eq "idle after transient blip -> resumes old epoch (progress kept)" "$((NOW-1700))" "$r"

# a single ambiguous blip must NOT let an almost-ripe timer sleep this tick
reset_files; echo "$((NOW-1799))" > "$IDLE"
r="$(pane_idle_accrue ambiguous "$IDLE" "$BUSY" "$NOW" 3)"
assert_eq "ambiguous blip on almost-ripe timer -> echoes 0 (no sleep this tick)" 0 "$r"

echo "----"
echo "pane-idle unit: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
