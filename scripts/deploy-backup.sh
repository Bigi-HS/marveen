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

REPO="/home/domin/marveen"
BACKUP_ROOT="/tmp/marveen-deploy-backups"
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

DEST="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
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
echo

if [ "$RUN_GATE" -eq 0 ]; then
  echo "gate skipped (--no-gate) -- run scripts/deploy-preflight-unifier.sh before requesting GO"
  exit 0
fi

exec bash "$SCRIPT_DIR/deploy-preflight-unifier.sh" ${GATE_ARGS[@]+"${GATE_ARGS[@]}"}
