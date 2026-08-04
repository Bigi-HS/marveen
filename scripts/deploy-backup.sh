#!/usr/bin/env bash
# deploy-backup.sh -- create the rollback point, then run the pre-GO gate.
#
# This is the FIRST command of a deploy. It takes nothing live down: copying the
# running dist and reading refs are both allowed without a Genesis-GO, so the
# whole pre-GO sequence is one command.
#
#   1. copy the live dist to /tmp/marveen-deploy-backups/<YYYYmmdd-HHMMSS>/
#   2. label it with the build it contains (deployed-sha.txt)
#   3. run scripts/deploy-preflight-unifier.sh and propagate its verdict
#
# Usage:  scripts/deploy-backup.sh [--target <ref>] [--no-gate]
# Exit 0 = rollback point created and the preflight gate passed -> request GO.
# Exit 1 = the gate failed -> do NOT request GO.
# Exit 2 = the backup itself could not be made.
#
# --- Why this script exists -------------------------------------------------
# The rollback point used to be three manual shell lines in a skill file. Two
# consequences, both measured on 2026-08-04 (devil-advocate DA-12, thor N1):
#
#   * Of 54 backup directories only 2 carried deployed-sha.txt, so rollback.sh
#     could not say which build it was about to restore for the other 52. A
#     documented instruction is not a producer, the same way documentation is
#     not a detector.
#   * 29 of those 54 hold the dist under a nested dist/ subdirectory instead of
#     flat. rollback.sh rsyncs the directory *contents* into dist/ with
#     --delete, so restoring from one of those wipes the live build and leaves
#     dist/dist/. Layout drift in a break-glass tool is not cosmetic. Writing
#     the backup from one place makes the layout an invariant instead of a
#     convention (hardening rollback.sh against the 29 that already exist is
#     tracked separately).
#
# --- Why the backup comes BEFORE the gate, not after ------------------------
# The point of the C3 check is "the live build has a rollback point". Under the
# old order -- GO, then backup -- the newest backup was always one deploy behind
# at gate time, so C3 was structurally red at every pre-GO and could never be
# made green by the operator. A gate that is permanently red teaches people to
# skip the gate. Taking the backup first makes the invariant true and the check
# meaningful.

set -uo pipefail

# Before the cd: a relative $0 stops resolving once the working directory moves.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Overridable only so the regression test can point the script at a fixture tree;
# both default to the live paths and nothing in the deploy procedure sets them.
# Every run prints the destination it actually used, so a misdirected run is
# visible in its own output rather than silent.
REPO="${DEPLOY_BACKUP_REPO:-/home/domin/marveen}"
BACKUP_ROOT="${DEPLOY_BACKUP_ROOT:-/tmp/marveen-deploy-backups}"
RUN_GATE=1
GATE_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || { echo "usage error: --target needs a ref" >&2; exit 2; }
      GATE_ARGS+=(--target "$2"); shift 2 ;;
    --no-gate) RUN_GATE=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "usage error: unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$REPO" || { echo "cannot cd $REPO" >&2; exit 2; }

[ -f dist/index.js ] || { echo "BACKUP ERROR: dist/index.js missing -- nothing to back up" >&2; exit 2; }

TIP_FILE="store/.deployed-tip"
[ -r "$TIP_FILE" ] || { echo "BACKUP ERROR: $TIP_FILE missing -- cannot label the backup" >&2; exit 2; }
TIP=$(tr -d '[:space:]' < "$TIP_FILE")
[ -n "$TIP" ] || { echo "BACKUP ERROR: $TIP_FILE is empty" >&2; exit 2; }
git cat-file -e "${TIP}^{commit}" 2>/dev/null || {
  echo "BACKUP ERROR: ${TIP:0:8} from $TIP_FILE is not a commit in this repo" >&2; exit 2; }

