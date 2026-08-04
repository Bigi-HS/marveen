#!/usr/bin/env bash
# deploy-preflight-unifier.sh -- single pre-GO gate for the Armorer deploy checklist.
#
# Card: OPS-072 (5fd2fdbc). Chains the checks that must all pass BEFORE asking
# Genesis for a live-deploy GO, so the GO request carries one verdict instead of
# five half-remembered ones.
#
#   C1  delta risk + hook presence   (scripts/deploy-delta-check.py)
#   C2  deployed-tip freshness       (store/.deployed-tip readable, is an ancestor
#                                     of the target, and actually behind it)
#   C3  rollback backup present      (a store/dist-backup-* matching the CURRENT
#                                     deployed tip, not just any old backup)
#   C4  build artifact sane          (dist/index.js exists and is newer than the
#                                     newest tracked source file)
#   C5  running supervisor is fresh  (the live fleet-supervisor process is NOT
#                                     executing a deleted inode)
#
# C5 exists because of the 2026-08-04 finding: the running supervisor (PID 13327,
# up since 07-26) held a DELETED inode of scripts/fleet-supervisor.sh, so three
# merged+deployed supervisor changes (OPS-079 ghost-monitor, OPS-076 liveness
# timeout, OPS-080 n8n env hardening) were live on disk but INERT in the process.
# The 4-point verify inspects the dashboard and dist -- it never looked at the
# supervisor -- so "deployed" read as done when nothing had changed. Shell-file
# deploys need a process restart, and this check is what makes that visible.
#
# Usage:  scripts/deploy-preflight-unifier.sh [--target <ref>]
# Exit 0 = ALL PASS, safe to request GO.
# Exit 1 = at least one check FAILED -- do NOT request GO until resolved.
# Exit 2 = the script could not run a check (missing tool / repo problem).
#
# WARN lines never fail the run on their own; they are surfaced so the GO request
# can mention them.

set -uo pipefail

REPO="/home/domin/marveen"
TARGET="origin/develop"

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target needs a ref}"; shift 2 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$REPO" || { echo "cannot cd $REPO" >&2; exit 2; }

FAILED=0
WARNED=0
NOTHING_TO_DEPLOY=0
RESULTS=()

pass() { RESULTS+=("PASS  $1"); }
fail() { RESULTS+=("FAIL  $1"); FAILED=$((FAILED + 1)); }
warn() { RESULTS+=("WARN  $1"); WARNED=$((WARNED + 1)); }

echo "=== deploy preflight (target: $TARGET) ==="
echo

# --- C1: delta risk classification + hook presence -------------------------
echo "--- C1: delta risk + hook presence ---"
if [ ! -f scripts/deploy-delta-check.py ]; then
  fail "C1 delta-check: scripts/deploy-delta-check.py missing"
else
  delta_out=$(python3 scripts/deploy-delta-check.py --target "$TARGET" 2>&1)
  delta_rc=$?
  echo "$delta_out"
  if echo "$delta_out" | grep -q "Hook-presence: OK"; then
    pass "C1a hook-presence: all referenced hook scripts present"
  else
    fail "C1a hook-presence: missing hook scripts (see above)"
  fi
  if echo "$delta_out" | grep -qE "SUMMARY:.*[1-9][0-9]* HIGH"; then
    # HIGH is not automatically a blocker -- it means a human must sign off on
    # the risk surface. Surfaced as WARN so the GO request quotes it explicitly.
    high_line=$(echo "$delta_out" | grep -E "^SUMMARY:" | head -1)
    warn "C1b delta-risk: $high_line -- name each HIGH PR in the GO request"
  elif [ "$delta_rc" -eq 0 ]; then
    pass "C1b delta-risk: no HIGH-risk PRs in the delta"
  else
    fail "C1b delta-check exited $delta_rc"
  fi
fi
echo

# --- C2: deployed-tip freshness --------------------------------------------
echo "--- C2: deployed-tip freshness ---"
TIP_FILE="store/.deployed-tip"
DEPLOYED_TIP=""
if [ ! -r "$TIP_FILE" ]; then
  fail "C2 deployed-tip: $TIP_FILE missing or unreadable"
else
  DEPLOYED_TIP=$(tr -d '[:space:]' < "$TIP_FILE")
  if [ -z "$DEPLOYED_TIP" ]; then
    fail "C2 deployed-tip: $TIP_FILE is empty"
  elif ! git cat-file -e "${DEPLOYED_TIP}^{commit}" 2>/dev/null; then
    fail "C2 deployed-tip: ${DEPLOYED_TIP:0:8} is not a commit in this repo"
  else
    target_sha=$(git rev-parse "$TARGET" 2>/dev/null)
    if [ -z "$target_sha" ]; then
      fail "C2 deployed-tip: cannot resolve target $TARGET"
    elif [ "$DEPLOYED_TIP" = "$target_sha" ]; then
      NOTHING_TO_DEPLOY=1
      warn "C2 deployed-tip: already at $TARGET (${target_sha:0:8}) -- nothing to deploy"
    elif git merge-base --is-ancestor "$DEPLOYED_TIP" "$target_sha" 2>/dev/null; then
      behind=$(git rev-list --count "${DEPLOYED_TIP}..${target_sha}")
      pass "C2 deployed-tip: ${DEPLOYED_TIP:0:8} is $behind commit(s) behind $TARGET -- clean fast-forward"
    else
      fail "C2 deployed-tip: ${DEPLOYED_TIP:0:8} is NOT an ancestor of $TARGET -- live is on a divergent branch"
    fi
  fi
