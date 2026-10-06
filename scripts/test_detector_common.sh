#!/bin/bash
# c12-equivalent harness for lib/detector-common.sh primitives (W1/c2f7904b).
# Tests instrument_check(), strike_gate(), strike_clear(), effect_drain_check().
# Each section title maps to a detector-common design contract item.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
STATE_DIR="$TMP/state"
mkdir -p "$STATE_DIR"

# Stub log() so the library's log calls don't require fleet-supervisor sourced.
log() { :; }

# Source detector-common directly (no fleet-supervisor needed for these primitives).
source "$ROOT/lib/detector-common.sh"

# ==========================================================================
# instrument_check -- ARM-A FAIL (fires on healthy)
# ==========================================================================
probe_fires_always() { return 0; }  # always signals alarm
probe_never_fires()  { return 1; }  # never signals alarm

instrument_check probe_fires_always healthy_agent bad_fixture
R=$?
[ "$R" -ne 0 ] && ok "(a1) ARM-A FAIL: fires on healthy => suppress (returns 1)" || bad "(a1) ARM-A FAIL should return 1 (got $R)"

# ==========================================================================
# instrument_check -- ARM-B FAIL (blind on bad fixture)
# ==========================================================================
instrument_check probe_never_fires healthy_agent bad_fixture
R=$?
[ "$R" -ne 0 ] && ok "(a2) ARM-B FAIL: blind on bad fixture => suppress (returns 1)" || bad "(a2) ARM-B FAIL should return 1 (got $R)"

# ==========================================================================
# instrument_check -- both arms PASS
# ==========================================================================
# probe fires ONLY on "bad_agent" (positive control), not on "healthy_agent"
probe_selective() {
  case "$1" in bad_agent) return 0 ;; *) return 1 ;; esac
}

instrument_check probe_selective healthy_agent bad_agent
R=$?
[ "$R" -eq 0 ] && ok "(a3) both arms PASS: instrument healthy (returns 0)" || bad "(a3) both arms should PASS (got $R)"

# ==========================================================================
# strike_gate -- first strike: returns 1, file created
# ==========================================================================
rm -f "$STATE_DIR/strike-agent1" "$STATE_DIR/strike-latch-agent1"

strike_gate agent1 "$STATE_DIR" 60
R=$?
[ "$R" -ne 0 ] && ok "(b1) first strike: returns 1 (no flag)" || bad "(b1) first strike should return 1 (got $R)"
[ -f "$STATE_DIR/strike-agent1" ] && ok "(b2) first strike: state file created" || bad "(b2) first strike: state file missing"
[ ! -f "$STATE_DIR/strike-latch-agent1" ] && ok "(b3) first strike: no latch file" || bad "(b3) first strike: spurious latch file"

# ==========================================================================
# strike_gate -- second strike within window: returns 0 (confirmed)
# ==========================================================================
strike_gate agent1 "$STATE_DIR" 60
R=$?
[ "$R" -eq 0 ] && ok "(b4) 2nd strike within window: confirmed (returns 0)" || bad "(b4) 2nd strike should return 0 (got $R)"
[ ! -f "$STATE_DIR/strike-agent1" ] && ok "(b5) 2nd strike: strike file removed" || bad "(b5) 2nd strike: strike file should be removed"
[ -f "$STATE_DIR/strike-latch-agent1" ] && ok "(b6) 2nd strike: latch file created" || bad "(b6) 2nd strike: latch file missing"

# ==========================================================================
# strike_gate -- latch: third call suppresses re-confirmation
# ==========================================================================
strike_gate agent1 "$STATE_DIR" 60
R=$?
[ "$R" -ne 0 ] && ok "(b7) latch active: 3rd call suppressed (returns 1)" || bad "(b7) latch should suppress (got $R)"
[ ! -f "$STATE_DIR/strike-agent1" ] && ok "(b8) latch active: no new strike file" || bad "(b8) latch: unexpected strike file"

# ==========================================================================
# strike_gate -- stale strike: resets to first strike
# ==========================================================================
rm -f "$STATE_DIR/strike-agent2" "$STATE_DIR/strike-latch-agent2"
STALE_TS=$(( $(date +%s) - 700 ))  # 700s ago, window=60 -> stale
printf '%s\n' "$STALE_TS" > "$STATE_DIR/strike-agent2"

strike_gate agent2 "$STATE_DIR" 60
R=$?
[ "$R" -ne 0 ] && ok "(b9) stale strike: resets to first (returns 1)" || bad "(b9) stale strike should return 1 (got $R)"
NEW_TS=$(cat "$STATE_DIR/strike-agent2" 2>/dev/null || echo 0)
[ "$NEW_TS" -gt "$STALE_TS" ] && ok "(b10) stale strike: file updated with fresh timestamp" || bad "(b10) stale strike: file timestamp not updated"

# ==========================================================================
# strike_clear -- removes both strike and latch files
# ==========================================================================
rm -f "$STATE_DIR/strike-agent3" "$STATE_DIR/strike-latch-agent3"
printf '%s\n' "$(date +%s)" > "$STATE_DIR/strike-agent3"
printf '%s\n' "$(date +%s)" > "$STATE_DIR/strike-latch-agent3"

