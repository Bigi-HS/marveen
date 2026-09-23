#!/bin/bash
# c12-chameleon-equivalent for scripts/sleep-agent-watchdog.sh (card AGENT-a2b05be5).
#
# Per the c12-chameleon-test skill ("Watchdog / shell-script decision-logic changes"):
# the live morph/smoke proves only launch+60s+ping and CANNOT exercise a watchdog's
# sleep/kill/relaunch decision (that would need a real claude to die/sleep repeatedly
# = token spend + risk on a live-or-sandbox agent). The valid substitute is a LOGIC
# HARNESS over the REAL extracted loop body, mocking every external, asserting the
# exact action sequence across scripted scenarios -- BOTH directions (act + no-op guard).
#
# It exercises the REAL loop wiring + REAL sleep-guard.sh decisions + REAL marker/idle
# state files (in a temp dir), stubbing only tmux/date/sleep/pane_idle/launch_fresh/
# under_cap so no claude process is ever launched or killed.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANDIDATE="$ROOT/scripts/sleep-agent-watchdog.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

. "$ROOT/scripts/lib/sleep-guard.sh"    # REAL decision core

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
NAME="sim"; SESSION="agent-$NAME"
STATE_DIR="$TMP/state"; mkdir -p "$STATE_DIR"
MARKER="$STATE_DIR/$NAME.launching"
IDLE_FILE="$STATE_DIR/$NAME.idle-since"
PIN="$TMP/pin-$NAME"
DB="$TMP/noa.db"
POLL=15
MAX_PER_HOUR=8; LONG_BACKOFF=600
export SG_IDLE_SLEEP_SECONDS=1800 SG_STAY_UP_HORIZON_SECONDS=3600 SG_OBLIGATION_LOOKBACK_SECONDS=21600

sgt_sql() { python3 -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.executescript(sys.argv[2]);c.commit();c.close()" "$1" "$2"; }
reset_db() {
  rm -f "$DB"
  sgt_sql "$DB" "CREATE TABLE agent_messages(to_agent TEXT,status TEXT,delivered_at INTEGER,completed_at INTEGER,created_at INTEGER);
                 CREATE TABLE kanban_cards(assignee TEXT,status TEXT);
                 CREATE TABLE scheduled_tasks(agent TEXT,status TEXT,next_run INTEGER);"
}

# --- world state + mocks ----------------------------------------------------
MOCK_NOW=1700000000
MOCK_SESSION=0        # 0 = asleep (no session), 1 = awake
MOCK_PANE_IDLE=1      # 1 = pane idle at prompt, 0 = working
MOCK_UNDER_CAP=0      # 0 = under cap (true), 1 = cap reached (false)
RESULT=""            # action log

date() { case "$*" in *"+%s"*) printf '%s\n' "$MOCK_NOW";; *) printf 'MOCK-TS\n';; esac; }
sleep() { :; }        # skip real backoff/poll waits
log()  { :; }
tmux() {
  case "$1" in
    has-session) [ "$MOCK_SESSION" = "1" ] && return 0 || return 1 ;;
    kill-session) RESULT="$RESULT KILL"; MOCK_SESSION=0; return 0 ;;
    *) return 0 ;;
  esac
}
pane_idle() { [ "$MOCK_PANE_IDLE" = "1" ]; }
under_cap() { [ "$MOCK_UNDER_CAP" = "0" ]; }
launch_fresh() { RESULT="$RESULT LAUNCH"; MOCK_SESSION=1; }   # stub: no real claude spawn

# Extract the REAL loop body verbatim from the candidate and wrap as tick()
# (skill idiom: everything after `while true; do`, drop the trailing `done`).
BODY="$(awk '/^while true; do$/{f=1;next} f{print}' "$CANDIDATE" | head -n -1)"
eval "tick() {
$BODY
}"

# helper: run one tick, capture the action delta
step() { RESULT=""; tick; }
assert_actions() { # <label> <expected RESULT>
  local got; got="$(echo "$RESULT" | xargs)"   # trim
  [ "$got" = "$2" ] && ok "$1 (actions='$got')" || bad "$1 (expected='$2' got='$got')"
}

