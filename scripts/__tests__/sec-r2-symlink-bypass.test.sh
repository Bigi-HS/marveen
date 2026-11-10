#!/bin/bash
# Tests that R2 (env-file-print) detects .env access via a symlink (card c5f6d3df).
#
# Without the realpath fix, `cat mylink` where mylink -> .env passes through R2
# undetected because the token "mylink" does not match _ENV_FILE_RE.  With the
# fix, os.path.realpath(tok) resolves to .env and the rule blocks the call.
#
# Run: bash scripts/__tests__/sec-r2-symlink-bypass.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$INSTALL_DIR/scripts/hooks/guardrail-permission-rules.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# Create a real .env file and a symlink to it inside WORK.
touch "$WORK/.env"
ln -s "$WORK/.env" "$WORK/mylink"
# Also create a benign regular file.
echo "hello" > "$WORK/regular_file.txt"

invoke() {  # invoke <command_string> -> exits with hook exit code
    echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$1\"}}" \
        | python3 "$HOOK"
}

# ── Case 1: symlink to .env -- MUST BLOCK ───────────────────────────────────
invoke "cat $WORK/mylink"
rc=$?
if [ "$rc" -eq 2 ]; then
    pass "cat <symlink-to-.env> is BLOCKED (exit $rc)"
else
    fail "cat <symlink-to-.env> should be BLOCKED (exit 2), got exit $rc"
fi

# ── Case 2: direct .env access -- MUST BLOCK (regression guard) ─────────────
invoke "cat $WORK/.env"
rc=$?
if [ "$rc" -eq 2 ]; then
    pass "cat .env is BLOCKED (exit $rc)"
else
    fail "cat .env should be BLOCKED (exit 2), got exit $rc"
fi

# ── Case 3: regular file -- MUST PASS ───────────────────────────────────────
invoke "cat $WORK/regular_file.txt"
rc=$?
if [ "$rc" -eq 0 ]; then
    pass "cat regular_file.txt PASSES (exit $rc)"
else
    fail "cat regular_file.txt should PASS (exit 0), got exit $rc"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
if [ "$FAIL" -eq 0 ]; then
    echo "ALL PASS (3/3)"
    exit 0
else
    echo "$FAIL FAILURE(S)"
    exit 1
fi
