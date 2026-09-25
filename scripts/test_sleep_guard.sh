#!/bin/bash
# Tests for scripts/lib/sleep-guard.sh -- the pure decision logic for agent
# sleep-mode (card AGENT-a2b05be5, spec docs/design/agent-sleep-mode-spec-a2b05be5.md).
#
# The guard lib holds ALL query + decision logic for the on-demand watchdog
# (scripts/sleep-agent-watchdog.sh) so the wake/sleep decisions are unit-testable
# WITHOUT launching or killing a live agent (agent-lifecycle code must never be
# exercised on a real session -- c12-chameleon sandbox is for the live wiring).
# Every function here is pure: the DB path, `now` epoch, and marker/pin files are
# passed as arguments, so a temp sqlite DB + fixed clock make each case deterministic.
# Mirrors the pure-function + ok/bad harness of scripts/test_ollama_local_guard.sh.
#
# Run: bash scripts/test_sleep_guard.sh
set -u

LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/sleep-guard.sh"
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# shellcheck disable=SC1090
. "$LIB"

# --- fixtures ---------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Deterministic clock. 1700000000 = 2023-11-14T22:13:20Z. All time-relative
# assertions are computed from this so the suite never depends on wall-clock.
NOW=1700000000

# sgt_sql <db> <sql> -- run arbitrary SQL against a fixture DB.
sgt_sql() {
  python3 -c "import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit(); c.close()" "$1" "$2"
}

# fresh_db -- create an empty fixture DB with the columns sleep-guard queries.
# (Fixture schema: only the columns under test; no PRIMARY KEY bookkeeping.)
fresh_db() {
  local db="$TMP/db-$RANDOM-$RANDOM.db"
  sgt_sql "$db" "
    CREATE TABLE agent_messages(to_agent TEXT, status TEXT, delivered_at INTEGER, completed_at INTEGER, created_at INTEGER, ack_expected INTEGER);
    CREATE TABLE kanban_cards(assignee TEXT, status TEXT);
    CREATE TABLE scheduled_tasks(agent TEXT, status TEXT, next_run INTEGER);
  "
  printf '%s' "$db"
}

# ===========================================================================
# 5.1.1  wake trigger: undelivered inter-agent message (delivered_at IS NULL)
# ===========================================================================
D="$(fresh_db)"
sg_has_undelivered_msg "$D" "vane" 2>/dev/null && bad "undelivered_msg: empty inbox must be false" || ok "undelivered_msg: empty inbox -> false"

sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','pending',NULL,NULL,$NOW,0);"
sg_has_undelivered_msg "$D" "vane" && ok "undelivered_msg: pending row (delivered_at NULL) -> true" || bad "undelivered_msg: pending row should be true"

# A message addressed to ANOTHER agent must not wake vane.
sg_has_undelivered_msg "$D" "kidd" 2>/dev/null && bad "undelivered_msg: other-agent row must not match" || ok "undelivered_msg: other-agent row -> false (scoped to to_agent)"

# A delivered message (delivered_at set) is NOT an undelivered wake trigger.
D="$(fresh_db)"
sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','delivered',$NOW,NULL,$NOW,0);"
sg_has_undelivered_msg "$D" "vane" 2>/dev/null && bad "undelivered_msg: delivered row must not count as undelivered" || ok "undelivered_msg: delivered_at set -> false (already injected)"

# ===========================================================================
# 5.1.2  wake trigger: active card (assignee + status='in_progress')
# ===========================================================================
D="$(fresh_db)"
sg_has_active_card "$D" "vane" 2>/dev/null && bad "active_card: none must be false" || ok "active_card: no card -> false"

sgt_sql "$D" "INSERT INTO kanban_cards VALUES('vane','planned');"
sg_has_active_card "$D" "vane" 2>/dev/null && bad "active_card: planned must NOT wake (not active work)" || ok "active_card: planned card -> false (Boss: planned/waiting do not wake)"

sgt_sql "$D" "INSERT INTO kanban_cards VALUES('vane','in_progress');"
sg_has_active_card "$D" "vane" && ok "active_card: in_progress -> true" || bad "active_card: in_progress should wake"

