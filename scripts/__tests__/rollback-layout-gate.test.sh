#!/bin/bash
# Tests the layout gate in scripts/rollback.sh: which backup directories may be
# restored, and -- more importantly -- that the ones that must not be refuse
# BEFORE anything touches dist/.
#
# Why this exists: rollback.sh restores with `rsync -a --delete "$BACKUP_DIR/"
# "$REPO/dist/"`, which assumes a flat backup. Of the 44 timestamped backups on
# this host, 17 are flat, 22 nest the dist one level down, and 5 are something
# else -- including one that is completely EMPTY and is still eligible for the
# auto-pick glob. Restoring from any of those deletes the running build. It is
# the break-glass tool, so it gets used under pressure and trusted by default
# (card OPS-098, devil-advocate DA-13).
#
# The happy path is deliberately NOT exercised end to end: a successful restore
# kills and recreates the live server session. Everything up to and including the
# refusal is testable, and that is exactly the part that protects dist/. The
# assertions therefore check both the verdict AND that the fixture dist is still
# intact afterwards -- a gate that returns the right exit code after already
# running the rsync would pass a verdict-only test.
#
# One piece of the script is deliberately unreachable from here rather than
# untested: the post-restore `dist/index.js` assertion. The layout gate above it
# has already proved the source contains index.js, and `set -e` catches a non-zero
# rsync, so no input through the public interface can reach that assertion with it
# failing. It is defence in depth against a future edit that weakens the gate, not
# a gap in coverage -- do not read its absence from this suite as missing tests.
#
# Several assertions below check the MESSAGE, not just the exit code, on purpose.
# The blocker Dave found on PR#464 (case 9) exited 2 both before and after the fix
# -- before, because `set -e` killed the script at an assignment; after, because
# the error branch finally runs. An exit-code-only test would have stayed green
# straight through a break-glass tool that printed nothing at all.
#
# Run: bash scripts/__tests__/rollback-layout-gate.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RB="$INSTALL_DIR/scripts/rollback.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# A stand-in for the live repo. If the gate ever lets a bad restore through, the
# canary file below disappears and the assertion says so.
REPO="$WORK/repo"; mkdir -p "$REPO/dist" "$REPO/store" "$REPO/scripts"
echo "LIVE BUILD" > "$REPO/dist/index.js"
echo "asset"      > "$REPO/dist/canary.js"

BR="$WORK/backups"; mkdir -p "$BR"
mk() { mkdir -p "$BR/$1"; }
SHA=aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee

mk 20260601-000000; echo "OLD BUILD" > "$BR/20260601-000000/index.js"          # flat, unlabelled
mk 20260602-000000; echo "OLD BUILD" > "$BR/20260602-000000/index.js"
                    echo "$SHA"      > "$BR/20260602-000000/deployed-sha.txt"  # flat, labelled
mk 20260603-000000/dist; echo "OLD BUILD" > "$BR/20260603-000000/dist/index.js"  # nested
mk 20260604-000000                                                             # EMPTY
mk 20260605-000000/dist-prev; echo x > "$BR/20260605-000000/dist-prev/index.js" # unrecognised

run() { ROLLBACK_REPO="$REPO" ROLLBACK_BACKUP_ROOT="$BR" bash "$RB" "$@" 2>&1; }

dist_intact() {
  [[ -f "$REPO/dist/index.js" && -f "$REPO/dist/canary.js" \
     && "$(cat "$REPO/dist/index.js")" == "LIVE BUILD" ]]
}

echo "rollback.sh layout gate"

# --- 1. nested: the 22-dir case. Refuse, and name the inner path that works.
out=$(run "$BR/20260603-000000"); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "20260603-000000/dist$" && dist_intact; then
  pass "nested backup -> refused, live dist untouched, inner path named"
else
  fail "nested should refuse and leave dist alone (rc=$rc, intact=$(dist_intact && echo y || echo n)): $out"
fi

# --- 2. empty: the silent killer, and the one the original report missed.
out=$(run "$BR/20260604-000000"); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "EMPTY" && dist_intact; then
  pass "empty backup -> refused, live dist untouched"
else
  fail "empty should refuse (rc=$rc): $out"
fi

# --- 3. unrecognised layout: guessing which subdir is the dist deletes the build.
out=$(run "$BR/20260605-000000"); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "dist-prev" && dist_intact; then
  pass "unrecognised layout -> refused, contents listed, live dist untouched"
else
  fail "unrecognised layout should refuse (rc=$rc): $out"
fi

# --- 4. auto-pick must be gated too. Without an argument the glob picks the
#        newest dir, which here is the unrecognised one -- the realistic incident
#        shape, since nobody types a path while the fleet is down.
out=$(run); rc=$?
if [[ $rc -eq 2 ]] && dist_intact; then
  pass "auto-picked bad backup -> refused, live dist untouched"
else
  fail "auto-pick should be gated the same way (rc=$rc): $out"
fi

