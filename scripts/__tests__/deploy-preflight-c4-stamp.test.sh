#!/bin/bash
# Tests the C4 build-stamp provenance logic.
# Tests the stamp creation (build-stamp.mjs) and the C4 logic in isolation.
# The C4 preflight integration requires the full repo env so it is covered by
# deploy-backup-precondition.test.sh; these tests focus on the stamp writer
# and the C4 comparison logic (extracted as a portable snippet).
#
# Run: bash scripts/__tests__/deploy-preflight-c4-stamp.test.sh

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# Minimal git repo for stamp tests
make_repo() {
  local dir="$1"
  mkdir -p "$dir/dist"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@t; git -C "$dir" config user.name t
  echo seed > "$dir/seed.txt"
  git -C "$dir" add -A >/dev/null; git -C "$dir" commit -qm init
  echo 'console.log(1)' > "$dir/dist/index.js"
}

# ---------------------------------------------------------------------------
# Part 1: build-stamp.mjs writes dist/.built-from with the current HEAD SHA
# ---------------------------------------------------------------------------
echo "--- Part 1: build-stamp.mjs writes dist/.built-from ---"

REPO1="$WORK/stamp_repo"
make_repo "$REPO1"
expected_sha=$(git -C "$REPO1" rev-parse HEAD)

(cd "$REPO1" && node "$INSTALL_DIR/scripts/build-stamp.mjs" 2>&1)
rc=$?

if [ "$rc" -ne 0 ]; then
  fail "build-stamp.mjs exited non-zero ($rc)"
else
  pass "build-stamp.mjs exits 0"
fi

if [ ! -f "$REPO1/dist/.built-from" ]; then
  fail "dist/.built-from not created"
else
  pass "dist/.built-from created"
  actual=$(tr -d '[:space:]' < "$REPO1/dist/.built-from")
  if [ "$actual" = "$expected_sha" ]; then
    pass "dist/.built-from contains HEAD SHA (${expected_sha:0:8})"
  else
    fail "dist/.built-from='$actual' != expected '$expected_sha'"
  fi
fi

echo

# ---------------------------------------------------------------------------
# Part 2: C4 provenance logic (inline, mirrors deploy-preflight-unifier.sh)
# Verifies the three cases: match, mismatch, absent stamp.
# ---------------------------------------------------------------------------
echo "--- Part 2: C4 provenance logic (isolated) ---"

c4_check() {
  local dist_dir="$1" target_sha="$2"
  local stamp_file="$dist_dir/.built-from"

  if [ ! -f "$stamp_file" ]; then
    # No stamp: recency-only (backward compat)
    echo "NOTE C4: recency only. Provenance unverifiable (no dist/.built-from)."
    return 0
  fi

  local built_from; built_from=$(tr -d '[:space:]' < "$stamp_file")
  if [ "$built_from" = "$target_sha" ]; then
    echo "PASS C4: provenance verified -- dist built from ${built_from:0:8}"
    return 0
  else
    echo "FAIL C4: provenance mismatch -- dist built from ${built_from:0:8} but target is ${target_sha:0:8}"
    return 1
  fi
}

# Case A: stamp matches target
DIST_A="$WORK/dist_a"
mkdir -p "$DIST_A"
sha_a="abcdef1234567890abcdef1234567890abcdef12"
printf '%s\n' "$sha_a" > "$DIST_A/.built-from"
out_a=$(c4_check "$DIST_A" "$sha_a")
if echo "$out_a" | grep -q "^PASS C4:"; then
  pass "Case A (match): PASS emitted"
else
  fail "Case A (match): PASS not emitted. Got: $out_a"
fi
if echo "$out_a" | grep -q "NOTE"; then
  fail "Case A: NOTE should not appear when stamp matches"
else
  pass "Case A: NOTE absent (provenance confirmed)"
fi

# Case B: stamp mismatches
DIST_B="$WORK/dist_b"
mkdir -p "$DIST_B"
sha_b_built="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
sha_b_target="cccccccccccccccccccccccccccccccccccccccc"
printf '%s\n' "$sha_b_built" > "$DIST_B/.built-from"
out_b=$(c4_check "$DIST_B" "$sha_b_target")
rc_b=$?
if echo "$out_b" | grep -q "^FAIL C4:"; then
  pass "Case B (mismatch): FAIL emitted"
else
  fail "Case B (mismatch): FAIL not emitted. Got: $out_b"
fi
if [ "$rc_b" -ne 0 ]; then
  pass "Case B: non-zero exit on mismatch"
else
  fail "Case B: exit should be non-zero on mismatch"
fi

# Case C: no stamp -> NOTE retained
DIST_C="$WORK/dist_c"
mkdir -p "$DIST_C"
out_c=$(c4_check "$DIST_C" "any_sha")
if echo "$out_c" | grep -q "^NOTE C4:.*recency only"; then
  pass "Case C (no stamp): recency-only NOTE present"
else
  fail "Case C (no stamp): NOTE missing. Got: $out_c"
fi
if echo "$out_c" | grep -q "FAIL"; then
  fail "Case C: FAIL should not appear when stamp is absent"
else
  pass "Case C: no FAIL when stamp absent"
fi

echo

echo "=========================="
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASSED"
else
  echo "$FAIL FAILED"
  exit 1
fi