# in_progress card assigned to someone else must not wake vane.
sg_has_active_card "$D" "bonny" 2>/dev/null && bad "active_card: other-assignee must not match" || ok "active_card: other-assignee -> false"

# ===========================================================================
# 5.1.3 / 5.3 AC1  due task within a horizon (next_run <= now+horizon, active)
# ===========================================================================
D="$(fresh_db)"
sg_has_due_task "$D" "vane" "$NOW" 150 2>/dev/null && bad "due_task: none must be false" || ok "due_task: no task -> false"

# Task 10 min out is OUTSIDE the 150s boot-lead window but INSIDE the 1h horizon.
sgt_sql "$D" "INSERT INTO scheduled_tasks VALUES('vane','active',$((NOW+600)));"
sg_has_due_task "$D" "vane" "$NOW" 150 2>/dev/null && bad "due_task: 10min out must be outside 150s boot-lead" || ok "due_task: 10min out -> false at 150s boot-lead"
sg_has_due_task "$D" "vane" "$NOW" 3600 && ok "due_task: 10min out -> true within 1h stay-up horizon" || bad "due_task: 10min out should be within 1h"

# Task 2 min out is inside the 150s boot-lead window (wake ahead).
D="$(fresh_db)"
sgt_sql "$D" "INSERT INTO scheduled_tasks VALUES('vane','active',$((NOW+120)));"
sg_has_due_task "$D" "vane" "$NOW" 150 && ok "due_task: 2min out -> true within 150s boot-lead" || bad "due_task: 2min out should wake at 150s"

# Overdue task (next_run in the past, missed while asleep) is still 'due'.
D="$(fresh_db)"
sgt_sql "$D" "INSERT INTO scheduled_tasks VALUES('vane','active',$((NOW-300)));"
sg_has_due_task "$D" "vane" "$NOW" 150 && ok "due_task: overdue (past next_run) -> true" || bad "due_task: overdue should count as due"

# A paused task never wakes.
D="$(fresh_db)"
sgt_sql "$D" "INSERT INTO scheduled_tasks VALUES('vane','paused',$((NOW+60)));"
sg_has_due_task "$D" "vane" "$NOW" 150 2>/dev/null && bad "due_task: paused must not wake" || ok "due_task: paused status -> false"

# ===========================================================================
# 5.1  sg_should_wake: OR of the three triggers
# ===========================================================================
D="$(fresh_db)"
sg_should_wake "$D" "vane" "$NOW" 150 2>/dev/null && bad "should_wake: quiet agent must not wake" || ok "should_wake: no trigger -> false"

D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','pending',NULL,NULL,$NOW,0);"
sg_should_wake "$D" "vane" "$NOW" 150 && ok "should_wake: undelivered msg -> wake" || bad "should_wake: msg should wake"

D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO kanban_cards VALUES('vane','in_progress');"
sg_should_wake "$D" "vane" "$NOW" 150 && ok "should_wake: active card -> wake" || bad "should_wake: card should wake"

D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO scheduled_tasks VALUES('vane','active',$((NOW+120)));"
sg_should_wake "$D" "vane" "$NOW" 150 && ok "should_wake: imminent task -> wake" || bad "should_wake: task should wake"

# ===========================================================================
# 5.2.1  open obligation (completed_at IS NULL within lookback) -- for auto-sleep
# card 86c3904e FINDING-1: a delivered message blocks sleep ONLY if the sender
# expected an ack/action (ack_expected=1). A delivered FYI/status (ack_expected
# 0 or NULL) is NOT an obligation. Undelivered (delivered_at NULL) ALWAYS blocks
# (it is also a wake trigger, so the agent will wake and handle it).
# Fixture INSERT positions: (to_agent,status,delivered_at,completed_at,created_at,ack_expected)
# ===========================================================================
LOOKBACK=21600
D="$(fresh_db)"
sg_has_open_obligation "$D" "vane" "$NOW" "$LOOKBACK" 2>/dev/null && bad "open_oblig: none must be false" || ok "open_oblig: clean inbox -> false"

