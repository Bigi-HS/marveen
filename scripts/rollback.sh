#!/usr/bin/env bash
# One-command dist rollback for Armorer. Restores a backup dist, restarts the
# dashboard server, and runs /api/gate/verify automatically.
#
# Usage:
#   scripts/rollback.sh                         -- restores the most recent timestamped backup
#   scripts/rollback.sh /tmp/marveen-deploy-backups/20260729-182403  -- specific backup
#   scripts/rollback.sh --check <dir>           -- classify one backup, change nothing
#   scripts/rollback.sh --audit                 -- classify every backup, change nothing
#   scripts/rollback.sh --unlabelled <dir>      -- restore a backup with no deployed-sha.txt
#
# Exit 0 = rollback + verify green.
# Exit 1 = rollback done but verify not fully green -- escalate.
# Exit 2 = fatal (no backup found, unusable backup layout, server won't start).
#
# --- Why the layout gate exists (card OPS-098; found by the Devil's Advocate
# --- during the PR#462 review as DA-13) --------------------------------------
# The restore below is `rsync -a --delete "$BACKUP_DIR/" "$REPO/dist/"`, which
# assumes the backup dir holds the dist contents FLAT. Measured 2026-08-04 across
# the 44 timestamped dirs actually present:
#
#   17 flat        index.js at the top level -- restores correctly
#   22 nested      the dist sits in a dist/ subdir, so --delete wipes the live
#                  build and leaves $REPO/dist/dist/: an unusable tree, with the
#                  running build already gone
#    5 other       dist-prev/, dist-live/, dist-live-<sha>/, one dir holding BOTH
#                  dist/ and dashboard-new-dist/, and -- worst -- one that is
#                  EMPTY (20260611-102113)
#
# The empty one matters most and was not in the original report: it is a plain
# timestamped directory, so the auto-pick glob is willing to choose it, and
# restoring from it deletes every file in dist/ and puts nothing back. It fails
# in complete silence. A break-glass tool that can destroy the running build at
# the exact moment it is reached for is worse than no tool, because it is reached
# for under pressure and trusted by default.
#
# So: classify BEFORE anything touches dist, refuse anything that is not flat,
# and name the exact command that would work instead. Nested dirs are neither
# repaired nor deleted here -- their inner dist/ IS a flat backup, so the refusal
# points at it and the operator gets a working restore one command later.
# Deleting break-glass artifacts this script did not create is a separate,
# deliberate decision, not a side effect of a bug fix.

set -euo pipefail

# Overridable only so the regression test can point at fixture trees; both
# default to the live paths and nothing in the deploy procedure sets them.
REPO="${ROLLBACK_REPO:-/home/domin/marveen}"
BACKUP_ROOT="${ROLLBACK_BACKUP_ROOT:-/tmp/marveen-deploy-backups}"

# classify <dir> -> "<class>\t<detail>"
#   flat    usable as-is
#   nested  the dist is one level down; detail is the usable path
#   empty   nothing to restore -- restoring would delete the live build
#   other   a layout this script cannot interpret; detail lists what is there
classify() {
  local d="$1"
  if [[ -f "$d/index.js" ]]; then
    printf 'flat\t%s\n' "$d"
  elif [[ -z "$(ls -A "$d" 2>/dev/null)" ]]; then
    printf 'empty\t-\n'
  elif [[ -f "$d/dist/index.js" ]]; then
    printf 'nested\t%s\n' "$d/dist"
  else
    printf 'other\t%s\n' "$(ls -1A "$d" 2>/dev/null | tr '\n' ' ')"
  fi
}

label_of() {    # echoes the sha in deployed-sha.txt, or nothing
  if [[ -r "$1/deployed-sha.txt" ]]; then tr -d '[:space:]' < "$1/deployed-sha.txt"; fi
}

all_backups() {
  ls -1d "$BACKUP_ROOT"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null | sort
}

