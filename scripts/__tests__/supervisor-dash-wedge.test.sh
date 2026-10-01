#!/bin/bash
# Tests for dashboard WEDGED detection in fleet-supervisor.sh (card c9cb3cf0 / OPS-216).
#
# Scenario: /api/health returns 200 (server is "alive") but /api/agents times out or
# stalls (event-loop blocked, e.g. WAL-lock). The supervisor must distinguish this from
# a true crash: log WEDGED, NOT DEAD, and NOT trigger a relaunch.
#
# Run: bash scripts/__tests__/supervisor-dash-wedge.test.sh
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
# make_curl_wedged: health returns 200, agents returns 000 (stalled / connection refused)
make_curl_wedged() {
    local fake="$TMP/curl-wedged"
    cat > "$fake" <<'EOF'
#!/bin/bash
# Fake curl: health=200, agents=000
for arg in "$@"; do
    case "$arg" in
        */api/health*) echo "200"; exit 0 ;;
        */api/agents*) echo "000"; exit 28 ;;
    esac
done
echo "200"
exit 0
EOF
    chmod +x "$fake"
    echo "$fake"
}

# make_curl_healthy: both health and agents return 200
make_curl_healthy() {
    local fake="$TMP/curl-healthy"
    cat > "$fake" <<'EOF'
#!/bin/bash
echo "200"
exit 0
EOF
    chmod +x "$fake"
    echo "$fake"
}

# make_curl_dead: health returns 000 (server not responding)
make_curl_dead() {
    local fake="$TMP/curl-dead"
    cat > "$fake" <<'EOF'
#!/bin/bash
echo "000"
exit 7
EOF
    chmod +x "$fake"
    echo "$fake"
}

# ---------------------------------------------------------------------------
# Source supervisor with isolated store (daemon loop guard: BASH_SOURCE == $0)
# ---------------------------------------------------------------------------
export FLEET_SUPERVISOR_STORE="$TMP/store"
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/fleet-supervisor.sh" --dry-run >/dev/null 2>&1

LOGFILE="$TMP/supervisor.log"
: > "$LOGFILE"
log() { echo "$*" >> "$LOGFILE"; }

# ---------------------------------------------------------------------------
# AC1: WEDGED detected when health=200 but agents stalls
# ---------------------------------------------------------------------------
echo "--- AC1: health OK + agents stall -> WEDGED ---"
: > "$LOGFILE"
CURL="$(make_curl_wedged)"

check_dash_wedge
grep -qF "WEDGED" "$LOGFILE" \
    && pass "AC1: WEDGED logged when agents stalls" \
    || fail "AC1: WEDGED logged when agents stalls"

# ---------------------------------------------------------------------------
# AC2: WEDGED is distinct from DEAD -- no launch/relaunch triggered
# ---------------------------------------------------------------------------
echo "--- AC2: WEDGED != DEAD, no relaunch ---"
: > "$LOGFILE"
CURL="$(make_curl_wedged)"

check_dash_wedge
assert_not_contains "AC2: no 'launching' on WEDGED" "launching" "$LOGFILE"
assert_not_contains "AC2: no 'relaunching' on WEDGED" "relaunching" "$LOGFILE"

# ---------------------------------------------------------------------------
# AC3: healthy (both endpoints respond) -> no WEDGED
# ---------------------------------------------------------------------------
echo "--- AC3: both endpoints healthy -> no WEDGED ---"
: > "$LOGFILE"
CURL="$(make_curl_healthy)"

check_dash_wedge
assert_not_contains "AC3: no WEDGED when healthy" "WEDGED" "$LOGFILE"

# ---------------------------------------------------------------------------
# AC4: health itself fails (DEAD) -> no WEDGED (different path)
# ---------------------------------------------------------------------------
echo "--- AC4: health fails (dead) -> no WEDGED ---"
: > "$LOGFILE"
CURL="$(make_curl_dead)"

check_dash_wedge
assert_not_contains "AC4: no WEDGED when dead" "WEDGED" "$LOGFILE"

# ---------------------------------------------------------------------------
# AC5: WEDGED log line must say 'WEDGED' and reference agents endpoint
# ---------------------------------------------------------------------------
echo "--- AC5: WEDGED message references /api/agents ---"
: > "$LOGFILE"
CURL="$(make_curl_wedged)"

check_dash_wedge
grep -qF "WEDGED" "$LOGFILE" && grep -qF "agents" "$LOGFILE" \
    && pass "AC5: WEDGED message references agents" \
    || fail "AC5: WEDGED message references agents"

echo ""
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
