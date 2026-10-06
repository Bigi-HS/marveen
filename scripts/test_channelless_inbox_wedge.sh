#!/bin/bash
# DoD migration harness for check_channelless_inbox_wedge (card OPS-272 / 8e124447,
# re-foundation sprint W1). The detector flags a channel-LESS agent as inbox-stuck
# when its tmux pane is idle at the prompt WHILE an overdue inter-agent inbox is
# pending. It is LOG-ONLY (no auto-recovery) and shipped with zero test coverage
# despite carrying two documented FP-fixes in agent_has_open_obligation:
#   - completed_at IS NULL           (delivered-then-drained msgs; OPS/1ec8b68f)
#   - (status='pending' OR ack_expected!=0)  (delivered FYI / ack-free push that
#                                             is NOT an obligation; lesson 1006)
#
# This harness locks the 4-item detector DoD (gate-review-checklist 4j /
# detector-dod-gate skill) so a future refactor cannot silently regress the FP
# guards:
#   (a) positive-control  -- a healthy agent (not alive / not idle / no overdue
#                            inbox / budget-paused) is NOT flagged.
#   (b) bypass-fixture     -- the delivered-no-ack FP class: a delivered message
#                            with ack_expected=0 (and a drained completed msg) is
#                            NOT counted as an obligation.
#   (c) fail-direction     -- a genuinely wedged agent (alive + idle + real
#                            unacked overdue inbox + not paused) IS flagged.
#   (d) tail-scope         -- the obligation window is bounded to
#                            IDLE_NUDGE_LOOKBACK_SECONDS; a message older than the
#                            window is NOT counted.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# Source the REAL supervisor (--dry-run returns before running the daemon); this
# defines check_channelless_inbox_wedge, _channelless_agent_wedged,
# agent_has_open_obligation, resolve_live_db and the IDLE_NUDGE_LOOKBACK_SECONDS /
# INSTALL_DIR / STORE globals, which we then repoint at a sandbox so the test is
# hermetic.
source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

# Capture the REAL obligation predicate before Part 1 mocks it, so Part 2 (which
# exercises the real DB query) can restore it.
REAL_AGENT_HAS_OB="$(declare -f agent_has_open_obligation)"

# ── Part 1: _channelless_agent_wedged -- the pure per-agent decision seam ─────
# We mock the four live-signal helpers (session_alive, pane_is_idle_at_prompt,
# agent_has_open_obligation, is_agent_budget_paused) so the decision is driven by
# scripted booleans. Each mock reads a global set before the call. Guard order
# must preserve the original short-circuit (dead -> not wedge; working -> not
# wedge; no inbox -> not wedge; paused -> not wedge).
MOCK_ALIVE=1 MOCK_IDLE=1 MOCK_OB=1 MOCK_PAUSED=0
session_alive()          { [ "$MOCK_ALIVE" = 1 ]; }
pane_is_idle_at_prompt() { [ "$MOCK_IDLE" = 1 ]; }
agent_has_open_obligation() { [ "$MOCK_OB" = 1 ]; }
is_agent_budget_paused() { [ "$MOCK_PAUSED" = 1 ]; }

decide() { # <alive> <idle> <ob> <paused> -> echoes WEDGED | CLEAR
  MOCK_ALIVE="$1" MOCK_IDLE="$2" MOCK_OB="$3" MOCK_PAUSED="$4"
  if _channelless_agent_wedged "someagent"; then echo WEDGED; else echo CLEAR; fi
}
dec_eq() { # <desc> <alive> <idle> <ob> <paused> <expected>
  local got; got="$(decide "$2" "$3" "$4" "$5")"
  if [ "$got" = "$6" ]; then ok "$1"; else bad "$1 (got $got, expected $6)"; fi
}