# --- audit mode: read-only, safe to run at any time ---------------------------
if [[ "${1:-}" == "--audit" ]]; then
  echo "backup layout audit: $BACKUP_ROOT"
  n_ok=0; n_bad=0
  while read -r d; do
    [[ -n "$d" ]] || continue
    IFS=$'\t' read -r cls detail <<< "$(classify "$d")"
    sha=$(label_of "$d"); sha="${sha:0:8}"
    case "$cls" in
      flat)   n_ok=$((n_ok + 1));   printf '  USABLE     %s  %s\n' "$(basename "$d")" "${sha:-(unlabelled)}" ;;
      nested) n_bad=$((n_bad + 1)); printf '  NOT USABLE %s  %s  nested -- restore from %s instead\n' "$(basename "$d")" "${sha:-(unlabelled)}" "$detail" ;;
      empty)  n_bad=$((n_bad + 1)); printf '  DANGEROUS  %s  EMPTY -- restoring from it deletes the live dist and puts nothing back\n' "$(basename "$d")" ;;
      *)      n_bad=$((n_bad + 1)); printf '  NOT USABLE %s  unrecognised layout: %s\n' "$(basename "$d")" "$detail" ;;
    esac
  done <<< "$(all_backups)"
  echo "  -- $n_ok usable, $n_bad not usable as-is"
  exit 0
fi

CHECK_ONLY=0
ALLOW_UNLABELLED=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --check)      CHECK_ONLY=1; shift ;;
    --unlabelled) ALLOW_UNLABELLED=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# --- locate backup dir ---
if [[ -n "${1:-}" ]]; then
  BACKUP_DIR="$1"
else
  # Most recent YYYYMMDD-HHMMSS timestamped dir (not symbolic dirs like last-prev-tip.txt)
  BACKUP_DIR=$(all_backups | tail -1)
fi

if [[ -z "${BACKUP_DIR:-}" || ! -d "$BACKUP_DIR" ]]; then
  echo "ROLLBACK ERROR: no valid backup dir found (checked: ${BACKUP_DIR:-$BACKUP_ROOT})" >&2
  exit 2
fi
BACKUP_DIR="${BACKUP_DIR%/}"

# --- layout gate: runs BEFORE anything touches dist ---------------------------
IFS=$'\t' read -r CLASS DETAIL <<< "$(classify "$BACKUP_DIR")"
case "$CLASS" in
  flat) ;;
  nested)
    echo "ROLLBACK ERROR: $BACKUP_DIR holds the dist one level down, in dist/." >&2
    echo "  Restoring from it as-is would rsync --delete the live build away and leave" >&2
    echo "  $REPO/dist/dist/ -- an unusable tree, with the running build already gone." >&2
    echo "  The inner directory IS a flat backup. Run instead:" >&2
    echo "    bash scripts/rollback.sh $DETAIL" >&2
    exit 2 ;;
  empty)
    echo "ROLLBACK ERROR: $BACKUP_DIR is EMPTY." >&2
    echo "  Restoring from it would delete every file in $REPO/dist/ and put nothing back." >&2
    echo "  Pick another backup: 'bash scripts/rollback.sh --audit' lists the usable ones." >&2
    exit 2 ;;
  *)
    echo "ROLLBACK ERROR: $BACKUP_DIR has no top-level index.js and no dist/index.js." >&2
    echo "  Contents: $DETAIL" >&2
    echo "  This script cannot tell which of those is the dist, and guessing wrong deletes the" >&2
    echo "  live build. Point it at the directory that holds index.js directly." >&2
    exit 2 ;;
esac

# A backup with no deployed-sha.txt can be restored, but the resulting live build
# cannot be named: store/.deployed-tip is then left naming the build that was just
# replaced, and every later delta check reads from a wrong baseline. That used to
# surface only as a WARNING near the end of this script -- after the restart, too
# late to reconsider. Make it a decision taken up front instead.
BACKUP_SHA=$(label_of "$BACKUP_DIR")
if [[ -z "$BACKUP_SHA" && "$ALLOW_UNLABELLED" -eq 0 ]]; then
  echo "ROLLBACK ERROR: $BACKUP_DIR has no deployed-sha.txt, so the build it holds is unknown." >&2
  echo "  Restoring it would leave store/.deployed-tip naming the build you are rolling back FROM," >&2
  echo "  and deploy-delta-check.py would then compute the delta from the wrong baseline." >&2
  echo "  If that is acceptable right now, re-run with:" >&2
  echo "    bash scripts/rollback.sh --unlabelled $BACKUP_DIR" >&2
  echo "  and set store/.deployed-tip by hand once the correct sha is known." >&2
  exit 2
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "USABLE: $BACKUP_DIR (flat layout, build ${BACKUP_SHA:-unlabelled})"
  exit 0