fi
echo

# --- C3: rollback backup for the CURRENT deployed tip ----------------------
#
# Pre-GO, the deployed tip is the build that is currently live, so the rollback
# point must match it. Once a deploy has completed the tip is advanced to the new
# build and the newest backup legitimately carries the PREVIOUS tip -- which is
# exactly the right rollback point. Failing there would be a false alarm, so C3
# is skipped whenever C2 already reported that there is nothing to deploy.
echo "--- C3: rollback backup ---"
if [ "$NOTHING_TO_DEPLOY" -eq 1 ]; then
  RESULTS+=("SKIP  C3 backup: nothing to deploy (C2) -- the newest backup carries the previous tip by design")
elif [ -z "$DEPLOYED_TIP" ]; then
  fail "C3 backup: skipped, deployed tip unknown (C2 failed)"
else
  short_tip="${DEPLOYED_TIP:0:7}"
  # Convention: store/dist-backup-<YYYYmmdd>-<HHMMSS>-<short-tip>
  match=$(ls -d store/dist-backup-*-"$short_tip" 2>/dev/null | tail -1)
  if [ -n "$match" ] && [ -f "$match/index.js" ]; then
    pass "C3 backup: $match matches deployed tip $short_tip and contains index.js"
  else
    any=$(ls -d store/dist-backup-* 2>/dev/null | tail -1)
    if [ -n "$any" ]; then
      fail "C3 backup: no backup tagged with the CURRENT tip $short_tip (newest is $any) -- rollback would restore the wrong build"
    else
      fail "C3 backup: no store/dist-backup-* directory at all -- there is no rollback point"
    fi
  fi
fi
echo

# --- C4: build artifact sanity ---------------------------------------------
echo "--- C4: build artifact ---"
if [ ! -f dist/index.js ]; then
  fail "C4 dist: dist/index.js missing -- run npm run build"
else
  newest_src=$(git ls-files -z 'src/**/*.ts' 'src/*.ts' 2>/dev/null \
    | xargs -0 -r ls -t 2>/dev/null | head -1)
  if [ -n "$newest_src" ] && [ "$newest_src" -nt dist/index.js ]; then
    fail "C4 dist: $newest_src is newer than dist/index.js -- build is stale"
  else
    pass "C4 dist: dist/index.js present and not older than tracked sources"
  fi
fi
echo

# --- C5: running supervisor is executing the on-disk script ----------------
echo "--- C5: running supervisor freshness ---"
sup_pid=$(pgrep -f "bash .*fleet-supervisor\.sh" 2>/dev/null | head -1)
if [ -z "$sup_pid" ]; then
  warn "C5 supervisor: no running fleet-supervisor process found"
else
  sup_link=$(readlink "/proc/$sup_pid/fd/255" 2>/dev/null)
  if [ -z "$sup_link" ]; then
    warn "C5 supervisor: PID $sup_pid running, but fd/255 unreadable -- cannot verify inode"
  elif [ "${sup_link% (deleted)}" != "$sup_link" ]; then
    fail "C5 supervisor: PID $sup_pid is executing a DELETED inode ($sup_link) -- every scripts/fleet-supervisor.sh change is INERT until the supervisor restarts"
  else
    disk_ino=$(stat -c %i scripts/fleet-supervisor.sh 2>/dev/null)
    run_ino=$(stat -Lc %i "/proc/$sup_pid/fd/255" 2>/dev/null)
    if [ -n "$disk_ino" ] && [ "$disk_ino" = "$run_ino" ]; then
      pass "C5 supervisor: PID $sup_pid is executing the current on-disk script (inode $disk_ino)"
    else
      fail "C5 supervisor: PID $sup_pid inode $run_ino != on-disk inode $disk_ino -- supervisor changes are INERT until restart"
    fi
  fi
fi
echo

# --- verdict ---------------------------------------------------------------
echo "=== PREFLIGHT RESULT ==="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo
if [ "$FAILED" -gt 0 ]; then
  echo "VERDICT: BLOCKED -- $FAILED check(s) failed, $WARNED warning(s). Do NOT request GO."
  exit 1
fi
if [ "$WARNED" -gt 0 ]; then
  echo "VERDICT: PASS with $WARNED warning(s). Safe to request GO -- quote the warnings in the request."
else
  echo "VERDICT: PASS -- all checks clean. Safe to request GO."
fi
exit 0
