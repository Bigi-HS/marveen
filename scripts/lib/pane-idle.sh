#!/bin/bash
# scripts/lib/pane-idle.sh -- shared pane idle/working classifier for the agent
# sleep watchdog (sleep-agent-watchdog.sh) and the supervisor idle-nudge
# (fleet-supervisor.sh). SINGLE SOURCE OF TRUTH so the two callers can never
# diverge on pane parsing (card 089e78db, FINDING-2; sibling of FINDING-1
# card 86c3904e).
#
# WHY THIS EXISTS
# ---------------
# The old detector matched idle ONLY via `grep -qE '^❯[[:space:]]*$'` on the last
# few `capture-pane -p` lines. Two independent defects made it near-useless:
#
#   1. NBSP prompt.  An empty Claude Code composer renders as `❯ ` (chevron +
#      U+00A0 NON-BREAKING space), NOT `❯ ` (ASCII space). Under the runtime
#      locale (C.UTF-8) `[[:space:]]` does NOT match U+00A0, so the exact-empty
#      regex never matched even a genuinely idle pane.
#   2. Ghost-text.  The TUI draws a context autosuggestion (ghost-text) on the
#      composer line even when the composer is empty (e.g. `❯ lekerem a kartyat`).
#      `capture-pane -p` strips ANSI, so that dim suggestion is byte-identical to
#      real typed input -> impossible to tell "idle with a suggestion" from
#      "user is typing".
#
# Net effect: a sleep-eligible agent almost never accrued idle time during the
# day, so it almost never slept -> the sleep-mode RAM saving was unrealized in
# active hours.
#
# THE FIX
# -------
# Capture with `-e` (ANSI PRESERVED) and classify by SGR. Ghost-text is rendered
# FAINT (SGR 2); real typed input is normal intensity; working indicators are
# unambiguous. Three states:
#
#   working    explicit working indicator (braille spinner / "esc to interrupt" /
#              "Thinking"): the agent is mid-turn. Callers HARD-reset the idle timer.
#   idle       clean empty composer (only the cursor cell) OR autosuggestion
#              ghost-text only: the agent is at rest. Callers accrue idle time.
#   ambiguous  real typed input, a modal/confirmation prompt, or an unrecognized
#              pane: NOT idle. Callers must DEBOUNCE (a single ambiguous sample
#              must never zero accumulated idle -- redraw frames flicker) and must
#              never sleep while ambiguous.
#
# R5 (never sleep mid-input): when in doubt, classify `ambiguous`, never `idle`.
# A false `idle` sleeps an agent mid-input = lost work; a false `ambiguous` only
# delays a sleep by one debounce window.

# --- tunables (overridable via env) -----------------------------------------
: "${PANE_IDLE_DEBOUNCE_POLLS:=3}"   # consecutive ambiguous polls before the idle timer is reset

# _pi_strip_sgr: drop every CSI SGR sequence (\e[ ... m) from stdin. This is how
# we get the "visible" text; also applied before matching working-indicator words
# so interspersed color codes cannot hide them.
_pi_strip_sgr() { sed 's/\x1b\[[0-9;]*m//g'; }

# _pi_strip_nbsp: turn U+00A0 (0xC2 0xA0) into an ASCII space so downstream
# whitespace trimming treats the empty-composer prompt as blank.
_pi_strip_nbsp() { sed 's/\xc2\xa0/ /g'; }

# _pi_has_faint_sgr <raw-segment>: true (0) iff the segment contains an SGR escape
# whose ;-separated parameter list includes the standalone code 2 (FAINT/dim) --
# the attribute the TUI uses for autosuggestion ghost-text. Each escape is isolated
# first, so 2 inside a 256-color index (\e[38;5;246m) or a different attribute
# (\e[22m normal, \e[27m not-reversed) does NOT match.
_pi_has_faint_sgr() {
  printf '%s' "$1" | grep -oaE $'\x1b\\[[0-9;]*m' | grep -qE '[[;]2[;m]'
}