# ===========================================================================
# ASLEEP scenarios
# ===========================================================================
# S1: asleep, no trigger -> NO launch (the whole point: quiet agent stays down).
reset_db; MOCK_SESSION=0; rm -f "$MARKER" "$IDLE_FILE"
step; assert_actions "S1 asleep + no trigger -> no launch" ""

# S2: asleep + undelivered message -> exactly ONE launch + marker written (R1 pre-mark).
reset_db; sgt_sql "$DB" "INSERT INTO agent_messages VALUES('$NAME','pending',NULL,NULL,$MOCK_NOW);"
MOCK_SESSION=0; rm -f "$MARKER" "$IDLE_FILE"
step; assert_actions "S2 asleep + undelivered msg -> launch" "LAUNCH"
[ -f "$MARKER" ] && ok "S2 marker written before launch (R1)" || bad "S2 marker missing after launch"

# S3: asleep + in_progress card -> launch.
reset_db; sgt_sql "$DB" "INSERT INTO kanban_cards VALUES('$NAME','in_progress');"
MOCK_SESSION=0; rm -f "$MARKER" "$IDLE_FILE"
step; assert_actions "S3 asleep + active card -> launch" "LAUNCH"

# S4: asleep + planned card only -> NO launch (planned must not wake).
reset_db; sgt_sql "$DB" "INSERT INTO kanban_cards VALUES('$NAME','planned');"
MOCK_SESSION=0; rm -f "$MARKER" "$IDLE_FILE"
step; assert_actions "S4 asleep + planned card -> no launch" ""

# S5: asleep + imminent task (2min, within 150s boot-lead) -> launch.
reset_db; sgt_sql "$DB" "INSERT INTO scheduled_tasks VALUES('$NAME','active',$((MOCK_NOW+120)));"
MOCK_SESSION=0; rm -f "$MARKER" "$IDLE_FILE"
step; assert_actions "S5 asleep + imminent task -> launch" "LAUNCH"

# ADV-1 (R1): a duplicate trigger DURING the cold-boot window must NOT double-launch.
# Reuse S2 world: msg still pending, session still not up (boot in flight), marker fresh.
reset_db; sgt_sql "$DB" "INSERT INTO agent_messages VALUES('$NAME','pending',NULL,NULL,$MOCK_NOW);"
MOCK_SESSION=0; rm -f "$MARKER" "$IDLE_FILE"
step   # first tick: launches, writes marker, launch_fresh sets MOCK_SESSION=1... but reset session to simulate boot-not-yet-registered
MOCK_SESSION=0            # boot still cold (session not yet visible)
MOCK_NOW=$((MOCK_NOW+5))  # 5s later, well inside the 120s marker TTL
step; assert_actions "ADV-1 dup trigger 5s into cold boot -> NO second launch (R1)" ""

# ADV-1b: after the marker TTL elapses with the boot still dead, a relaunch self-heals.
MOCK_NOW=$((MOCK_NOW+200))   # > 120s TTL
MOCK_SESSION=0
step; assert_actions "ADV-1b stale marker (boot died) -> relaunch self-heal" "LAUNCH"

# S6: asleep + wake trigger but cap reached -> NO launch (R3/R6 backoff).
reset_db; sgt_sql "$DB" "INSERT INTO agent_messages VALUES('$NAME','pending',NULL,NULL,$MOCK_NOW);"
MOCK_SESSION=0; MOCK_UNDER_CAP=1; rm -f "$MARKER" "$IDLE_FILE"
step; assert_actions "S6 asleep + trigger + cap reached -> no launch" ""
MOCK_UNDER_CAP=0

# ===========================================================================
# AWAKE scenarios
# ===========================================================================
MOCK_NOW=1700000000
# S7: awake + working (pane not idle) -> NO kill, idle timer cleared.
reset_db; MOCK_SESSION=1; MOCK_PANE_IDLE=0; rm -f "$IDLE_FILE" "$MARKER"
step; assert_actions "S7 awake + working -> no kill" ""
[ ! -f "$IDLE_FILE" ] && ok "S7 idle timer reset while working (R5)" || bad "S7 idle file should be cleared when working"

