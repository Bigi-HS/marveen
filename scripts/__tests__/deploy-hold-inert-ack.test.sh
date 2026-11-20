#!/bin/bash
# Tests the verified-inert hold logic in deploy.sh Step 0 (card c2f0557a).
#
# Problem: .deploy-hold-651 is a PERMANENT sentinel that blocks every deploy
# via the hard-abort in Step 0. The held code (ae2baae) is live-but-inert
# because a flag-gate (store/session-end-marker.enabled) keeps the hook
# injection dormant. Removing the sentinel would be wrong (the activation
# still needs c12 sign-off). The fix: a machine-readable header
#   HOLD-TYPE: inert-activation-gated FLAG=store/session-end-marker.enabled
# in the sentinel lets deploy.sh distinguish "hold on inert code" from "hold
# on live active code". When the header is present and the flag is ABSENT,
# deploy.sh WARNs and continues. When the flag IS present, it still hard-aborts.
#
# Tests:
#   A. Sentinel without HOLD-TYPE header -> hard-abort (existing behaviour)
#   B. Sentinel with HOLD-TYPE + flag ABSENT -> WARN + continue (new behaviour)
#   C. Sentinel with HOLD-TYPE + flag PRESENT -> hard-abort (activation live)
#   D. Sentinel with HOLD-TYPE but malformed FLAG line -> treated as blocking
#   E. No sentinel -> pass clean
#
# The test inlines the Step 0 logic from deploy.sh so it can be unit-tested
# without running the full deploy pipeline. The logic is kept in sync via
# a comment reference to the deploy.sh section.
#
# Run: bash scripts/__tests__/deploy-hold-inert-ack.test.sh

set -u

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Helper: minimal git repo where held_sha is an ancestor of target_sha
# ---------------------------------------------------------------------------
make_repo() {
  local dir="$1"
  mkdir -p "$dir/store"
  git -C "$dir" init -q
  git -C "$dir" config user.email "t@t"
  git -C "$dir" config user.name "t"
  echo "base" > "$dir/base.txt"
  git -C "$dir" add -A >/dev/null
  git -C "$dir" commit -qm "base"
  local held_sha; held_sha=$(git -C "$dir" rev-parse HEAD)
  echo "tip" > "$dir/tip.txt"
  git -C "$dir" add -A >/dev/null
  git -C "$dir" commit -qm "tip"
  local target_sha; target_sha=$(git -C "$dir" rev-parse HEAD)
  echo "$held_sha $target_sha"
}

# ---------------------------------------------------------------------------
# Mirror of deploy.sh Step 0 hold-check logic (card c2f0557a).
# Arguments: $1=REPO $2=TARGET_SHA
# Returns: 0 = continue, 1 = hard-abort
# Prints WARN / ABORT messages to stdout for test inspection.
# This function MUST be kept in sync with scripts/deploy.sh Step 0.
# ---------------------------------------------------------------------------
check_step0() {
  local REPO="$1" target_sha="$2"
  local hold_files hold_hit=0

  shopt -s nullglob
  hold_files=("$REPO"/store/.deploy-hold-*)
  shopt -u nullglob

  if [ "${#hold_files[@]}" -eq 0 ]; then
    echo "PASS: no deploy-hold sentinels found"
    return 0
  fi

  for hf in "${hold_files[@]}"; do
    local held_sha="${hf##*/.deploy-hold-}"
    if git -C "$REPO" cat-file -e "${held_sha}^{commit}" 2>/dev/null \
       && git -C "$REPO" merge-base --is-ancestor "$held_sha" "$target_sha" 2>/dev/null; then
      echo "HOLD ACTIVE -- held commit ${held_sha:0:8}"

      local inert_flag_path=""
      if grep -qE "^HOLD-TYPE:[[:space:]]*inert-activation-gated" "$hf" 2>/dev/null; then
        inert_flag_path=$(grep -E "^HOLD-TYPE:[[:space:]]*inert-activation-gated" "$hf" \
          | grep -oE "FLAG=[^[:space:]]+" | sed 's/FLAG=//' | head -1)
      fi

      if [ -n "$inert_flag_path" ]; then
        local flag_abs="$REPO/$inert_flag_path"
        if [ ! -f "$flag_abs" ]; then
          echo "WARN: inert-activation-gated (flag absent: $inert_flag_path) -- continuing"
          # do not increment hold_hit
        else
          echo "WARN: flag IS present ($inert_flag_path) -- treating as blocking hold"
          hold_hit=$((hold_hit + 1))
        fi
      else
        hold_hit=$((hold_hit + 1))
      fi
    fi
  done

  if [ "$hold_hit" -gt 0 ]; then
    echo "ABORT: $hold_hit active DEPLOY-HOLD sentinel(s)"
    return 1
  fi

  echo "PASS: no active blocking holds"
  return 0
}

# ---------------------------------------------------------------------------
# Case A: sentinel WITHOUT HOLD-TYPE header -> hard-abort
# ---------------------------------------------------------------------------
echo "--- Case A: plain sentinel (no HOLD-TYPE) -> hard-abort ---"
REPO_A="$WORK/repo_a"
read -r held_a target_a <<< "$(make_repo "$REPO_A")"

cat > "$REPO_A/store/.deploy-hold-$held_a" <<EOF
DEPLOY HOLD (plain sentinel, no HOLD-TYPE header)
Held for manual release-condition verification.
EOF