# pane_classify: read ANSI-preserving pane text (capture-pane -p -e) on stdin,
# echo exactly one of: working | idle | ambiguous  (see header for semantics).
pane_classify() {
  local text last6 stripped_all rawline sline raw_prompt="" post visible
  text="$(cat)"
  last6="$(printf '%s\n' "$text" | tail -6)"

  # 1. Working indicator anywhere in the tail -> mid-turn (check ANSI-stripped so
  #    SGR between glyphs cannot break the match). Highest precedence.
  #
  #    "esc to in" (not "esc to interrupt"): the footer hint is TRUNCATED with an
  #    ellipsis on narrow panes ("esc to inter…"), so match the stable prefix.
  #    While a turn is active the footer's rightmost hint is "esc to interrupt";
  #    at rest it is "↓ for agents" -- so this reliably separates busy from idle.
  #    "edit queued message": the composer shows a faint "Press up to edit queued
  #    messages" hint whenever input is queued -- an independent busy signal that
  #    would otherwise look exactly like an idle autosuggestion (both faint).
  #    Matching agent OUTPUT that merely mentions these strings only causes a
  #    conservative false-busy (delays sleep) -- never a false idle (R5).
  stripped_all="$(printf '%s\n' "$last6" | _pi_strip_sgr)"
  if printf '%s' "$stripped_all" | grep -qE "esc to in|edit queued message|Thinking|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]"; then
    echo working; return
  fi

  # 2. Locate the composer prompt line: the one whose ANSI-stripped form BEGINS
  #    with a single chevron. The bottom hint bar starts with `❯❯` (double) and/or
  #    leading spaces, so it is excluded. Keep the LAST such line (the live prompt).
  while IFS= read -r rawline; do
    sline="$(printf '%s' "$rawline" | _pi_strip_sgr)"
    case "$sline" in
      '❯❯'*) : ;;               # hint/status bar -- not the composer
      '❯'*)  raw_prompt="$rawline" ;;
    esac
  done <<EOF
$last6
EOF
  # No recognizable composer prompt (modal, menu, mid-render) -> not idle.
  [ -z "$raw_prompt" ] && { echo ambiguous; return; }

  # 3. Inspect the content AFTER the chevron on the prompt line.
  post="${raw_prompt#*❯}"
  visible="$(printf '%s' "$post" | _pi_strip_sgr | _pi_strip_nbsp | tr -d '[:space:]')"
  # 3a. Nothing but the cursor cell -> clean empty composer.
  [ -z "$visible" ] && { echo idle; return; }
  # 3b. There IS text. If it is faint (ghost-text autosuggestion) the composer is
  #     still empty from the user's side -> idle. Otherwise it is real input.
  _pi_has_faint_sgr "$post" && { echo idle; return; }
  echo ambiguous
}

# pane_capture_classify <session>: capture the pane with ANSI preserved and
# classify it. Uses $TMUX_BIN if the caller set one (fleet-supervisor), else the
# plain `tmux` on PATH (sleep-agent-watchdog). Empty capture -> ambiguous.
pane_capture_classify() {
  "${TMUX_BIN:-tmux}" capture-pane -t "$1" -p -e 2>/dev/null | pane_classify
}

# pane_idle_accrue <state> <idle_file> <busy_file> <now> [debounce_polls]
# Update the idle-since timer files for one poll and ECHO the effective idle-since
# epoch to feed the sleep decision (0 = not idle right now -> never sleeps this
# tick). This is the DEBOUNCE core (FINDING-2 PART 2):
#
#   working    HARD reset: drop idle_file + busy_file, echo 0. Unambiguous mid-turn.
#   idle       clear busy_file; create idle_file at <now> if absent; echo its epoch
#              so continuous idle accrues toward the sleep threshold.
#   ambiguous  ALWAYS echo 0 (never sleep mid-input, R5). Count consecutive
#              ambiguous polls: while below <debounce_polls> KEEP idle_file (a
#              transient redraw frame must not lose accumulated idle); once the
#              count reaches the threshold treat it as sustained real activity and
#              reset idle_file too (so a later idle starts a fresh timer, not a
#              stale one that would sleep the agent right after it stops typing).
pane_idle_accrue() {
  local state="$1" idle_file="$2" busy_file="$3" now="$4" k="${5:-$PANE_IDLE_DEBOUNCE_POLLS}" c
  case "$state" in
    working)
      rm -f "$idle_file" "$busy_file"
      echo 0
      ;;
    idle)
      rm -f "$busy_file"
      [ -f "$idle_file" ] || echo "$now" > "$idle_file"
      cat "$idle_file" 2>/dev/null || echo 0
      ;;
    *)  # ambiguous (and any unexpected value -> treated as ambiguous, fail-safe)
      c="$(cat "$busy_file" 2>/dev/null || echo 0)"
      case "$c" in ''|*[!0-9]*) c=0 ;; esac
      c=$(( c + 1 ))
      if [ "$c" -ge "$k" ]; then
        rm -f "$idle_file" "$busy_file"   # sustained activity -> reset the timer
      else
        echo "$c" > "$busy_file"          # transient -> pause, keep accumulated idle
      fi
      echo 0
      ;;
  esac
}
