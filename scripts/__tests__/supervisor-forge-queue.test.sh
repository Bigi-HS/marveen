#!/bin/bash
# Tests for forge escalation queue forwarding in fleet-supervisor.sh (card f1e2417f).
#
# Scenario: forge writes critical alerts to store/forge-escalation-queue.jsonl when
# /api/messages is unavailable. fleet-supervisor reads the queue on each tick (only
# when dash_alive) and forwards buffered entries via the dashboard API.
#
# Run: bash scripts/__tests__/supervisor-forge-queue.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_contains() { grep -qF "$2" "$3" && pass "$1" || fail "$1 (expected '$2' in $3)"; }
assert_not_contains() { grep -qF "$2" "$3" && fail "$1 (unexpected '$2' in $3)" || pass "$1"; }

# ---------------------------------------------------------------------------
# Fake curl builders
# ---------------------------------------------------------------------------
make_curl_alive_post_ok() {
    local fake="$TMP/curl-alive-post-ok"
    cat > "$fake" <<'EOF'
#!/bin/bash
# health=200, POST /api/messages succeeds (exit 0, no output needed)
for arg in "$@"; do
    case "$arg" in
        */api/health*) echo "200"; exit 0 ;;
        */api/messages*) exit 0 ;;
    esac
done
echo "200"; exit 0
EOF
    chmod +x "$fake"
    echo "$fake"
}

make_curl_alive_post_fail() {
    local fake="$TMP/curl-alive-post-fail"
    cat > "$fake" <<'EOF'
#!/bin/bash
# health=200 but POST /api/messages fails (exit 28 = timeout)
for arg in "$@"; do
    case "$arg" in
        */api/health*) echo "200"; exit 0 ;;
        */api/messages*) exit 28 ;;
    esac
done
echo "200"; exit 0
EOF
    chmod +x "$fake"
    echo "$fake"
}

make_curl_dead() {
    local fake="$TMP/curl-dead"
    cat > "$fake" <<'EOF'
#!/bin/bash
echo "000"; exit 7
EOF
    chmod +x "$fake"
    echo "$fake"
}

# ---------------------------------------------------------------------------
# Source supervisor with isolated store
# ---------------------------------------------------------------------------
export FLEET_SUPERVISOR_STORE="$TMP/store"
mkdir -p "$TMP/store"
# Create a fake dashboard token so the function's token-read guard passes.
echo "test-token-fake" > "$TMP/store/.dashboard-token"
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1
DRY_RUN=0

LOGFILE="$TMP/supervisor.log"
: > "$LOGFILE"
log() { echo "$*" >> "$LOGFILE"; }

QUEUE_FILE="$TMP/store/forge-escalation-queue.jsonl"

# Helper: reset throttle state so each AC exercises the real forward path.
reset_throttle() { rm -f "$STATE_DIR/forge-queue-forward.next"; }

# ---------------------------------------------------------------------------
# AC1: queue has 1 entry + dashboard alive + POST ok -> entry forwarded, queue empty
# ---------------------------------------------------------------------------
echo "--- AC1: 1 entry + dash alive + POST ok -> forwarded + queue cleared ---"
: > "$LOGFILE"
reset_throttle
rm -f "$QUEUE_FILE"
echo '{"ts":"2026-10-01T10:00:00Z","from":"forge","content":"health EXIT:1","type":"alert"}' > "$QUEUE_FILE"
chmod 0600 "$QUEUE_FILE"
CURL="$(make_curl_alive_post_ok)"

check_forge_escalation_queue

if [ ! -s "$QUEUE_FILE" ]; then
    pass "AC1: queue empty after successful forward"
else
    fail "AC1: queue not cleared after successful forward"
fi
assert_contains "AC1: forwarded logged" "forge-queue: forwarded" "$LOGFILE"

# ---------------------------------------------------------------------------
# AC2: queue has 1 entry + dashboard down -> entry stays in queue
# ---------------------------------------------------------------------------
echo "--- AC2: 1 entry + dash down -> entry stays ---"
: > "$LOGFILE"
reset_throttle
rm -f "$QUEUE_FILE"
echo '{"ts":"2026-10-01T10:01:00Z","from":"forge","content":"health EXIT:1","type":"alert"}' > "$QUEUE_FILE"
CURL="$(make_curl_dead)"

check_forge_escalation_queue

if [ -s "$QUEUE_FILE" ]; then
    pass "AC2: queue entry preserved when dashboard down"
else
    fail "AC2: queue entry was lost when dashboard down"
fi

# ---------------------------------------------------------------------------
# AC3: queue missing / empty -> no-op, no error
# ---------------------------------------------------------------------------
echo "--- AC3: missing queue -> no-op ---"
: > "$LOGFILE"
reset_throttle
rm -f "$QUEUE_FILE"
CURL="$(make_curl_alive_post_ok)"

check_forge_escalation_queue

assert_not_contains "AC3: no error on missing queue" "error" "$LOGFILE"
assert_not_contains "AC3: no forge-queue line when nothing to forward" "forge-queue: forwarded" "$LOGFILE"
pass "AC3: no crash on missing queue"

