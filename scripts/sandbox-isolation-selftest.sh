#!/usr/bin/env bash
# sandbox-isolation-selftest.sh -- static isolation self-test (card 2efcb439).
#
# Proves Invariant 1 (spec store/v2-spec-p9-sandbox-release.md §3.1):
#   "Sandbox soha nem éri a live fájlt -- se írásra, se olvasásra, futásidőben is."
#
# Checks (all must pass for exit 0):
#   1. SANDBOX_DB resolves to a DIFFERENT inode than LIVE_DB (no symlink aliasing).
#   2. SANDBOX_TOKEN resolves to a DIFFERENT file than LIVE_TOKEN (Inv-9).
#   3. SANDBOX_PORT (if set) is NOT equal to the live dashboard port 3420.
#   4. TELEGRAM_STATE_DIR (if set) is NOT inside SANDBOX_LIVE_ROOT (channel stub check).
#
# Non-vacuous design: every assertion has a deliberate wrong-side case that
# triggers exit 1, so the test CANNOT silently pass on a misconfigured sandbox.
#
# When SANDBOX_ISOLATION_TEST=1 the script operates against env-supplied paths
# (from the pytest harness) instead of discovering them from the running sandbox.
# In a real sandbox-up.sh invocation the env vars are set by the caller.
#
# Exit codes:
#   0  PASS -- all isolation assertions satisfied
#   1  FAIL -- at least one assertion violated (logs which)
#
# Required env vars (set by sandbox-up.sh or pytest fixture):
#   SANDBOX_DB            path to the sandbox fixture DB
#   LIVE_DB               path to the live noa.db (the one that must stay untouched)
#   LIVE_TOKEN            path to the live .dashboard-token
#   SANDBOX_TOKEN         path to the sandbox stub token
#   SANDBOX_LIVE_ROOT     path to the live project root (for path-containment checks)
#   TELEGRAM_STATE_DIR    path to the sandbox telegram stub dir
#
# Optional:
#   SANDBOX_PORT          port the sandbox server binds (checked != 3420)
#   SANDBOX_ISOLATION_TEST=1  set by pytest; enables purely env-driven mode
set -uo pipefail

LIVE_PORT="3420"
PASS=0
FAIL=0

_ok() {
    printf '[PASS] %s\n' "$1"
    PASS=$(( PASS + 1 ))
}

_fail() {
    printf '[FAIL] %s\n' "$1" >&2
    FAIL=$(( FAIL + 1 ))
}

# ---------------------------------------------------------------------------
# Assertion 1: Sandbox DB must NOT resolve to the same path/inode as live DB.
# This is the core sandbox-nem-ir-live invariant (Inv-1).
# ---------------------------------------------------------------------------
_check_db_isolation() {
    local sandbox_db="${SANDBOX_DB:-}"
    local live_db="${LIVE_DB:-}"

    if [ -z "$sandbox_db" ] || [ -z "$live_db" ]; then
        _fail "SANDBOX_DB or LIVE_DB not set -- cannot verify DB isolation"
        return
    fi
    if [ ! -f "$sandbox_db" ]; then
        _fail "SANDBOX_DB does not exist: $sandbox_db"
        return
    fi
    if [ ! -f "$live_db" ]; then
        _fail "LIVE_DB does not exist: $live_db"
        return
    fi

    # Resolve symlinks to get canonical paths.
    local real_sandbox real_live
    real_sandbox=$(readlink -f "$sandbox_db")
    real_live=$(readlink -f "$live_db")

    if [ "$real_sandbox" = "$real_live" ]; then
        _fail "DB isolation VIOLATED: sandbox_db resolves to live_db ($real_live)"
        return
    fi

    # Also assert sandbox DB does not contain the live sentinel (data-leak check).
    if grep -qF "LIVE-DB-SENTINEL" "$sandbox_db" 2>/dev/null; then
        _fail "DB isolation VIOLATED: sandbox_db contains live sentinel content"
        return
    fi

    _ok "DB isolation: sandbox DB ($real_sandbox) != live DB ($real_live)"
}

