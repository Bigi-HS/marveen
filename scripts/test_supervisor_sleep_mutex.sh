#!/bin/bash
# c12-equivalent for the fleet-supervisor sleep-mode wiring (card AGENT-a2b05be5):
# ensure_sleep_agent_watchdogs' ACTIVE mutual-exclusion. The live daemon path
# would pkill a real watchdog + nohup a real one, so we mock pgrep/pkill/nohup and
# assert the exact call sequence over the REAL supervisor functions. Covers both
# directions: flag-absent inert (no-op), flag-present active (stop old + start new).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# Source the REAL supervisor (--dry-run returns without running the daemon), which
# defines sleep_mode_enabled / sleep_eligible_ids / is_sleep_eligible /
# ensure_sleep_agent_watchdogs, then we drive them with mocks + a temp INSTALL_DIR.
source "$ROOT/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ID="simcanary"
mkdir -p "$TMP/store" "$TMP/scripts" "$TMP/agents/$ID"
echo '{"model":"claude-x"}' > "$TMP/agents/$ID/agent-config.json"
printf '%s\n' "$ID" > "$TMP/store/sleep-eligible.txt"
cp "$ROOT/scripts/sleep-agent-watchdog.sh" "$TMP/scripts/sleep-agent-watchdog.sh"
chmod +x "$TMP/scripts/sleep-agent-watchdog.sh"

# Point the supervisor globals at the sandbox and take the REAL (non-dry-run) path.
INSTALL_DIR="$TMP"; STORE="$TMP/store"; DRY_RUN=0

RESULT=""
RF="$TMP/actions"                    # action log FILE (survives the `nohup ... &` subshell;
                                     # a variable would not -- the & forks a subshell)
MOCK_ALWAYSON_RUNNING=1   # 1 = an always-on agent-watchdog.sh <id> is running
log() { :; }
disown() { :; }          # keep the backgrounded mock in the job table so `wait` catches it
pgrep() {
  # $* looks like: -f "scripts/agent-watchdog.sh simcanary$"
  case "$*" in
    *"scripts/agent-watchdog.sh $ID\$"*)      [ "$MOCK_ALWAYSON_RUNNING" = "1" ] && return 0 || return 1 ;;
    *"scripts/sleep-agent-watchdog.sh $ID\$"*) return 1 ;;   # sleep watchdog not yet running
    *) return 1 ;;
  esac
}
pkill() { echo "PKILL[$*]" >> "$RF"; return 0; }
nohup() { echo "NOHUP[$*]" >> "$RF"; return 0; }

run() { : > "$RF"; ensure_sleep_agent_watchdogs; wait 2>/dev/null; RESULT="$(tr '\n' ' ' < "$RF")"; }

# ---- flag ABSENT -> fully inert (no pkill, no start) -----------------------
rm -f "$TMP/store/agent-sleep-mode.enabled"
run
[ -z "$(echo "$RESULT" | xargs)" ] && ok "flag absent -> inert (no pkill/nohup)" || bad "flag absent should be inert (got '$RESULT')"

# ---- flag PRESENT + always-on running -> stop old THEN start sleep watchdog -
: > "$TMP/store/agent-sleep-mode.enabled"
MOCK_ALWAYSON_RUNNING=1
run
case "$RESULT" in
  *"PKILL[-f scripts/agent-watchdog.sh $ID\$]"*) ok "mutual-exclusion: pkills the always-on loop (anchored, id-exact)" ;;
  *) bad "expected pkill of always-on watchdog; got '$RESULT'" ;;
esac
case "$RESULT" in
  *"NOHUP[bash $TMP/scripts/sleep-agent-watchdog.sh $ID]"*) ok "starts sleep-agent-watchdog for the id" ;;
  *) bad "expected nohup start of sleep watchdog; got '$RESULT'" ;;
esac
# ordering: PKILL must come before NOHUP (stop the fighter before starting).
PK="${RESULT%%NOHUP*}"
case "$PK" in *PKILL*) ok "ordering: stop-old precedes start-new" ;; *) bad "pkill must precede nohup (got '$RESULT')" ;; esac
# safety: the pkill pattern targets agent-watchdog.sh, never sleep-agent-watchdog.sh
case "$RESULT" in
  *"PKILL[-f scripts/sleep-agent-watchdog.sh"*) bad "COLLATERAL: pkill hit the sleep watchdog itself" ;;
  *) ok "no collateral: pkill never targets the sleep watchdog" ;;
esac

# ---- flag PRESENT + always-on NOT running -> just start, no pkill ----------
MOCK_ALWAYSON_RUNNING=0
run
case "$RESULT" in *PKILL*) bad "no always-on running: must NOT pkill (got '$RESULT')" ;; *) ok "no always-on running -> no pkill" ;; esac
case "$RESULT" in *"NOHUP[bash $TMP/scripts/sleep-agent-watchdog.sh $ID]"*) ok "still starts the sleep watchdog" ;; *) bad "should start sleep watchdog even with no old loop" ;; esac

echo "----"
echo "c12 supervisor mutual-exclusion harness: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