# The label is only meaningful if the dist being copied really was built from
# the tip named in store/.deployed-tip. Nothing ties those two together, so if
# the operator builds BEFORE taking the backup -- step 1 before step 0 -- this
# would stamp the NEW build with the OLD sha and produce a rollback point that
# restores the build you are rolling back FROM, reported with the gate's most
# reassuring message (devil-advocate DA-23). The author made exactly that
# ordering mistake earlier on 2026-08-04.
#
# Measured on dist/ itself, not on HEAD. The first version compared HEAD to the
# deployed tip, which is a correlate rather than the object: the documented build
# path is an ISOLATED WORKTREE precisely so the main tree's HEAD does NOT move
# (fleet-deploy-verify SKILL.md, "do NOT checkout develop / reset --hard in the
# main tree"). Under that procedure HEAD says nothing about dist/, and a main tree
# legitimately parked on another agent's feature branch would have deadlocked this
# script -- the same unsatisfiable-condition shape this change set exists to
# remove (thor N11).
#
# The ordering invariant that does hold: update-deployed-tip.sh runs at the END of
# a deploy (skill step 6b), after dist/ is in place, so on a settled system the
# marker is newer than every file in dist/. A build -- in the main tree or rsynced
# in from a worktree, which preserves the build's mtimes -- makes dist/ newer than
# the marker. That is exactly the "you already built" state this must refuse.
#
# Residual, stated rather than papered over: copying in a build whose files are
# OLDER than the marker would still pass. A build stamp inside dist/ is the only
# thing that closes it for real (card 90406db5).
TIP_MTIME=$(stat -c %Y "$TIP_FILE" 2>/dev/null || echo "")
DIST_NEWEST=$(find dist -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1)
if [ -z "$TIP_MTIME" ] || [ -z "$DIST_NEWEST" ]; then
  echo "BACKUP ERROR: cannot read the mtime of $TIP_FILE or of dist/ -- cannot establish that" >&2
  echo "  dist/ is still the ${TIP:0:8} build, and an unverified label is worse than none." >&2
  exit 2
fi
if [ "$DIST_NEWEST" -gt "$TIP_MTIME" ]; then
  echo "BACKUP ERROR: dist/ was written $(( (DIST_NEWEST - TIP_MTIME) / 60 )) minute(s) AFTER store/.deployed-tip was last updated." >&2
  echo "  dist/ is therefore not provably the ${TIP:0:8} build any more, and labelling it ${TIP:0:8}" >&2
  echo "  would create a rollback point to the build you are replacing." >&2
  echo "  Take the backup BEFORE building (skill step 0, then step 1)." >&2
  # If the previous deploy left a labelled rollback point, the bytes are not lost
  # -- say so, because "you already built" otherwise reads as an unrecoverable dead end.
  prev=$(ls -1d "$BACKUP_ROOT"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null | tail -1)
  if [ -n "$prev" ] && [ -r "$prev/deployed-sha.txt" ] \
     && [ "$(tr -d '[:space:]' < "$prev/deployed-sha.txt")" = "$TIP" ]; then
    echo "  The previous rollback point $prev already holds ${TIP:0:8} -- verify it and use it." >&2
  fi
  exit 2
fi

# Two runs in the same second would otherwise share a directory and merge into
# each other. The name must stay exactly YYYYmmdd-HHMMSS -- rollback.sh's
# auto-pick glob has no room for a suffix -- so wait for the next second rather
# than decorate the name (thor N10).
DEST="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
while [ -e "$DEST" ]; do
  sleep 1
  DEST="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
done
mkdir -p "$DEST" || { echo "BACKUP ERROR: cannot create $DEST" >&2; exit 2; }

# Trailing slash on the source: the CONTENTS go in flat, because that is what
# rollback.sh rsyncs back out. Keep these two in step.
rsync -a dist/ "$DEST/" || { echo "BACKUP ERROR: rsync failed" >&2; exit 2; }
printf '%s\n' "$TIP" > "$DEST/deployed-sha.txt"

# Assert the layout rather than trusting it -- this is the invariant rollback.sh
# depends on, and it is cheap to prove.
[ -f "$DEST/index.js" ] || {
  echo "BACKUP ERROR: $DEST has no top-level index.js -- rollback.sh would restore an unusable tree" >&2
  exit 2; }

echo "rollback point: $DEST"
echo "  build        : ${TIP:0:8}"
echo "  size         : $(du -sh "$DEST" | cut -f1)"

# Reported, not pruned. Deleting rollback points is a destructive act on
# break-glass artifacts this script did not create, and 29 of the existing ones
# are the unusable nested-layout kind that OPS-098 has to triage anyway -- doing
# it silently here would hide that work rather than finish it (thor N9).
n_backups=$(ls -1d "$BACKUP_ROOT"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null | wc -l)
if [ "$n_backups" -gt 30 ]; then
  echo "  NOTE         : $n_backups rollback points under $BACKUP_ROOT ($(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)). Retention + nested-layout triage is card OPS-098."
fi
echo

if [ "$RUN_GATE" -eq 0 ]; then
  echo "gate skipped (--no-gate) -- run scripts/deploy-preflight-unifier.sh before requesting GO"
  exit 0
fi

exec bash "$SCRIPT_DIR/deploy-preflight-unifier.sh" ${GATE_ARGS[@]+"${GATE_ARGS[@]}"}