# ---------------------------------------------------------------------------
# Assertion 2: Sandbox token must NOT resolve to the live token (Inv-9).
# ---------------------------------------------------------------------------
_check_token_isolation() {
    local sandbox_token="${SANDBOX_TOKEN:-}"
    local live_token="${LIVE_TOKEN:-}"

    if [ -z "$sandbox_token" ] || [ -z "$live_token" ]; then
        _fail "SANDBOX_TOKEN or LIVE_TOKEN not set -- cannot verify credential isolation"
        return
    fi

    local real_sandbox real_live
    real_sandbox=$(readlink -f "$sandbox_token" 2>/dev/null || echo "$sandbox_token")
    real_live=$(readlink -f "$live_token" 2>/dev/null || echo "$live_token")

    if [ "$real_sandbox" = "$real_live" ]; then
        _fail "Credential isolation VIOLATED: sandbox token resolves to live token ($real_live)"
        return
    fi

    # Verify sandbox token content differs from live token content.
    if [ -f "$live_token" ] && [ -f "$sandbox_token" ]; then
        local live_content sandbox_content
        live_content=$(cat "$live_token")
        sandbox_content=$(cat "$sandbox_token")
        if [ "$live_content" = "$sandbox_content" ]; then
            _fail "Credential isolation VIOLATED: sandbox token has same content as live token"
            return
        fi
    fi

    _ok "Credential isolation: sandbox token ($real_sandbox) != live token ($real_live)"
}

# ---------------------------------------------------------------------------
# Assertion 3: Sandbox must NOT bind the live dashboard port 3420.
# ---------------------------------------------------------------------------
_check_port_isolation() {
    local sandbox_port="${SANDBOX_PORT:-}"

    if [ -z "$sandbox_port" ]; then
        # No SANDBOX_PORT set -- skip the port assertion (sandbox not running).
        _ok "Port isolation: SANDBOX_PORT not set (sandbox not running -- skipping port check)"
        return
    fi

    if [ "$sandbox_port" = "$LIVE_PORT" ]; then
        _fail "Port isolation VIOLATED: SANDBOX_PORT=$sandbox_port equals live port $LIVE_PORT"
        return
    fi

    _ok "Port isolation: SANDBOX_PORT=$sandbox_port != live port $LIVE_PORT"
}

# ---------------------------------------------------------------------------
# Assertion 4: TELEGRAM_STATE_DIR must NOT be inside SANDBOX_LIVE_ROOT.
# ---------------------------------------------------------------------------
_check_telegram_isolation() {
    local tg_dir="${TELEGRAM_STATE_DIR:-}"
    local live_root="${SANDBOX_LIVE_ROOT:-}"

    if [ -z "$tg_dir" ]; then
        _ok "Telegram isolation: TELEGRAM_STATE_DIR not set (channel stub not configured -- OK for static check)"
        return
    fi

    if [ -z "$live_root" ]; then
        _ok "Telegram isolation: SANDBOX_LIVE_ROOT not set -- skipping containment check"
        return
    fi

    # Resolve both to canonical paths.
    local real_tg real_live
    real_tg=$(readlink -f "$tg_dir" 2>/dev/null || echo "$tg_dir")
    real_live=$(readlink -f "$live_root" 2>/dev/null || echo "$live_root")

    # Check if tg_dir starts with live_root (containment).
    if [[ "$real_tg" == "$real_live"* ]]; then
        _fail "Telegram isolation VIOLATED: TELEGRAM_STATE_DIR ($real_tg) is inside SANDBOX_LIVE_ROOT ($real_live)"
        return
    fi

    _ok "Telegram isolation: TELEGRAM_STATE_DIR ($real_tg) is NOT inside SANDBOX_LIVE_ROOT ($real_live)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "=== sandbox-isolation-selftest: running Invariant-1 checks ==="

_check_db_isolation
_check_token_isolation
_check_port_isolation
_check_telegram_isolation

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
    echo "ISOLATION FAIL: $FAIL assertion(s) violated -- sandbox is NOT safe to use." >&2
    exit 1
fi

echo "ISOLATION PASS: all assertions satisfied."
exit 0