out_a=$(check_step0 "$REPO_A" "$target_a")
rc_a=$?

if [ "$rc_a" -ne 0 ]; then
  pass "Case A: plain sentinel -> non-zero exit (hard-abort)"
else
  fail "Case A: plain sentinel should abort, got rc=0"
fi
if echo "$out_a" | grep -q "ABORT:"; then
  pass "Case A: ABORT message emitted"
else
  fail "Case A: ABORT message missing. Got: $out_a"
fi
echo

# ---------------------------------------------------------------------------
# Case B: sentinel WITH HOLD-TYPE + flag ABSENT -> WARN + continue
# ---------------------------------------------------------------------------
echo "--- Case B: inert-activation-gated + flag absent -> WARN + continue ---"
REPO_B="$WORK/repo_b"
read -r held_b target_b <<< "$(make_repo "$REPO_B")"

cat > "$REPO_B/store/.deploy-hold-$held_b" <<EOF
DEPLOY HOLD (activation-gated)
HOLD-TYPE: inert-activation-gated FLAG=store/session-end-marker.enabled
Held code is live-but-inert until the activation flag is set.
EOF
# Flag file is ABSENT (not created)

out_b=$(check_step0 "$REPO_B" "$target_b")
rc_b=$?

if [ "$rc_b" -eq 0 ]; then
  pass "Case B: flag absent -> exit 0 (continue)"
else
  fail "Case B: flag absent should continue (rc=0), got rc=$rc_b"
fi
if echo "$out_b" | grep -q "WARN:.*inert-activation-gated"; then
  pass "Case B: WARN message emitted"
else
  fail "Case B: WARN message missing. Got: $out_b"
fi
if echo "$out_b" | grep -q "ABORT:"; then
  fail "Case B: ABORT must not appear when flag is absent"
else
  pass "Case B: no ABORT (flag absent path)"
fi
echo

# ---------------------------------------------------------------------------
# Case C: sentinel WITH HOLD-TYPE + flag PRESENT -> hard-abort
# ---------------------------------------------------------------------------
echo "--- Case C: inert-activation-gated + flag present -> hard-abort ---"
REPO_C="$WORK/repo_c"
read -r held_c target_c <<< "$(make_repo "$REPO_C")"

cat > "$REPO_C/store/.deploy-hold-$held_c" <<EOF
DEPLOY HOLD (activation-gated)
HOLD-TYPE: inert-activation-gated FLAG=store/session-end-marker.enabled
Held code is live-but-inert until the activation flag is set.
EOF
# Flag file IS PRESENT (activation enabled)
touch "$REPO_C/store/session-end-marker.enabled"

out_c=$(check_step0 "$REPO_C" "$target_c")
rc_c=$?

if [ "$rc_c" -ne 0 ]; then
  pass "Case C: flag present -> non-zero exit (hard-abort)"
else
  fail "Case C: flag present should abort, got rc=0"
fi
if echo "$out_c" | grep -q "ABORT:"; then
  pass "Case C: ABORT message emitted when flag is present"
else
  fail "Case C: ABORT message missing. Got: $out_c"
fi
if echo "$out_c" | grep -q "flag IS present"; then
  pass "Case C: 'flag IS present' diagnostic shown"
else
  fail "Case C: 'flag IS present' diagnostic missing. Got: $out_c"
fi
echo

# ---------------------------------------------------------------------------
# Case D: sentinel with HOLD-TYPE but FLAG= line missing -> treat as blocking
# (defensive: malformed header must not silently bypass the hold)
# ---------------------------------------------------------------------------
echo "--- Case D: malformed HOLD-TYPE (FLAG= absent) -> blocking ---"
REPO_D="$WORK/repo_d"
read -r held_d target_d <<< "$(make_repo "$REPO_D")"

cat > "$REPO_D/store/.deploy-hold-$held_d" <<EOF
DEPLOY HOLD
HOLD-TYPE: inert-activation-gated
(no FLAG= on this line -- malformed)
EOF

out_d=$(check_step0 "$REPO_D" "$target_d")
rc_d=$?

if [ "$rc_d" -ne 0 ]; then
  pass "Case D: malformed header -> non-zero exit (blocking)"
else
  fail "Case D: malformed header should block, got rc=0"
fi
if echo "$out_d" | grep -q "ABORT:"; then
  pass "Case D: ABORT emitted for malformed header"
else
  fail "Case D: ABORT missing for malformed header. Got: $out_d"
fi
echo

# ---------------------------------------------------------------------------
# Case E: no sentinel files at all -> clean pass
# ---------------------------------------------------------------------------
echo "--- Case E: no sentinel files -> clean pass ---"
REPO_E="$WORK/repo_e"
read -r held_e target_e <<< "$(make_repo "$REPO_E")"
# No .deploy-hold-* files created

out_e=$(check_step0 "$REPO_E" "$target_e")
rc_e=$?

if [ "$rc_e" -eq 0 ]; then
  pass "Case E: no sentinel -> exit 0"
else
  fail "Case E: no sentinel should pass clean, got rc=$rc_e"
fi
if echo "$out_e" | grep -q "no deploy-hold sentinels"; then
  pass "Case E: 'no deploy-hold sentinels' message shown"
else
  fail "Case E: 'no deploy-hold sentinels' missing. Got: $out_e"
fi
echo

echo "=========================="
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASSED"
else
  echo "$FAIL FAILED"
  exit 1
fi
