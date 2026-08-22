#!/bin/bash
# Unit tests for scripts/channel-watchdog.sh (card da737e92).
#
# Covers the run-mode refactor: the dashboard-up GATE 0 invariant (the watchdog
# must be a no-op while the dashboard's in-process monitor owns recovery -- the
# 2026-06-01 churn-outage protection, now intrinsic), the preserved staleness /
# grace / session gates, the dash_alive probe, and the --loop iteration cap.
#
# Sources the watchdog with an isolated store + a stub PATH (tmux/curl/claude),
# so the source-guard skips any real run and we drive the functions directly --
# the file-based stub harness avoids the pgrep false-match poisoning (memory
# pgrep-test-poisoning).
#
# Run: bash scripts/__tests__/channel-watchdog.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

# --- stub bin: tmux / curl / claude driven by env vars --------------------
STUBBIN="$TMP/bin"; mkdir -p "$STUBBIN"
RESPAWN_LOG="$TMP/respawn.log"; : > "$RESPAWN_LOG"

cat > "$STUBBIN/tmux" <<EOF
#!/bin/bash
case "\$1" in
  has-session) [ "\${STUB_HAS_SESSION:-1}" = "1" ] && exit 0 || exit 1 ;;
  respawn-pane) echo "respawn-pane \$*" >> "$RESPAWN_LOG"; exit 0 ;;
  *) exit 0 ;;
esac
EOF
# curl stub: emulate -w '%{http_code}' by echoing the controlled code.
cat > "$STUBBIN/curl" <<'EOF'
#!/bin/bash
echo "${STUB_DASH_CODE:-000}"
EOF
cat > "$STUBBIN/claude" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$STUBBIN/tmux" "$STUBBIN/curl" "$STUBBIN/claude"

export PATH="$STUBBIN:$PATH"
export CHANNEL_WATCHDOG_STORE="$TMP/store"
mkdir -p "$CHANNEL_WATCHDOG_STORE"
KA="$CHANNEL_WATCHDOG_STORE/.channel-keepalive"
STAMP="$CHANNEL_WATCHDOG_STORE/.channel-last-respawn"
COUNT="$CHANNEL_WATCHDOG_STORE/.channel-watchdog-respawns"

# Source: the guard skips the run; top-level resolves TMUX/CURL/CLAUDE from STUBBIN.
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/channel-watchdog.sh"

CAPTURE="$TMP/log.txt"; : > "$CAPTURE"
log() { echo "$*" >> "$CAPTURE"; }

now=$(date +%s)
stale_at=$(( now - 20 * 60 ))   # 20 min old => past STALE_SECONDS (15 min)
reset_state() { : > "$RESPAWN_LOG"; : > "$CAPTURE"; rm -f "$KA" "$STAMP" "$COUNT"; }

# --- dash_alive probe ------------------------------------------------------
STUB_DASH_CODE=200 dash_alive; assert_eq "dash_alive: HTTP 200 -> up (0)" 0 "$?"
STUB_DASH_CODE=000 dash_alive; assert_eq "dash_alive: HTTP 000 -> down (1)" 1 "$?"
STUB_DASH_CODE=401 dash_alive; assert_eq "dash_alive: HTTP 401 (auth-gated) -> up (0)" 0 "$?"

# --- GATE 0: dashboard UP -> no-op even with stale keepalive + session up --
reset_state
touch -d "@$stale_at" "$KA"
STUB_HAS_SESSION=1 STUB_DASH_CODE=200 run_once
assert_eq "GATE0: dash up -> run_once returns 0" 0 "$?"
if [ -s "$RESPAWN_LOG" ]; then fail "GATE0: dash up MUST NOT respawn (churn protection)"; else pass "GATE0: dash up -> no respawn"; fi

# --- dash DOWN + session present + stale + no grace -> RESPAWN -------------
reset_state
touch -d "@$stale_at" "$KA"
STUB_HAS_SESSION=1 STUB_DASH_CODE=000 run_once
assert_eq "respawn path: returns 0" 0 "$?"
grep -q "respawn-pane -k -t" "$RESPAWN_LOG" && pass "dash down + stale -> respawn-pane issued" || fail "dash down + stale -> respawn-pane issued"
[ -f "$STAMP" ] && pass "respawn stamp written" || fail "respawn stamp written"
assert_eq "respawn count incremented to 1" 1 "$(cat "$COUNT" 2>/dev/null)"

# --- dash DOWN + session ABSENT -> no-op (GATE 1) --------------------------
reset_state
touch -d "@$stale_at" "$KA"
STUB_HAS_SESSION=0 STUB_DASH_CODE=000 run_once
if [ -s "$RESPAWN_LOG" ]; then fail "session absent MUST NOT respawn"; else pass "session absent -> no respawn"; fi
grep -q "not present" "$CAPTURE" && pass "session absent -> logged no-op" || fail "session absent -> logged no-op"

# --- dash DOWN + fresh keepalive -> no-op + resets count (GATE 3) ----------
reset_state
touch "$KA"            # fresh (now)
echo 2 > "$COUNT"
STUB_HAS_SESSION=1 STUB_DASH_CODE=000 run_once
if [ -s "$RESPAWN_LOG" ]; then fail "fresh keepalive MUST NOT respawn"; else pass "fresh keepalive -> no respawn"; fi
[ -f "$COUNT" ] && fail "fresh keepalive -> count file cleared" || pass "fresh keepalive -> count file cleared"

# --- dash DOWN + stale + within respawn grace -> defer (GATE 4) ------------
reset_state
touch -d "@$stale_at" "$KA"
touch "$STAMP"         # fresh stamp => within grace window
STUB_HAS_SESSION=1 STUB_DASH_CODE=000 run_once
if [ -s "$RESPAWN_LOG" ]; then fail "within grace MUST NOT respawn"; else pass "within grace -> deferred, no respawn"; fi
grep -q "within respawn grace" "$CAPTURE" && pass "within grace -> logged defer" || fail "within grace -> logged defer"

# --- dash DOWN + stale + backoff cap reached -> alert, no respawn (GATE 5) -
reset_state
touch -d "@$stale_at" "$KA"
echo 3 > "$COUNT"      # == MAX_CONSECUTIVE
STUB_HAS_SESSION=1 STUB_DASH_CODE=000 run_once
if [ -s "$RESPAWN_LOG" ]; then fail "backoff cap MUST NOT respawn"; else pass "backoff cap -> no respawn"; fi
grep -q "backing off" "$CAPTURE" && pass "backoff cap -> ALERT logged" || fail "backoff cap -> ALERT logged"

# --- run_loop: honours the iteration cap -----------------------------------
# Redefine run_once to count calls; drive the loop with a 0s interval + cap 3.
_loop_calls="$TMP/loopcalls"; : > "$_loop_calls"
run_once() { echo x >> "$_loop_calls"; }
LOOP_ITERS=3
LOOP_INTERVAL=0
run_loop >/dev/null 2>&1
assert_eq "run_loop: LOOP_ITERS=3 -> run_once called 3x" 3 "$(wc -l < "$_loop_calls" | tr -d ' ')"

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