strike_clear agent3 "$STATE_DIR"
[ ! -f "$STATE_DIR/strike-agent3" ] && ok "(c1) strike_clear: strike file removed" || bad "(c1) strike_clear: strike file not removed"
[ ! -f "$STATE_DIR/strike-latch-agent3" ] && ok "(c2) strike_clear: latch file removed" || bad "(c2) strike_clear: latch file not removed"

# strike_clear on non-existent files must not error
strike_clear agent_none "$STATE_DIR" 2>/dev/null
ok "(c3) strike_clear: no-op on missing files (no error)"

# ==========================================================================
# SEC-106 -- strike_gate / strike_clear agent-name validation (path-traversal)
# ==========================================================================
# A rejected name must (1) return 1, (2) create NO strike file anywhere under
# TMP (non-vacuous: an UNGUARDED first-strike WOULD create one, possibly via
# `../` escape outside STATE_DIR), and (3) delete no file outside STATE_DIR.
# The strike_clear canary targets the EXACT traversal path `strike-../<name>`
# resolves to: $STATE_DIR/strike-../sec106-canary -> $TMP/strike-sec106-canary.
for bad_name in "../sec106-canary" "a/b" "" "a b" ".." "a;rm" 'a$(id)'; do
  before=$(find "$TMP" -name 'strike-*' 2>/dev/null | wc -l)
  strike_gate "$bad_name" "$STATE_DIR" 60 2>/dev/null
  R=$?
  after=$(find "$TMP" -name 'strike-*' 2>/dev/null | wc -l)
  [ "$R" -ne 0 ] && [ "$after" -eq "$before" ] \
    && ok "(e:gate) strike_gate rejects '$bad_name' (returns 1, no file created)" \
    || bad "(e:gate) strike_gate should reject '$bad_name' (got R=$R, files $before->$after)"

  # strike_clear canary: file at the resolved traversal target must survive.
  CANARY="$TMP/strike-sec106-canary"
  printf 'keep\n' > "$CANARY"
  strike_clear "$bad_name" "$STATE_DIR" 2>/dev/null
  R=$?
  [ "$R" -ne 0 ] && [ -f "$CANARY" ] \
    && ok "(e:clear) strike_clear rejects '$bad_name' (returns 1, canary survives)" \
    || bad "(e:clear) strike_clear should reject '$bad_name' (got R=$R, canary present=$([ -f "$CANARY" ] && echo y || echo n))"
  rm -f "$CANARY"
done

# Valid names with hyphen/underscore/digits/mixed-case must be accepted.
for good_name in "agent-1" "agent_2" "Dave" "ABC123"; do
  rm -f "$STATE_DIR/strike-$good_name" "$STATE_DIR/strike-latch-$good_name"
  strike_gate "$good_name" "$STATE_DIR" 60
  R=$?
  [ "$R" -ne 0 ] && [ -f "$STATE_DIR/strike-$good_name" ] \
    && ok "(e:ok) strike_gate accepts valid '$good_name'" \
    || bad "(e:ok) strike_gate should accept valid '$good_name' (got $R)"
  strike_clear "$good_name" "$STATE_DIR"
done

# ==========================================================================
# effect_drain_check -- draining: recent delivered message present
# ==========================================================================
DB="$TMP/noa.db"
python3 - "$DB" <<'EOF'
import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE agent_messages (to_agent TEXT, delivered_at INTEGER)")
# Recent message: 30s ago
db.execute("INSERT INTO agent_messages VALUES (?, ?)", ("myagent", int(time.time()) - 30))
# Old message (should not count for 60s window)
db.execute("INSERT INTO agent_messages VALUES (?, ?)", ("myagent", int(time.time()) - 120))
db.commit()
db.close()
EOF

resolve_live_db() { printf '%s' "$DB"; }

effect_drain_check myagent 60
R=$?
[ "$R" -eq 0 ] && ok "(d1) effect_drain_check: draining (recent msg) returns 0" || bad "(d1) draining agent should return 0 (got $R)"

# ==========================================================================
# effect_drain_check -- NOT draining: only old messages
# ==========================================================================
effect_drain_check myagent 15
R=$?
[ "$R" -ne 0 ] && ok "(d2) effect_drain_check: idle (no recent msg) returns 1" || bad "(d2) idle agent should return 1 (got $R)"

# ==========================================================================
# effect_drain_check -- wrong agent: no messages
# ==========================================================================
effect_drain_check otheragent 60
R=$?
[ "$R" -ne 0 ] && ok "(d3) effect_drain_check: unknown agent returns 1" || bad "(d3) unknown agent should return 1 (got $R)"

# ==========================================================================
# effect_drain_check -- DB unreachable
# ==========================================================================
resolve_live_db() { return 1; }

effect_drain_check myagent 60
R=$?
[ "$R" -ne 0 ] && ok "(d4) effect_drain_check: DB unreachable returns 1 (fail-open)" || bad "(d4) DB unreachable should return 1 (got $R)"

# ==========================================================================
# Summary
# ==========================================================================
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