# (c) fail-direction: the ONE real wedge shape must flag.
dec_eq "[c/fail-dir] alive+idle+overdue-inbox+not-paused -> WEDGED"   1 1 1 0  WEDGED
# (a) positive-control: every healthy shape must stay clear.
dec_eq "[a/pos-ctrl] dead agent -> CLEAR (watchdog handles restart)"  0 1 1 0  CLEAR
dec_eq "[a/pos-ctrl] pane working (not idle) -> CLEAR"                1 0 1 0  CLEAR
dec_eq "[a/pos-ctrl] no overdue inbox -> CLEAR (legit idle)"          1 1 0 0  CLEAR
dec_eq "[a/pos-ctrl] budget-paused by design -> CLEAR (not stuck)"    1 1 1 1  CLEAR
# opposing-pair: the real wedge fires, a paused twin with identical inbox is silent.
dec_eq "[opposing] wedged twin fires"                                1 1 1 0  WEDGED
dec_eq "[opposing] paused twin silent (selective trigger)"           1 1 1 1  CLEAR

# ── Part 2: agent_has_open_obligation -- the FP-bearing DB predicate ──────────
# Restore the real predicate (Part 1 replaced it with a boolean stub).
eval "$REAL_AGENT_HAS_OB"
# Hermetic sandbox DB. resolve_live_db returns $STORE/noa.db by default.
INSTALL_DIR="/tmp/ops272-testroot.$$"
STORE="$INSTALL_DIR/store"
DB="$STORE/noa.db"
rm -rf "$INSTALL_DIR"; mkdir -p "$STORE"
NOW=$(date +%s)
WIN="${IDLE_NUDGE_LOOKBACK_SECONDS:-21600}"
IN_WINDOW=$(( NOW - 60 ))          # recent, inside the obligation window
OUT_WINDOW=$(( NOW - WIN - 600 ))  # older than the window -> must not count

python3 - "$DB" "$IN_WINDOW" "$OUT_WINDOW" <<'PY'
import sqlite3, sys
db, inw, outw = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
c = sqlite3.connect(db)
c.execute("""CREATE TABLE agent_messages(
  id INTEGER PRIMARY KEY, to_agent TEXT, status TEXT,
  completed_at INTEGER, created_at INTEGER, ack_expected INTEGER)""")
rows = [
  # wedged: delivered, unacked (ack_expected=1), not completed, in window
  ('wedged',  'delivered', None, inw, 1),
  # pending counts regardless of ack flag
  ('pendguy', 'pending',   None, inw, 0),
  # (b) delivered FYI, ack_expected=0 -> NOT an obligation (lesson 1006)
  ('fyi',     'delivered', None, inw, 0),
  # (b) delivered then drained (completed_at set) -> NOT an obligation (1ec8b68f)
  ('drained', 'delivered', inw,  inw, 1),
  # (d) tail-scope: real unacked msg but OLDER than the window -> NOT counted
  ('stale',   'delivered', None, outw, 1),
  # 'done'/other status -> never counted
  ('doneguy', 'done',      None, inw, 1),
]
c.executemany("INSERT INTO agent_messages(to_agent,status,completed_at,created_at,ack_expected) VALUES(?,?,?,?,?)", rows)
c.commit(); c.close()
PY

ob() { # <agent> -> HAS | NONE
  if agent_has_open_obligation "$1"; then echo HAS; else echo NONE; fi
}
ob_eq() { # <desc> <agent> <expected>
  local got; got="$(ob "$2")"
  if [ "$got" = "$3" ]; then ok "$1"; else bad "$1 (agent=$2 -> $got, expected $3)"; fi
}

ob_eq "[c/fail-dir] delivered+unacked+in-window -> HAS obligation"    wedged  HAS
ob_eq "[c/fail-dir] pending message -> HAS obligation"               pendguy HAS
ob_eq "[b/bypass] delivered FYI ack_expected=0 -> NONE (1006 FP)"    fyi     NONE
ob_eq "[b/bypass] delivered then drained completed_at -> NONE (1ec8b68f FP)" drained NONE
ob_eq "[d/tail-scope] unacked but older than window -> NONE"         stale   NONE
ob_eq "[a/pos-ctrl] status='done' -> NONE"                           doneguy NONE
ob_eq "[a/pos-ctrl] agent with no messages -> NONE"                  ghost   NONE

rm -rf "$INSTALL_DIR"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