# Undelivered message is an open obligation regardless of ack_expected (delivered_at NULL).
sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','pending',NULL,NULL,$NOW,0);"
sg_has_open_obligation "$D" "vane" "$NOW" "$LOOKBACK" && ok "open_oblig: undelivered (ack_expected 0) -> true (always blocks)" || bad "open_oblig: undelivered should count even with ack_expected=0"

# FINDING-1: delivered + ack_expected=1 (sender wants an ack/action) IS an obligation.
D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','delivered',$NOW,NULL,$NOW,1);"
sg_has_open_obligation "$D" "vane" "$NOW" "$LOOKBACK" && ok "open_oblig: delivered + ack_expected=1 -> true" || bad "open_oblig: delivered ack-expected should count"

# FINDING-1 core: delivered + ack_expected=0 (FYI/status) is NOT an obligation -> allows sleep.
D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','delivered',$NOW,NULL,$NOW,0);"
sg_has_open_obligation "$D" "vane" "$NOW" "$LOOKBACK" 2>/dev/null && bad "open_oblig: delivered FYI (ack_expected=0) must NOT block" || ok "open_oblig: delivered + ack_expected=0 (FYI) -> false (FINDING-1)"

# FINDING-1: delivered + ack_expected NULL (legacy row, no flag) also does NOT block.
D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','delivered',$NOW,NULL,$NOW,NULL);"
sg_has_open_obligation "$D" "vane" "$NOW" "$LOOKBACK" 2>/dev/null && bad "open_oblig: delivered ack_expected NULL must NOT block" || ok "open_oblig: delivered + ack_expected NULL -> false (FINDING-1)"

# Completed message is NOT an open obligation (even if ack was expected).
D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','done',$NOW,$NOW,$NOW,1);"
sg_has_open_obligation "$D" "vane" "$NOW" "$LOOKBACK" 2>/dev/null && bad "open_oblig: completed must not count" || ok "open_oblig: completed (completed_at set) -> false"

# An ancient incomplete ack-expected message outside the lookback window does not pin the agent awake forever.
D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','delivered',$((NOW-LOOKBACK-10)),NULL,$((NOW-LOOKBACK-10)),1);"
sg_has_open_obligation "$D" "vane" "$NOW" "$LOOKBACK" 2>/dev/null && bad "open_oblig: pre-lookback must not count" || ok "open_oblig: older than lookback -> false"

# FINDING-1 (b): the DEFAULT lookback is now 1h (3600), not 6h. A delivered ack-expected
# message ~2h old is OUTSIDE the new default window -> no longer blocks when lookback is defaulted.
D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','delivered',$((NOW-7200)),NULL,$((NOW-7200)),1);"
( unset SG_OBLIGATION_LOOKBACK_SECONDS
  sg_has_open_obligation "$D" "vane" "$NOW" 2>/dev/null ) \
  && bad "open_oblig: 2h-old msg must be outside the new 3600 default lookback" \
  || ok "open_oblig: default lookback = 3600 (2h-old ack-expected msg -> false, FINDING-1b)"

# ===========================================================================
# 5.4  pin marker (present AND now < expiry epoch)
# ===========================================================================
PIN="$TMP/pin-vane"
sg_pin_active "$PIN" "$NOW" 2>/dev/null && bad "pin: absent file must be false" || ok "pin: no marker -> false"

printf '%s\n' "$((NOW+3600))" > "$PIN"
sg_pin_active "$PIN" "$NOW" && ok "pin: expiry in future -> active" || bad "pin: future expiry should be active"

printf '%s\n' "$((NOW-1))" > "$PIN"
sg_pin_active "$PIN" "$NOW" 2>/dev/null && bad "pin: past expiry must be inactive" || ok "pin: expiry passed -> inactive (auto-expire)"

printf '%s\n' "garbage" > "$PIN"
sg_pin_active "$PIN" "$NOW" 2>/dev/null && bad "pin: non-numeric expiry must be inactive" || ok "pin: malformed marker -> inactive (fail-safe)"

