#!/bin/bash
# Tests the precondition in scripts/deploy-backup.sh: when may this script label
# the live dist/ with the sha in store/.deployed-tip, and when must it refuse?
#
# Why this exists: the first version compared `git rev-parse HEAD` to the
# deployed tip. That is a correlate, not the object being labelled. The
# documented build path is an isolated worktree specifically so the main tree's
# HEAD does not move, and the same skill FORBIDS bringing the main tree back to
# develop -- so a main tree parked on another agent's feature branch is a normal,
# documented state in which the old check could never be satisfied and no
# rollback point could be taken (thor N11). Case 1 below is that state; it used
# to exit 2.
#
# The fixtures are throwaway git repos under a temp root, and DEPLOY_BACKUP_REPO
# / DEPLOY_BACKUP_ROOT point the script at them, so nothing here touches the live
# tree or the live rollback points.
#
# Run: bash scripts/__tests__/deploy-backup-precondition.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BACKUP="$INSTALL_DIR/scripts/deploy-backup.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# make_repo <dir> <branch> -> echoes the commit sha
make_repo() {
  local dir="$1" branch="$2"
  mkdir -p "$dir/store" "$dir/dist"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@t; git -C "$dir" config user.name t
  echo seed > "$dir/seed.txt"
  git -C "$dir" add -A >/dev/null; git -C "$dir" commit -qm seed
  local sha; sha=$(git -C "$dir" rev-parse HEAD)
  if [ "$branch" != "-" ]; then
    # The branch must carry a commit of its own, otherwise HEAD still equals the
    # deployed tip and the fixture would not reproduce the state at all: an agent
    # parked in the shared checkout has COMMITTED there. Without this, the old
    # HEAD-based check passes case 1 and the regression looks fixed when it is
    # only unexercised.
    git -C "$dir" checkout -qb "$branch"
    echo work > "$dir/wip.txt"
    git -C "$dir" add -A >/dev/null; git -C "$dir" commit -qm wip
  fi
  echo "console.log(1)" > "$dir/dist/index.js"
  printf '%s\n' "$sha" > "$dir/store/.deployed-tip"
  echo "$sha"
}

run_backup() {                  # run_backup <repo> <backup-root> -> rc, output on stdout
  DEPLOY_BACKUP_REPO="$1" DEPLOY_BACKUP_ROOT="$2" bash "$BACKUP" --no-gate 2>&1
}

echo "deploy-backup.sh preconditions"

# --- 1. the documented worktree flow: main tree parked on someone else's branch,
#        dist/ untouched. The marker was written after dist/, as step 6b does.
R1="$WORK/parked"; B1="$WORK/backups1"
SHA1=$(make_repo "$R1" "feat/other-agents-work")
touch -d '-10 minutes' "$R1/dist/index.js"
touch "$R1/store/.deployed-tip"
out=$(run_backup "$R1" "$B1"); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "main tree on another agent's branch, dist untouched -> backup taken (thor N11)"
else
  fail "parked main tree should still get a rollback point, rc=$rc: $out"
fi

# The rollback point rollback.sh needs: flat layout, labelled with the live build.
dest=$(ls -1d "$B1"/*/ 2>/dev/null | tail -1)
if [ -n "$dest" ] && [ -f "${dest}index.js" ] \
   && [ "$(tr -d '[:space:]' < "${dest}deployed-sha.txt" 2>/dev/null)" = "$SHA1" ]; then
  pass "backup is flat and carries deployed-sha.txt = the live build"
else
  fail "backup layout/label wrong in '${dest:-none}'"
fi

# --- 2. built before backing up: dist/ is newer than the marker, so it is no
#        longer provably the build the marker names.
R2="$WORK/built"; B2="$WORK/backups2"
make_repo "$R2" "-" >/dev/null
touch -d '-10 minutes' "$R2/store/.deployed-tip"
touch "$R2/dist/index.js"
out=$(run_backup "$R2" "$B2"); rc=$?
if [ "$rc" -eq 2 ] && echo "$out" | grep -q "AFTER store/.deployed-tip"; then
  pass "dist rebuilt after the last recorded deploy -> refuses to mislabel (DA-23)"
else
  fail "should refuse with rc=2, got rc=$rc: $out"
fi
[ -z "$(ls -A "$B2" 2>/dev/null)" ] \
  && pass "a refused run leaves no half-made rollback point" \
  || fail "refused run created $(ls -A "$B2")"

# --- 3. refusing must not read as a dead end when the bytes still exist in the
#        previous rollback point.
R3="$WORK/built2"; B3="$WORK/backups3"
SHA3=$(make_repo "$R3" "-")
mkdir -p "$B3/20260804-030000"
printf '%s\n' "$SHA3" > "$B3/20260804-030000/deployed-sha.txt"
touch -d '-10 minutes' "$R3/store/.deployed-tip"
touch "$R3/dist/index.js"
out=$(run_backup "$R3" "$B3")
if echo "$out" | grep -q "already holds ${SHA3:0:8}"; then
  pass "refusal points at the existing rollback point holding that build"
else
  fail "refusal should name the usable previous backup: $out"
fi

# --- 4. an unreadable marker must not be treated as "old enough".
R4="$WORK/nomarker"; B4="$WORK/backups4"
make_repo "$R4" "-" >/dev/null
rm -f "$R4/store/.deployed-tip"
out=$(run_backup "$R4" "$B4"); rc=$?
[ "$rc" -eq 2 ] \
  && pass "missing deployed-tip -> refuses rather than guessing a label" \
  || fail "missing marker should exit 2, got rc=$rc: $out"

echo
if [ "$FAIL" -gt 0 ]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