# S8: awake + idle but not long enough -> NO kill (timer starts this tick).
reset_db; MOCK_SESSION=1; MOCK_PANE_IDLE=1; rm -f "$IDLE_FILE" "$MARKER"
step; assert_actions "S8 awake + idle (timer just started) -> no kill" ""
[ -f "$IDLE_FILE" ] && ok "S8 idle timer file created" || bad "S8 idle file should exist"

# S9: awake + idle >= 1800s + clean -> exactly ONE kill.
reset_db; MOCK_SESSION=1; MOCK_PANE_IDLE=1; rm -f "$MARKER"
echo "$((MOCK_NOW-2000))" > "$IDLE_FILE"     # idle started 2000s ago
step; assert_actions "S9 awake + idle 2000s + clean -> kill (sleep)" "KILL"
[ ! -f "$IDLE_FILE" ] && ok "S9 idle file removed on sleep" || bad "S9 idle file should be gone after sleep"

# ADV-2 (R4): awake + idle long enough but OPEN OBLIGATION -> must NOT kill.
reset_db; sgt_sql "$DB" "INSERT INTO agent_messages VALUES('$NAME','delivered',$MOCK_NOW,NULL,$MOCK_NOW);"
MOCK_SESSION=1; MOCK_PANE_IDLE=1; rm -f "$MARKER"
echo "$((MOCK_NOW-2000))" > "$IDLE_FILE"
step; assert_actions "ADV-2 awake + idle + open obligation -> NO kill (R4)" ""

# S10: awake + idle long enough but in_progress card -> NO kill (5.2.2).
reset_db; sgt_sql "$DB" "INSERT INTO kanban_cards VALUES('$NAME','in_progress');"
MOCK_SESSION=1; MOCK_PANE_IDLE=1; rm -f "$MARKER"
echo "$((MOCK_NOW-2000))" > "$IDLE_FILE"
step; assert_actions "S10 awake + idle + active card -> NO kill" ""

# S11: awake + idle long enough but task due within 1h -> NO kill (5.3 AC1).
reset_db; sgt_sql "$DB" "INSERT INTO scheduled_tasks VALUES('$NAME','active',$((MOCK_NOW+1800)));"
MOCK_SESSION=1; MOCK_PANE_IDLE=1; rm -f "$MARKER"
echo "$((MOCK_NOW-2000))" > "$IDLE_FILE"
step; assert_actions "S11 awake + idle + task in 30min -> NO kill (AC1)" ""

# ADV-3 (AC2): awake + idle long enough + PIN before 05:00 -> must NOT kill.
reset_db; MOCK_SESSION=1; MOCK_PANE_IDLE=1; rm -f "$MARKER"
echo "$((MOCK_NOW-2000))" > "$IDLE_FILE"
# pin expiry = a future epoch (represents "next 05:00", which is always > now while
# pinned). NB: the watchdog loop only reads the pin via sg_pin_active; sg_next_0500_epoch
# is the WRITER's job (marveen side) and is covered with real `date` in the unit test --
# using it here would hit the harness date() mock, so use a plain future epoch.
echo "$((MOCK_NOW + 3600))" > "$PIN"
step; assert_actions "ADV-3 awake + idle + pin-before-05:00 -> NO kill (AC2)" ""
rm -f "$PIN"

# S12: awake + boot just succeeded -> the stale launching marker is cleared.
reset_db; MOCK_SESSION=1; MOCK_PANE_IDLE=0; rm -f "$IDLE_FILE"
echo "$MOCK_NOW" > "$MARKER"
step
[ ! -f "$MARKER" ] && ok "S12 launching marker cleared once session is up" || bad "S12 marker should be cleared when awake"

echo "----"
echo "c12 sleep-watchdog loop harness: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