# --- 5. flat but unlabelled: restorable, but it leaves deployed-tip naming the
#        build being replaced, so it needs an explicit acknowledgement.
out=$(run --check "$BR/20260601-000000"); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "unlabelled"; then
  pass "flat but unlabelled -> refused until acknowledged"
else
  fail "unlabelled should require --unlabelled (rc=$rc): $out"
fi
out=$(run --check --unlabelled "$BR/20260601-000000"); rc=$?
[[ $rc -eq 0 ]] \
  && pass "--unlabelled acknowledges it and proceeds" \
  || fail "--unlabelled should proceed (rc=$rc): $out"

# --- 6. flat and labelled: the only shape that passes unannotated.
out=$(run --check "$BR/20260602-000000"); rc=$?
if [[ $rc -eq 0 ]] && echo "$out" | grep -q "${SHA:0:8}"; then
  pass "flat + labelled -> usable, build named"
else
  fail "flat labelled should be usable (rc=$rc): $out"
fi

# --- 7. the audit has to mark every class, not just count them.
out=$(run --audit)
if echo "$out" | grep -q "DANGEROUS.*20260604-000000" \
   && echo "$out" | grep -q "NOT USABLE.*20260603-000000" \
   && echo "$out" | grep -q "USABLE     20260602-000000"; then
  pass "--audit marks usable, not-usable and dangerous separately"
else
  fail "--audit output incomplete: $out"
fi

# --- 8. the hazard itself, demonstrated rather than asserted. This is the exact
#        command the pre-fix script ran (see the diff); running it against a
#        throwaway repo shows what "not usable" costs -- the live build is gone
#        and dist/dist/ is left behind. Kept in the suite so nobody later relaxes
#        the gate on the theory that a nested restore is merely untidy.
VICTIM="$WORK/victim"; mkdir -p "$VICTIM/dist"
echo "LIVE BUILD" > "$VICTIM/dist/index.js"; echo asset > "$VICTIM/dist/canary.js"
rsync -a --delete "$BR/20260603-000000/" "$VICTIM/dist/"
if [[ ! -f "$VICTIM/dist/index.js" && -f "$VICTIM/dist/dist/index.js" ]]; then
  pass "unguarded nested restore destroys the live build and leaves dist/dist/ (the defect)"
else
  fail "expected the unguarded restore to destroy dist/: $(find "$VICTIM/dist" -type f)"
fi

# --- 9. no backup at all. THE case that must speak: under `set -euo pipefail` the
#        `ls` inside all_backups exits 2 on an empty root, pipefail promotes it and
#        set -e killed the script at the assignment -- before the documented error
#        branch could print. rc was 2 either way, so assert the MESSAGE. (Dave,
#        PR#464 review; measured pre-fix as rc=2 with zero bytes of output.)
EMPTY_ROOT="$WORK/emptyroot"; mkdir -p "$EMPTY_ROOT"
out=$(ROLLBACK_REPO="$REPO" ROLLBACK_BACKUP_ROOT="$EMPTY_ROOT" bash "$RB" 2>&1); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "no valid backup dir found" && dist_intact; then
  pass "empty backup root -> refuses AND says why (not a silent death)"
else
  fail "empty root must print 'no valid backup dir found' (rc=$rc, out=[$out])"
fi

# --- 10. same shape, one step worse: the root does not exist at all.
out=$(ROLLBACK_REPO="$REPO" ROLLBACK_BACKUP_ROOT="$WORK/does-not-exist" bash "$RB" 2>&1); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "no valid backup dir found"; then
  pass "missing backup root -> refuses AND says why"
else
  fail "missing root must print the error (rc=$rc, out=[$out])"
fi

# --- 11. an unreadable dir must not be diagnosed as EMPTY: `ls -A` failing and
#         succeeding-with-no-output look identical, but one is fixed with chmod and
#         the other by choosing a different backup.
mk 20260606-000000; echo "OLD BUILD" > "$BR/20260606-000000/index.js"
chmod 000 "$BR/20260606-000000"
out=$(run "$BR/20260606-000000"); rc=$?
chmod 755 "$BR/20260606-000000"
if [[ $rc -eq 2 ]] && echo "$out" | grep -qi "permissions" && ! echo "$out" | grep -q "EMPTY" && dist_intact; then
  pass "unreadable backup -> refused as unreadable, not misreported as empty"
else
  fail "unreadable should be distinguished from empty (rc=$rc): $out"
fi

# --- 12. --audit was only recognised as argv[1], so '--check --audit' died with
#         "unknown option" -- a flag that works only in one position is a trap in a
#         tool used under pressure.
out=$(run --check --audit); rc=$?
if [[ $rc -eq 0 ]] && ! echo "$out" | grep -q "unknown option"; then
  pass "--audit is position-independent among the flags"
else
  fail "--audit should parse in any flag position (rc=$rc): $out"
fi

echo
if [[ "$FAIL" -gt 0 ]]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