# ===========================================================================
# 5.3 AC2  next 05:00 Europe/Budapest boundary (pure, TZ-based)
# ===========================================================================
# now = 04:00 Budapest -> next 05:00 is the SAME day (~1h later).
N0400="$(TZ=Europe/Budapest date -d '2026-01-15 04:00' +%s)"
E="$(sg_next_0500_epoch "$N0400")"
EXP="$(TZ=Europe/Budapest date -d '2026-01-15 05:00' +%s)"
[ "$E" = "$EXP" ] && ok "next_0500: 04:00 -> same-day 05:00" || bad "next_0500: 04:00 expected $EXP got $E"

# now = 06:00 Budapest -> next 05:00 is the NEXT day.
N0600="$(TZ=Europe/Budapest date -d '2026-01-15 06:00' +%s)"
E="$(sg_next_0500_epoch "$N0600")"
EXP="$(TZ=Europe/Budapest date -d '2026-01-16 05:00' +%s)"
[ "$E" = "$EXP" ] && ok "next_0500: 06:00 -> next-day 05:00" || bad "next_0500: 06:00 expected $EXP got $E"

# always strictly in the future.
E="$(sg_next_0500_epoch "$NOW")"
[ "$E" -gt "$NOW" ] && ok "next_0500: result strictly after now" || bad "next_0500: must be > now (got $E)"

# ===========================================================================
# 7 R1  sg_launch_allowed: no double-launch during the cold-boot window
# ===========================================================================
MARK="$TMP/launching-vane"
rm -f "$MARK"
# session absent, no marker -> allow launch.
sg_launch_allowed "$MARK" "$NOW" 0 120 && ok "launch_allowed: no session, no marker -> allow" || bad "launch_allowed: should allow first launch"

# session already exists -> never launch (already awake).
sg_launch_allowed "$MARK" "$NOW" 1 120 2>/dev/null && bad "launch_allowed: live session must block launch" || ok "launch_allowed: session exists -> deny"

# fresh marker (boot in flight, age < ttl) -> deny (no double-launch).
printf '%s\n' "$NOW" > "$MARK"
sg_launch_allowed "$MARK" "$((NOW+30))" 0 120 2>/dev/null && bad "launch_allowed: in-flight boot must block second launch" || ok "launch_allowed: marker age 30s < ttl -> deny (R1 no double-launch)"

# stale marker (boot failed, age > ttl) -> allow relaunch (self-heal).
sg_launch_allowed "$MARK" "$((NOW+200))" 0 120 && ok "launch_allowed: stale marker (age>ttl) -> allow relaunch" || bad "launch_allowed: stale marker should self-heal"

# ===========================================================================
# 5.2 + 5.3  sg_should_sleep: ALL sleep conditions hold AND no exception
# ===========================================================================
export SG_IDLE_SLEEP_SECONDS=1800
export SG_STAY_UP_HORIZON_SECONDS=3600
export SG_OBLIGATION_LOOKBACK_SECONDS=21600
IDLE_SINCE=$((NOW - 2000))   # idle 2000s > 1800s threshold
NOPIN="$TMP/pin-none"; rm -f "$NOPIN"

# Happy path: idle long enough, clean DB, no pin -> SLEEP.
D="$(fresh_db)"
sg_should_sleep "$D" "vane" "$NOW" "$IDLE_SINCE" "$NOPIN" && ok "should_sleep: all clear + idle 2000s -> sleep" || bad "should_sleep: clean idle agent should sleep"

# Not idle long enough (only 100s) -> STAY.
sg_should_sleep "$D" "vane" "$NOW" "$((NOW-100))" "$NOPIN" 2>/dev/null && bad "should_sleep: 100s idle must not sleep" || ok "should_sleep: idle < 1800s -> stay (5.2.3)"

# idle_since unset/zero -> STAY (never slept mid-turn).
sg_should_sleep "$D" "vane" "$NOW" 0 "$NOPIN" 2>/dev/null && bad "should_sleep: idle_since=0 must not sleep" || ok "should_sleep: idle_since unset -> stay"

# active card blocks sleep (5.2.2).
D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO kanban_cards VALUES('vane','in_progress');"
sg_should_sleep "$D" "vane" "$NOW" "$IDLE_SINCE" "$NOPIN" 2>/dev/null && bad "should_sleep: active card must block" || ok "should_sleep: active card -> stay (5.2.2)"