fi

echo "=== ROLLBACK starting ==="
echo "Backup source : $BACKUP_DIR"
echo "Build         : ${BACKUP_SHA:-UNLABELLED (acknowledged with --unlabelled)}"
echo "Restoring to  : $REPO/dist/"

# --- write planned-restart marker so supervisor sentinel stays quiet ---
touch "$REPO/store/planned-restart.marker"

# --- restore dist (the layout gate above proved the dist contents are here
# --- directly, not under a dist/ subdir; --delete makes that load-bearing) ---
rsync -a --delete "$BACKUP_DIR/" "$REPO/dist/"
echo "dist restored"

# The restore is the point of no return for the previous live build, so prove it
# landed rather than assuming rsync's exit code covers it.
[[ -f "$REPO/dist/index.js" ]] || {
  echo "ROLLBACK ERROR: $REPO/dist/index.js is missing after the restore -- the live build is GONE." >&2
  echo "  Do NOT restart. Restore from another backup ('rollback.sh --audit') or rebuild." >&2
  rm -f "$REPO/store/planned-restart.marker"
  exit 2; }

# --- restart server ---
PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node)"
TMUXB="$(command -v tmux)"

env -u TMUX "$TMUXB" kill-session -t marveen 2>/dev/null || true
sleep 2
env -u TMUX "$TMUXB" new-session -d -s marveen -c "$REPO" \
  "export PATH=\"$PATH_CURATED\" && exec $NODE dist/index.js"
echo "server session restarted"

# --- wait for server up (up to 40s) ---
UP=0
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3420/api/health 2>/dev/null || echo "000")
  if [[ "$STATUS" == "200" || "$STATUS" == "401" ]]; then
    echo "server up (HTTP $STATUS) after ~$((i * 2))s"
    UP=1
    break
  fi
  sleep 2
done

if [[ "$UP" -ne 1 ]]; then
  echo "ROLLBACK ERROR: server did not respond within 40s" >&2
  rm -f "$REPO/store/planned-restart.marker"
  exit 2
fi

# --- 4-point verify via gate/verify ---
TOKEN=$(cat "$REPO/store/.dashboard-token")
VERIFY_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/gate/verify 2>/dev/null)
PASS=$(echo "$VERIFY_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(str(d.get('pass',False)).lower())" 2>/dev/null || echo "error")

echo ""
echo "gate/verify result:"
echo "$VERIFY_JSON" | python3 -m json.tool 2>/dev/null || echo "$VERIFY_JSON"
echo ""

if [[ "$PASS" == "true" ]]; then
  rm -f "$REPO/store/planned-restart.marker"
  # Update deployed-tip only if we know the exact rollback SHA.
  # NEVER call update-deployed-tip.sh with no args here: that would record
  # origin/develop HEAD instead of the actual restored dist's SHA (bug fix 2026-07-30).
  #
  # An unlabelled backup can only get here via --unlabelled, so the stale marker
  # below is an accepted consequence rather than a surprise -- but it still has to
  # be said out loud, because this is the last line the operator reads.
  if [[ -n "$BACKUP_SHA" ]]; then
    bash "$REPO/scripts/update-deployed-tip.sh" "$BACKUP_SHA" && \
      echo "deployed-tip updated to rollback SHA: $BACKUP_SHA" || true
  else
    echo "WARNING: this backup was unlabelled, so deployed-tip was NOT updated."
    echo "store/.deployed-tip still names the build you just rolled BACK FROM."
    echo "Set it once the restored sha is known: bash scripts/update-deployed-tip.sh <rollback-sha>"
  fi
  echo "=== ROLLBACK COMPLETE: verify GREEN ==="
  exit 0
else
  rm -f "$REPO/store/planned-restart.marker"
  echo "=== ROLLBACK WARNING: verify NOT fully green -- escalate to Genesis ==="
  exit 1
fi
