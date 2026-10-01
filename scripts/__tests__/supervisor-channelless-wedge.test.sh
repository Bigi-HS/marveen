#!/bin/bash
# Tests for channel-LESS agent inbox-wedge detection in fleet-supervisor.sh
# (card 74655583 / OPS-202).
#
# Gap: fleet_wedge_sweep covers G1/G2/G6 pane-markers for all agents, but
# channel-LESS agents have no G5 effect-probe. A channel-LESS agent that is
# idle at the empty prompt while inter-agent messages pile up undelivered is
# "inbox-stuck" -- alive but not processing. This scan detects that state
# and logs WEDGED:inbox-stuck without triggering a relaunch.
#
# Run: bash scripts/__tests__/supervisor-channelless-wedge.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_contains()     { grep -qF "$2" "$3" && pass "$1" || fail "$1 (expected '$2' in $3)"; }
assert_not_contains() { grep -qF "$2" "$3" && fail "$1 (unexpected '$2' in $3)" || pass "$1"; }

# ---------------------------------------------------------------------------
# Source the supervisor with an isolated store
# ---------------------------------------------------------------------------
export FLEET_SUPERVISOR_STORE="$TMP/store"
export CHANNELLESS_INBOX_WEDGE_INTERVAL=0   # always due in tests
export FLEET_TEST_CHANNELLESS_AGENTS="rackham blackbeard radar"
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1
DRY_RUN=0   # tests drive functions directly; dry-run only skips live side-effects

LOGFILE="$TMP/supervisor.log"
: > "$LOGFILE"
log() { echo "$*" >> "$LOGFILE"; }

# ---------------------------------------------------------------------------
# AC1: idle pane + overdue inbox -> WEDGED:inbox-stuck logged
# ---------------------------------------------------------------------------
echo "--- AC1: idle pane + overdue inbox -> WEDGED:inbox-stuck ---"
: > "$LOGFILE"

session_alive()             { return 0; }     # all sessions alive
pane_is_idle_at_prompt()    { return 0; }     # pane idle
agent_has_open_obligation() { return 0; }     # has pending messages

check_channelless_inbox_wedge
grep -qF "WEDGED" "$LOGFILE" && grep -qF "inbox" "$LOGFILE" \
    && pass "AC1: WEDGED:inbox-stuck logged" \
    || fail "AC1: WEDGED:inbox-stuck logged"

# ---------------------------------------------------------------------------
# AC2: pane active (working) -> no WEDGED even with overdue inbox
# ---------------------------------------------------------------------------
echo "--- AC2: pane active -> no WEDGED ---"
: > "$LOGFILE"

session_alive()             { return 0; }
pane_is_idle_at_prompt()    { return 1; }     # pane busy / working
agent_has_open_obligation() { return 0; }

check_channelless_inbox_wedge
assert_not_contains "AC2: no WEDGED when pane active" "WEDGED" "$LOGFILE"

# ---------------------------------------------------------------------------
# AC3: idle pane but no overdue inbox -> no WEDGED (agent is legitimately idle)
# ---------------------------------------------------------------------------
echo "--- AC3: idle pane + no pending messages -> no WEDGED ---"
: > "$LOGFILE"

session_alive()             { return 0; }
pane_is_idle_at_prompt()    { return 0; }
agent_has_open_obligation() { return 1; }     # no obligations

check_channelless_inbox_wedge
assert_not_contains "AC3: no WEDGED when legitimately idle" "WEDGED" "$LOGFILE"

# ---------------------------------------------------------------------------
# AC4: session dead -> skip (not wedged, dead = watchdog handles restart)
# ---------------------------------------------------------------------------
echo "--- AC4: session dead -> no WEDGED ---"
: > "$LOGFILE"

session_alive()             { return 1; }     # dead
pane_is_idle_at_prompt()    { return 0; }
agent_has_open_obligation() { return 0; }

check_channelless_inbox_wedge
assert_not_contains "AC4: no WEDGED when dead" "WEDGED" "$LOGFILE"

# ---------------------------------------------------------------------------
# AC5: WEDGED message is not a relaunch -- no 'launching' in log
# ---------------------------------------------------------------------------
echo "--- AC5: WEDGED != relaunch ---"
: > "$LOGFILE"

session_alive()             { return 0; }
pane_is_idle_at_prompt()    { return 0; }
agent_has_open_obligation() { return 0; }

check_channelless_inbox_wedge
assert_not_contains "AC5: no 'launching' on WEDGED" "launching" "$LOGFILE"
assert_not_contains "AC5: no 'relaunching' on WEDGED" "relaunching" "$LOGFILE"

# ---------------------------------------------------------------------------
# AC6: dry-run -- function is a no-op (no DB access, no alert)
# ---------------------------------------------------------------------------
echo "--- AC6: dry-run is no-op ---"
: > "$LOGFILE"
DRY_RUN=1

session_alive()             { return 0; }
pane_is_idle_at_prompt()    { return 0; }
agent_has_open_obligation() { return 0; }

check_channelless_inbox_wedge
assert_not_contains "AC6: no WEDGED in dry-run" "WEDGED" "$LOGFILE"
DRY_RUN=0

# ---------------------------------------------------------------------------
# AC7: throttle -- not due -> skips entirely
# ---------------------------------------------------------------------------
echo "--- AC7: throttle: not due -> skip ---"
: > "$LOGFILE"
export CHANNELLESS_INBOX_WEDGE_INTERVAL=9999
# Write a future .next file so it's throttled
echo "$(( $(date +%s) + 9999 ))" > "$STATE_DIR/channelless-inbox-wedge.next"

session_alive()             { return 0; }
pane_is_idle_at_prompt()    { return 0; }
agent_has_open_obligation() { return 0; }

check_channelless_inbox_wedge
assert_not_contains "AC7: no WEDGED when throttled" "WEDGED" "$LOGFILE"

# Reset for remaining tests
export CHANNELLESS_INBOX_WEDGE_INTERVAL=0
rm -f "$STATE_DIR/channelless-inbox-wedge.next"

echo ""
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
