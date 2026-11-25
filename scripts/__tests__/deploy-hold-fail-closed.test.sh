#!/bin/bash
# Fail-closed tests for deploy.sh Step 0 DEPLOY-HOLD sentinel check (card 9fa9f4dc).
#
# Defect (fail-OPEN): the Step 0 loop decided HOLD-ACTIVE with
#   git cat-file -e "${held_sha}^{commit}" && git merge-base --is-ancestor ...
# The `&&` short-circuits on the cat-file ERROR for an UNRESOLVABLE suffix
# (PR#-named / typo / truncated / non-existent SHA). A command *error* is
# conflated with the condition being *false*, so the sentinel is SILENTLY
# SKIPPED and the deploy PROCEEDS -- a deploy-safety gate that ignores an
# unparseable hold. Separately, a RESOLVABLE-but-NON-ANCESTOR SHA is also
# unsafe: this repo squash-merges, so a held branch-head SHA can be absent
# from develop's ancestry while its CHANGE ships under a new SHA. Ancestry
# cannot prove the held change is absent, so non-ancestor must also block.
#
# Fix: an explicit resolve_ok result + fail-closed on both unresolvable and
# non-ancestor markers; the resolvable-ANCESTOR inert-flag path stays
# byte-identical (no regression for the live inert sentinel).
#
# Unlike deploy-hold-inert-ack.test.sh (which inlines a mirror of Step 0),
# this harness invokes the REAL scripts/deploy.sh --dry-run against a sandbox
# repo so it exercises the production control-flow directly. A stub
# deploy-delta-check.py that reports "Delta: 0 PR(s)" makes the PROCEED path
# exit 0 cleanly at Step 1; an active hold calls abort in Step 0 and exits
# non-zero before Step 1 ever runs.
#   BLOCK   == non-zero exit + the loud remediation message
#   PROCEED == reaches past Step 0 (exit 0 / "Nothing to deploy")
#
# Run: bash scripts/__tests__/deploy-hold-fail-closed.test.sh
#   DEPLOY_SH=/path/to/old/deploy.sh bash ...   # run against an alternate deploy.sh (RED proof)

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SH="${DEPLOY_SH:-$HERE/../deploy.sh}"
if [ ! -f "$DEPLOY_SH" ]; then
  echo "FATAL: deploy.sh not found at $DEPLOY_SH" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Build a sandbox repo rooted so that deploy.sh's REPO=scripts/.. resolves to
# it. Returns "held_sha target_sha" where held_sha is an ancestor of target.
# A side-branch commit (non-ancestor of target) is also created and its SHA
# written to $dir/.side_sha for the non-ancestor fixture.
# ---------------------------------------------------------------------------
make_repo() {
  local dir="$1"
  mkdir -p "$dir/scripts" "$dir/store"
  cp "$DEPLOY_SH" "$dir/scripts/deploy.sh"
  # Stub delta-check: PROCEED path exits 0 cleanly ("Delta: 0 PR(s)").
  cat > "$dir/scripts/deploy-delta-check.py" <<'PY'
print("Delta: 0 PR(s)")
PY

  git -C "$dir" init -q
  git -C "$dir" config user.email "t@t"
  git -C "$dir" config user.name "t"
  echo "base" > "$dir/base.txt"
  git -C "$dir" add -A >/dev/null
  git -C "$dir" commit -qm "base"
  local held_sha; held_sha=$(git -C "$dir" rev-parse HEAD)

  # Side branch off base -> a real commit that is NOT an ancestor of target.
  git -C "$dir" checkout -q -b side
  echo "side" > "$dir/side.txt"
  git -C "$dir" add -A >/dev/null
  git -C "$dir" commit -qm "side commit"
  local side_sha; side_sha=$(git -C "$dir" rev-parse HEAD)
  echo "$side_sha" > "$dir/.side_sha"

  git -C "$dir" checkout -q master 2>/dev/null || git -C "$dir" checkout -q main 2>/dev/null \
    || git -C "$dir" checkout -q "$held_sha" -B main
  echo "tip" > "$dir/tip.txt"
  git -C "$dir" add -A >/dev/null
  git -C "$dir" commit -qm "tip"
  local target_sha; target_sha=$(git -C "$dir" rev-parse HEAD)

  echo "$held_sha $target_sha"
}

# Invoke the REAL deploy.sh --dry-run from inside the sandbox repo.
# Sets globals OUT (combined output) and RC (exit code) in the caller.
run_deploy() {
  local dir="$1" target="$2"
  OUT=$(cd "$dir" && bash scripts/deploy.sh --dry-run --target "$target" 2>&1)
  RC=$?
}