# due task within 1h stay-up horizon blocks sleep (5.3 AC1).
D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO scheduled_tasks VALUES('vane','active',$((NOW+1800)));"
sg_should_sleep "$D" "vane" "$NOW" "$IDLE_SINCE" "$NOPIN" 2>/dev/null && bad "should_sleep: task in 30min must block (AC1)" || ok "should_sleep: task within 1h horizon -> stay (5.3 AC1)"

# a task BEYOND the 1h horizon does NOT block sleep.
D="$(fresh_db)"; sgt_sql "$D" "INSERT INTO scheduled_tasks VALUES('vane','active',$((NOW+7200)));"
sg_should_sleep "$D" "vane" "$NOW" "$IDLE_SINCE" "$NOPIN" && ok "should_sleep: task 2h out -> sleep (beyond horizon)" || bad "should_sleep: task beyond 1h should allow sleep"

# ===========================================================================
# ADVERSARIAL FIXTURES (spec 9.9 / adversarial-fixture-gate) -- 3 required
# ===========================================================================
# ADV-1: mid-boot duplicate trigger must NOT double-launch (R1).
MARK2="$TMP/launching-adv"
printf '%s\n' "$NOW" > "$MARK2"   # a launch is in flight (marker just written)
if sg_launch_allowed "$MARK2" "$((NOW+5))" 0 120 2>/dev/null; then
  bad "ADV-1: a second trigger 5s into a cold boot double-launched"
else
  ok  "ADV-1: second trigger during in-flight boot -> NO double-launch"
fi

# ADV-2: an agent with an OPEN OBLIGATION (delivered + ack_expected=1, uncompleted) must NOT
# sleep even when idle+clean otherwise. (86c3904e: ack_expected=1 is what makes it a real obligation.)
D="$(fresh_db)"
sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','delivered',$NOW,NULL,$NOW,1);"  # delivered, ack-expected, not completed
if sg_should_sleep "$D" "vane" "$NOW" "$IDLE_SINCE" "$NOPIN" 2>/dev/null; then
  bad "ADV-2: slept with an open (ack-expected, uncompleted) obligation -- would drop in-flight work"
else
  ok  "ADV-2: open obligation (ack_expected=1) blocks sleep (R4, 5.2.1)"
fi

# ADV-2b (86c3904e FINDING-1): a delivered FYI (ack_expected=0, uncompleted) must NOT block sleep --
# this is the whole point of the fix (chatty fleet FYIs were pinning eligible agents awake).
D="$(fresh_db)"
sgt_sql "$D" "INSERT INTO agent_messages VALUES('vane','delivered',$NOW,NULL,$NOW,0);"  # delivered FYI, no ack expected
if sg_should_sleep "$D" "vane" "$NOW" "$IDLE_SINCE" "$NOPIN" 2>/dev/null; then
  ok  "ADV-2b: delivered FYI (ack_expected=0) -> sleep allowed (FINDING-1 fix)"
else
  bad "ADV-2b: delivered FYI still blocked sleep -- FINDING-1 not applied"
fi

# ADV-3: a PINNED agent must NOT sleep before 05:00 even when idle 30min+ and clean.
D="$(fresh_db)"
PIN3="$TMP/pin-adv"
printf '%s\n' "$(sg_next_0500_epoch "$NOW")" > "$PIN3"   # pin expires at next 05:00 (future)
if sg_should_sleep "$D" "vane" "$NOW" "$IDLE_SINCE" "$PIN3" 2>/dev/null; then
  bad "ADV-3: pinned agent slept before its 05:00 expiry"
else
  ok  "ADV-3: pin present + before-05:00 blocks sleep (AC2)"
fi
# ...and once the pin has expired (past 05:00) the SAME agent sleeps normally.
printf '%s\n' "$((NOW-1))" > "$PIN3"
sg_should_sleep "$D" "vane" "$NOW" "$IDLE_SINCE" "$PIN3" && ok "ADV-3b: expired pin -> normal sleep resumes" || bad "ADV-3b: expired pin should let the agent sleep"

echo "----"
echo "sleep-guard: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