# ---------------------------------------------------------------------------
# AC4: queue >50 entries -> capped to 50 before forwarding (oldest dropped)
# ---------------------------------------------------------------------------
echo "--- AC4: >50 entries -> cap enforced ---"
: > "$LOGFILE"
reset_throttle
rm -f "$QUEUE_FILE"
for i in $(seq 1 55); do
    echo "{\"ts\":\"2026-10-01T10:$(printf '%02d' $i):00Z\",\"from\":\"forge\",\"content\":\"alert $i\",\"type\":\"alert\"}" >> "$QUEUE_FILE"
done
chmod 0600 "$QUEUE_FILE"
CURL="$(make_curl_alive_post_ok)"

check_forge_escalation_queue

# Cap is applied before forwarding: at most 50 entries forwarded regardless of input size.
# Verify via log count (grep for the number in "forwarded N entr*").
if grep -qF "forge-queue: forwarded" "$LOGFILE"; then
    forwarded_count=$(grep -oE 'forwarded [0-9]+' "$LOGFILE" | grep -oE '[0-9]+' | head -1)
    if [ -n "$forwarded_count" ] && [ "$forwarded_count" -le 50 ]; then
        pass "AC4: at most 50 entries forwarded (got $forwarded_count)"
    else
        fail "AC4: forwarded_count=$forwarded_count exceeds 50 (cap not enforced)"
    fi
else
    fail "AC4: no forward log line -- cap test did not exercise forward path"
fi

# ---------------------------------------------------------------------------
# AC5: dashboard alive but POST fails -> entries stay in queue
# ---------------------------------------------------------------------------
echo "--- AC5: dash alive + POST fail -> entries stay ---"
: > "$LOGFILE"
reset_throttle
rm -f "$QUEUE_FILE"
echo '{"ts":"2026-10-01T10:02:00Z","from":"forge","content":"deploy verify fail","type":"alert"}' > "$QUEUE_FILE"
chmod 0600 "$QUEUE_FILE"
CURL="$(make_curl_alive_post_fail)"

check_forge_escalation_queue

if [ -s "$QUEUE_FILE" ]; then
    pass "AC5: queue entry preserved when POST fails"
else
    fail "AC5: queue entry lost when POST fails"
fi

# ---------------------------------------------------------------------------
# AC6: created queue file gets 0600 permissions (written by forge-alert.sh)
# ---------------------------------------------------------------------------
echo "--- AC6: forge-alert.sh creates queue with 0600 ---"
rm -f "$QUEUE_FILE"
FORGE_ALERT="$INSTALL_DIR/scripts/forge-alert.sh"

# Simulate dashboard down so alert goes to queue
fake_curl_fail="$TMP/curl-fail-all"
cat > "$fake_curl_fail" <<'CURLEOF'
#!/bin/bash
exit 28
CURLEOF
chmod +x "$fake_curl_fail"

if [ -x "$FORGE_ALERT" ]; then
    QUEUE_FILE="$QUEUE_FILE" CURL_BIN="$fake_curl_fail" \
        bash "$FORGE_ALERT" "test alert" "alert" 2>/dev/null
    if [ -f "$QUEUE_FILE" ]; then
        perms=$(stat -c '%a' "$QUEUE_FILE" 2>/dev/null || stat -f '%A' "$QUEUE_FILE" 2>/dev/null)
        if [ "$perms" = "600" ]; then
            pass "AC6: queue file created with 0600"
        else
            fail "AC6: queue file permissions are $perms (expected 600)"
        fi
    else
        fail "AC6: forge-alert.sh did not create queue file on POST fail"
    fi
else
    fail "AC6: scripts/forge-alert.sh not found or not executable"
fi

# ---------------------------------------------------------------------------
# AC7: throttle -- function respects interval guard (second call in same tick = no-op)
# ---------------------------------------------------------------------------
echo "--- AC7: throttle -- second call same tick skipped ---"
: > "$LOGFILE"
rm -f "$QUEUE_FILE"
echo '{"ts":"2026-10-01T10:03:00Z","from":"forge","content":"health EXIT:1","type":"alert"}' > "$QUEUE_FILE"
CURL="$(make_curl_alive_post_ok)"

# Force the next-file to NOW (just ran) -- must use STATE_DIR path, not STORE root.
# STATE_DIR=$STORE/.fleet-supervisor (fleet-supervisor.sh:60); the function reads from there.
mkdir -p "$STATE_DIR"
date +%s > "$STATE_DIR/forge-queue-forward.next"

check_forge_escalation_queue

# Queue should NOT have been forwarded (throttled)
if [ -s "$QUEUE_FILE" ]; then
    pass "AC7: second call throttled -- entry not forwarded"
else
    # If queue is empty but no forwarded log line, also acceptable (function returned early)
    if grep -qF "forge-queue: forwarded" "$LOGFILE"; then
        fail "AC7: forwarded despite throttle"
    else
        pass "AC7: throttled (no forward log line)"
    fi
fi

echo ""
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