# ---------------------------------------------------------------------------
# Fixture 1: PR#-named suffix (.deploy-hold-651) -> unresolvable -> BLOCK.
# ---------------------------------------------------------------------------
echo "--- Fixture 1: PR#-named suffix -> unresolvable -> BLOCK ---"
R1="$WORK/f1"
read -r held1 target1 <<< "$(make_repo "$R1")"
cat > "$R1/store/.deploy-hold-651" <<EOF
DEPLOY HOLD (PR#651 - session-end hook activation)
Held until c12 sign-off. Merge commit noted in body only.
EOF
run_deploy "$R1" "$target1"; out1="$OUT"; rc1="$RC"
if [ "$rc1" -ne 0 ]; then
  pass "F1: PR#-named sentinel -> non-zero exit (fail-closed BLOCK)"
else
  fail "F1: PR#-named sentinel must BLOCK, got rc=0. Out: $out1"
fi
if echo "$out1" | grep -q "does not resolve"; then
  pass "F1: 'does not resolve' remediation emitted"
else
  fail "F1: 'does not resolve' message missing. Out: $out1"
fi
echo

# ---------------------------------------------------------------------------
# Fixture 2: typo / non-hex garbage suffix -> unresolvable -> BLOCK.
# ---------------------------------------------------------------------------
echo "--- Fixture 2: typo (non-hex garbage) suffix -> unresolvable -> BLOCK ---"
R2="$WORK/f2"
read -r held2 target2 <<< "$(make_repo "$R2")"
cat > "$R2/store/.deploy-hold-notacommit-zz" <<EOF
DEPLOY HOLD (typo'd marker name -- not a commit ref)
EOF
run_deploy "$R2" "$target2"; out2="$OUT"; rc2="$RC"
if [ "$rc2" -ne 0 ]; then
  pass "F2: typo suffix -> non-zero exit (fail-closed BLOCK)"
else
  fail "F2: typo suffix must BLOCK, got rc=0. Out: $out2"
fi
if echo "$out2" | grep -q "does not resolve"; then
  pass "F2: 'does not resolve' remediation emitted"
else
  fail "F2: 'does not resolve' message missing. Out: $out2"
fi
echo

# ---------------------------------------------------------------------------
# Fixture 3: non-existent 40-char SHA -> unresolvable -> BLOCK.
# ---------------------------------------------------------------------------
echo "--- Fixture 3: non-existent 40-char SHA -> unresolvable -> BLOCK ---"
R3="$WORK/f3"
read -r held3 target3 <<< "$(make_repo "$R3")"
FAKE_SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
cat > "$R3/store/.deploy-hold-$FAKE_SHA" <<EOF
DEPLOY HOLD (SHA is well-formed but no such object exists)
EOF
run_deploy "$R3" "$target3"; out3="$OUT"; rc3="$RC"
if [ "$rc3" -ne 0 ]; then
  pass "F3: non-existent SHA -> non-zero exit (fail-closed BLOCK)"
else
  fail "F3: non-existent SHA must BLOCK, got rc=0. Out: $out3"
fi
if echo "$out3" | grep -q "does not resolve"; then
  pass "F3: 'does not resolve' remediation emitted"
else
  fail "F3: 'does not resolve' message missing. Out: $out3"
fi
echo

# ---------------------------------------------------------------------------
# Fixture 4: valid SHA that is NOT an ancestor of target (side branch) -> BLOCK.
# Squash-merge can land the change under a new SHA; ancestry cannot prove the
# held change is absent, so non-ancestor must fail closed.
# ---------------------------------------------------------------------------
echo "--- Fixture 4: valid-SHA non-ancestor -> BLOCK ---"
R4="$WORK/f4"
read -r held4 target4 <<< "$(make_repo "$R4")"
side4=$(cat "$R4/.side_sha")
cat > "$R4/store/.deploy-hold-$side4" <<EOF
DEPLOY HOLD (held SHA lives on a side branch, not in target ancestry)
EOF
run_deploy "$R4" "$target4"; out4="$OUT"; rc4="$RC"
if [ "$rc4" -ne 0 ]; then
  pass "F4: non-ancestor SHA -> non-zero exit (fail-closed BLOCK)"
else
  fail "F4: non-ancestor SHA must BLOCK, got rc=0. Out: $out4"
fi
if echo "$out4" | grep -qi "not an ancestor"; then
  pass "F4: 'not an ancestor' remediation emitted"
else
  fail "F4: 'not an ancestor' message missing. Out: $out4"
fi
echo

# ---------------------------------------------------------------------------
# Fixture 5: valid-SHA ANCESTOR, inert-activation-gated, flag ABSENT -> PROCEED.
# This is the live/happy case -- proves the byte-identical inert path.
# ---------------------------------------------------------------------------
echo "--- Fixture 5: ancestor + inert-activation-gated, flag absent -> PROCEED ---"
R5="$WORK/f5"
read -r held5 target5 <<< "$(make_repo "$R5")"
cat > "$R5/store/.deploy-hold-$held5" <<EOF
DEPLOY HOLD (activation-gated)
HOLD-TYPE: inert-activation-gated FLAG=store/session-end-marker.enabled
Held code is live-but-inert until the activation flag is set.
EOF
# Flag file ABSENT (not created).
run_deploy "$R5" "$target5"; out5="$OUT"; rc5="$RC"
if [ "$rc5" -eq 0 ]; then
  pass "F5: inert flag absent -> exit 0 (PROCEED, byte-identical inert path)"
else
  fail "F5: inert flag absent should PROCEED (rc=0), got rc=$rc5. Out: $out5"
fi
if echo "$out5" | grep -q "inert-activation-gated"; then
  pass "F5: inert WARN emitted"
else
  fail "F5: inert WARN missing. Out: $out5"
fi
if echo "$out5" | grep -q "ABORT:"; then
  fail "F5: ABORT must not appear for inert flag-absent path. Out: $out5"
else
  pass "F5: no ABORT (inert path taken)"
fi
echo

# ---------------------------------------------------------------------------
# Fixture 5b (companion): valid-SHA ANCESTOR, PLAIN hold (no inert header) -> BLOCK.
# Proves ancestor-blocking behavior for an ordinary active hold is unchanged.
# ---------------------------------------------------------------------------
echo "--- Fixture 5b: ancestor + plain hold (no inert header) -> BLOCK ---"
R5B="$WORK/f5b"
read -r held5b target5b <<< "$(make_repo "$R5B")"
cat > "$R5B/store/.deploy-hold-$held5b" <<EOF
DEPLOY HOLD (plain sentinel, no HOLD-TYPE header)
Blocking until all release conditions are manually verified.
EOF
run_deploy "$R5B" "$target5b"; out5b="$OUT"; rc5b="$RC"
if [ "$rc5b" -ne 0 ]; then
  pass "F5b: plain ancestor hold -> non-zero exit (BLOCK, unchanged)"
else
  fail "F5b: plain ancestor hold must BLOCK, got rc=0. Out: $out5b"
fi
if echo "$out5b" | grep -q "ABORT:"; then
  pass "F5b: ABORT emitted (ordinary active hold)"
else
  fail "F5b: ABORT missing for plain ancestor hold. Out: $out5b"
fi
echo

# ---------------------------------------------------------------------------
# Fixture 6: empty marker named with a PR#/unresolvable suffix -> BLOCK.
# grep on the empty file must not crash; the filename drives resolution.
# ---------------------------------------------------------------------------
echo "--- Fixture 6: empty marker, unresolvable suffix -> BLOCK (no grep crash) ---"
R6="$WORK/f6"
read -r held6 target6 <<< "$(make_repo "$R6")"
: > "$R6/store/.deploy-hold-702"   # empty file, PR#-style suffix
run_deploy "$R6" "$target6"; out6="$OUT"; rc6="$RC"
if [ "$rc6" -ne 0 ]; then
  pass "F6: empty unresolvable marker -> non-zero exit (fail-closed BLOCK)"
else
  fail "F6: empty unresolvable marker must BLOCK, got rc=0. Out: $out6"
fi
if echo "$out6" | grep -q "does not resolve"; then
  pass "F6: 'does not resolve' remediation emitted (filename drove resolution)"
else
  fail "F6: 'does not resolve' message missing. Out: $out6"
fi
echo

# ---------------------------------------------------------------------------
# Fixture 7: ancestor + valid inert header PLUS trailing junk lines, flag
# absent -> PROCEED. FLAG= must still parse correctly despite extra junk.
# ---------------------------------------------------------------------------
echo "--- Fixture 7: ancestor + inert header + trailing junk, flag absent -> PROCEED ---"
R7="$WORK/f7"
read -r held7 target7 <<< "$(make_repo "$R7")"
cat > "$R7/store/.deploy-hold-$held7" <<EOF
DEPLOY HOLD (activation-gated, with trailing junk)
HOLD-TYPE: inert-activation-gated FLAG=store/session-end-marker.enabled
Held code is live-but-inert until the activation flag is set.
--- extra notes below ---
random junk line 1
HOLD-TYPE: this-is-not-a-real-header FLAG=store/decoy.enabled
random junk line 2
EOF
# Real flag ABSENT; decoy must not be picked (head -1 takes the first valid line).
run_deploy "$R7" "$target7"; out7="$OUT"; rc7="$RC"
if [ "$rc7" -eq 0 ]; then
  pass "F7: trailing junk tolerated, flag absent -> exit 0 (PROCEED)"
else
  fail "F7: trailing junk should still PROCEED (rc=0), got rc=$rc7. Out: $out7"
fi
if echo "$out7" | grep -q "inert-activation-gated"; then
  pass "F7: inert WARN emitted (FLAG parsed despite junk)"
else
  fail "F7: inert WARN missing. Out: $out7"
fi
if echo "$out7" | grep -q "ABORT:"; then
  fail "F7: ABORT must not appear (junk tolerated, flag absent). Out: $out7"
else
  pass "F7: no ABORT (inert path held under trailing junk)"
fi
echo

echo "=========================="
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASSED"
else
  echo "$FAIL FAILED"
  exit 1
fi
