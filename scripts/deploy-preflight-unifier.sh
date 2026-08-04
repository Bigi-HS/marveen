#!/usr/bin/env bash
# deploy-preflight-unifier.sh -- single pre-GO gate for the Armorer deploy checklist.
#
# Card: OPS-072 (5fd2fdbc). Chains the checks that must all pass BEFORE asking
# Genesis for a live-deploy GO, so the GO request carries one verdict instead of
# five half-remembered ones.
#
#   C1  delta risk + hook presence  (scripts/deploy-delta-check.py)
#   C2  deployed-tip freshness      (+ warns when origin/ refs are stale)
#   C3  rollback point              (what scripts/rollback.sh would ACTUALLY restore)
#   C4  build artifact sanity       (dist newer than the last src commit)
#   C5  running-process freshness   (every repo shell process runs current code)
#
# Usage:  scripts/deploy-preflight-unifier.sh [--target <ref>]
# Exit 0 = all checks clean or warning-only, safe to request GO.
# Exit 1 = at least one check FAILED -- do NOT request GO until resolved.
# Exit 2 = usage error / a check could not run.
#
# Normally you do not call this directly: scripts/deploy-backup.sh creates the
# rollback point C3 checks for and then runs this gate, so the whole pre-GO
# sequence is one command. Running it alone is fine for a read-only look.
#
# --- Why C5 sweeps every process, not just the supervisor -------------------
# Origin (2026-08-04): the running fleet-supervisor held a DELETED inode of its
# own script since 07-26, so three merged+deployed supervisor changes (OPS-079,
# OPS-076, OPS-080) were live on disk but inert in the process. The 4-point
# verify inspects the dashboard and dist and never looked at any running process.
#
# A first version of this check looked at one supervisor via `pgrep | head -1`.
# Review (thor, devil-advocate) showed that was wrong twice over: `head -1` picks
# an arbitrary match so a stale duplicate hides behind a healthy one, and a /proc
# sweep found 27 stale processes -- 26 watchdogs plus the supervisor -- not one.
# So the check enumerates /proc directly and flags every offender.
#
# --- Why staleness is measured by CONTENT, not inode ------------------------
# Inode identity is wrong in both directions. A `git checkout` that restores a
# byte-identical file mints a new inode and would report a false FAIL; that is
# not hypothetical, it happened here at 03:18 while branch-switching in the live
# tree. Conversely a truncate-and-rewrite preserves the inode while the running
# bash still executes its already-parsed content.
#
# So the primary signal is a direct comparison of /proc/PID/fd/255 (readable even
# when the inode is unlinked) against the file on disk. That is the actual
# invariant: the code the process is running IS the code on disk. Where the
# content matches but the file was modified after the process started, bash may
# have parsed an intermediate version -- reported as a warning, since it can be
# neither confirmed nor cleared from outside.

set -uo pipefail

# Resolved BEFORE the cd below: $0 may be a relative path, and once the working
# directory changes it no longer points anywhere useful.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO="/home/domin/marveen"
TARGET="origin/develop"
FETCH_STALE_SECONDS=900     # 15 min -- older origin/ refs make C1/C2 falsely calm

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || { echo "usage error: --target needs a ref" >&2; exit 2; }
      TARGET="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "usage error: unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$REPO" || { echo "cannot cd $REPO" >&2; exit 2; }

FAILED=0
WARNED=0
RESULTS=()

pass() { RESULTS+=("PASS  $1"); }
fail() { RESULTS+=("FAIL  $1"); FAILED=$((FAILED + 1)); }
warn() { RESULTS+=("WARN  $1"); WARNED=$((WARNED + 1)); }
# NOTE is for a standing limitation that no run can clear. It is deliberately
# not a WARN: a warning that fires on every single run spends the channel, and
# the reader can no longer tell "clean" from "clean except one real thing"
# (thor N3).
note() { RESULTS+=("NOTE  $1"); }

echo "=== deploy preflight (target: $TARGET) ==="
echo

# --- C1: delta risk classification + hook presence -------------------------
# deploy-delta-check.py documents exit 1 = BLOCK on a HIGH-risk delta. This gate
# deliberately downgrades that to a warning: HIGH means a human must sign off on
# the risk surface, and auto-blocking every supervisor change would train people
# to skip the gate. That override is PRINTED rather than applied silently, so a
# reader is never told "safe to request GO" without learning the upstream tool
# said BLOCK. The exit code is the contract; the printed summary is only quoted.
echo "--- C1: delta risk + hook presence ---"
if [ ! -f scripts/deploy-delta-check.py ]; then
  fail "C1 delta-check: scripts/deploy-delta-check.py missing"
else
  delta_out=$(python3 scripts/deploy-delta-check.py --target "$TARGET" 2>&1)
  delta_rc=$?
  echo "$delta_out"

  if echo "$delta_out" | grep -q "Hook-presence: OK"; then
    pass "C1a hook-presence: all referenced hook scripts present"
  elif echo "$delta_out" | grep -q "Hook-presence:"; then
    fail "C1a hook-presence: missing hook scripts (see above)"
  else
    fail "C1a hook-presence: delta-check produced no hook-presence line (rc=$delta_rc) -- treat as unknown, not OK"
  fi

  summary=$(echo "$delta_out" | grep -E "^SUMMARY:" | head -1)
  # deploy-delta-check.py prints no SUMMARY when the delta is empty, so fall
  # back to its "Delta:" line rather than reporting "no summary line", which
  # reads like something went wrong when nothing did.
  [ -n "$summary" ] || summary=$(echo "$delta_out" | grep -E "^Delta:" | head -1)
  if [ "$delta_rc" -eq 0 ]; then
    pass "C1b delta-risk: delta-check PASS -- ${summary:-no delta summary printed}"
  elif [ "$delta_rc" -eq 1 ] && echo "$summary" | grep -q "HIGH"; then
    # The ONLY downgrade this gate applies: a BLOCK that is specifically about a
    # HIGH-risk delta. Any other exit-1 (delta-check's own error paths) keeps its
    # blocking meaning -- narrowing the override to the case it was argued for.
    warn "C1b delta-risk: delta-check returned BLOCK on a HIGH delta; this gate downgrades that to WARN by policy -- named sign-off required per HIGH PR. Upstream said: $summary"
  elif [ "$delta_rc" -eq 1 ]; then
    fail "C1b delta-check exited 1 but not for a HIGH delta -- it failed for another reason, which this gate does NOT downgrade. Output: ${summary:-<no summary line>}"
  else
    fail "C1b delta-check exited $delta_rc (neither PASS nor BLOCK) -- cannot classify the delta"
  fi
fi
echo

# --- C2: deployed-tip freshness --------------------------------------------
echo "--- C2: deployed-tip freshness ---"
# A stale origin/ ref makes both "0 PRs in the delta" and "already at target"
# falsely reassuring, so surface it before reading either.
# Ask the remote what the target ref actually is, rather than timing the last
# fetch. .git/FETCH_HEAD's mtime moves on ANY fetch: fetching refs/pull/462/head
# during a review -- which both the author and the reviewer do -- marked
# origin/develop "fresh" while leaving it untouched (thor F3, reproduced N2).
# One ls-remote is cheaper than that false green and answers the real question.
if [[ "$TARGET" =~ ^origin/(.+)$ ]]; then
  branch="${BASH_REMATCH[1]}"
  remote_sha=$(git ls-remote --heads origin "$branch" 2>/dev/null | awk 'NR==1 {print $1}')
  local_sha=$(git rev-parse "$TARGET" 2>/dev/null)
  if [ -z "$remote_sha" ]; then
    # Consistent with C5b: a claim that could not be checked is not a clean one.
    fail "C2a target-freshness: cannot reach origin to confirm $branch -- the target ref is UNVERIFIED, so C1's delta range may be wrong. Retry when the remote is reachable."
  elif [ "$remote_sha" = "$local_sha" ]; then
    pass "C2a target-freshness: $TARGET (${local_sha:0:8}) matches origin -- delta range is computed against the real head"
  else
    fail "C2a target-freshness: $TARGET is ${local_sha:0:8} locally but ${remote_sha:0:8} on origin -- run: git fetch origin $branch"
  fi
else
  warn "C2a target-freshness: target '$TARGET' is not an origin/<branch> ref, so its currency cannot be checked against the remote"
fi

TIP_FILE="store/.deployed-tip"
DEPLOYED_TIP=""
if [ ! -r "$TIP_FILE" ]; then
  fail "C2b deployed-tip: $TIP_FILE missing or unreadable"
else
  DEPLOYED_TIP=$(tr -d '[:space:]' < "$TIP_FILE")
  if [ -z "$DEPLOYED_TIP" ]; then
    fail "C2b deployed-tip: $TIP_FILE is empty"
  elif ! git cat-file -e "${DEPLOYED_TIP}^{commit}" 2>/dev/null; then
    fail "C2b deployed-tip: ${DEPLOYED_TIP:0:8} is not a commit in this repo"
  else
    target_sha=$(git rev-parse "$TARGET" 2>/dev/null)
    if [ -z "$target_sha" ]; then
      fail "C2b deployed-tip: cannot resolve target $TARGET"
    elif [ "$DEPLOYED_TIP" = "$target_sha" ]; then
      warn "C2b deployed-tip: already at $TARGET (${target_sha:0:8}) -- nothing to deploy"
    elif git merge-base --is-ancestor "$DEPLOYED_TIP" "$target_sha" 2>/dev/null; then
      behind=$(git rev-list --count "${DEPLOYED_TIP}..${target_sha}")
      pass "C2b deployed-tip: ${DEPLOYED_TIP:0:8} is $behind commit(s) behind $TARGET -- clean fast-forward"
    else
      fail "C2b deployed-tip: ${DEPLOYED_TIP:0:8} is NOT an ancestor of $TARGET -- live is on a divergent branch"
    fi
  fi
fi
echo

# --- C3: the rollback point scripts/rollback.sh would actually restore ------
#
# This check must interrogate the artifact the ROLLBACK TOOL would pick, not a
# naming convention of its own invention. An earlier version asserted a
# store/dist-backup-*-<tip> layout that nothing in the fleet produces, while
# rollback.sh auto-picks the newest YYYYmmdd-HHMMSS directory under
# /tmp/marveen-deploy-backups. Those two never intersect, so the check could go
# green while rollback.sh would have restored an unrelated, unlabelled build.
# Backups also belong OUTSIDE the working tree (fleet-deploy-verify SKILL.md):
# an in-tree backup dir gets scanned by vitest and mints phantom tests.
#
# Keep this glob in sync with scripts/rollback.sh's auto-pick.
ROLLBACK_ROOT="/tmp/marveen-deploy-backups"
BACKUP_CMD="bash scripts/deploy-backup.sh"
echo "--- C3: rollback point ---"
# No skip for the nothing-to-deploy case. That branch was the only one the
# author ever exercised, and it hid a check that could not pass on the other
# one (devil-advocate DA-11). Every run now takes the same path.
if [ -z "$DEPLOYED_TIP" ]; then
  fail "C3 rollback: cannot check, deployed tip unknown (C2b failed)"
else
  picked=$(ls -1d "$ROLLBACK_ROOT"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null | sort | tail -1)
  if [ -z "$picked" ]; then
    fail "C3 rollback: rollback.sh would find NO backup under $ROLLBACK_ROOT -- there is no rollback point. Run: $BACKUP_CMD"
  elif [ ! -f "$picked/index.js" ]; then
    fail "C3 rollback: rollback.sh would pick $picked but it has no top-level index.js -- restoring it would wipe the live dist (rsync --delete). Run: $BACKUP_CMD"
  elif [ ! -f "$picked/deployed-sha.txt" ]; then
    fail "C3 rollback: rollback.sh would pick $picked but it has NO deployed-sha.txt -- rollback cannot say which build it restores. Run: $BACKUP_CMD"
  else
    backup_sha=$(tr -d '[:space:]' < "$picked/deployed-sha.txt")
    if [ "$backup_sha" != "$DEPLOYED_TIP" ]; then
      # Equality is the right assertion ONLY because the rollback point is now
      # taken before this gate runs. Under the old GO-then-backup order the
      # newest backup was permanently one deploy behind and this could never go
      # green; the fix was to move the producer, not to weaken the check into
      # "some ancestor", which would happily accept a week-old build.
      behind=""
      if git cat-file -e "${backup_sha}^{commit}" 2>/dev/null \
         && git merge-base --is-ancestor "$backup_sha" "$DEPLOYED_TIP" 2>/dev/null; then
        behind=" ($(git rev-list --count "${backup_sha}..${DEPLOYED_TIP}") commit(s) behind live)"
      fi
      fail "C3 rollback: rollback.sh would restore ${backup_sha:0:8}${behind} but live is ${DEPLOYED_TIP:0:8} -- there is no rollback point for the build that is actually running. Run: $BACKUP_CMD"
    elif cmp -s "$picked/index.js" dist/index.js; then
      pass "C3 rollback: rollback.sh would restore $picked = live build ${DEPLOYED_TIP:0:8}, and it is byte-identical to the current dist"
    else
      # Not a failure: the documented order is backup-then-build, so once the new
      # artifact is built dist legitimately differs from the rollback point. Byte
      # identity is therefore corroboration when present, never the sole
      # assertion -- deployed-sha.txt is the only provenance record that survives
      # the build step.
      pass "C3 rollback: rollback.sh would restore $picked = live build ${DEPLOYED_TIP:0:8} (differs from current dist, expected after the new build)"
    fi
  fi
fi
echo

# --- C4: build artifact sanity ---------------------------------------------
#
# Compared against the COMMIT TIME of the last commit touching src/, not against
# source-file mtimes: a fresh checkout or an isolated worktree resets every
# source mtime and would make an mtime comparison cry "stale build" with no
# cause. Commit time is metadata and survives both.
#
# This proves recency, NOT provenance -- it cannot distinguish a dist built from
# $TARGET from one built off a parked branch, a failure the fleet has already hit
# (ENG-048, 08-01). Closing that needs a build stamp (the source SHA written into
# store/.dist-built-from at build time); until that exists the gap is stated
# rather than papered over.
echo "--- C4: build artifact ---"
if [ ! -f dist/index.js ]; then
  fail "C4 dist: dist/index.js missing -- run npm run build"
else
  last_src_commit=$(git log -1 --format=%ct -- src/ 2>/dev/null)
  dist_mtime=$(stat -c %Y dist/index.js 2>/dev/null)
  if [ -z "$last_src_commit" ] || [ -z "$dist_mtime" ]; then
    warn "C4 dist: cannot compare dist mtime with the last src commit -- unverified"
  elif [ "$dist_mtime" -lt "$last_src_commit" ]; then
    fail "C4 dist: dist/index.js predates the last src/ commit -- build is stale, run npm run build"
  else
    pass "C4 dist: dist/index.js is newer than the last src/ commit -- build is current"
    note "C4 dist: recency only. Provenance is unverifiable until a build stamp exists (store/.dist-built-from), so a dist built off a parked branch would still pass this check (ENG-048, 08-01)"
  fi
fi
echo

# --- C5: every long-running repo shell process runs current code -----------
echo "--- C5: running-process freshness ---"
# Resolved next to THIS script, not under $REPO: the two ship together, so a
# checkout that has the gate always has its detector. Looking it up under $REPO
# meant running the gate from a worktree or a review branch failed with rc=127
# even though the file was right there beside it. The sweep still scans $REPO,
# because the live tree is what gets deployed.
SWEEP="$SCRIPT_DIR/proc-freshness-sweep.py"
if [ ! -f "$SWEEP" ]; then
  # Distinguished from a crash on purpose: "the detector is not installed" and
  # "the detector blew up" need different responses, and rc=127 alone conflates
  # them (devil-advocate DA-17).
  fail "C5 process-freshness: detector missing at $SWEEP -- the gate cannot check running processes at all"
else
  c5_report=$(python3 "$SWEEP" "$REPO" 2>&1)
  c5_rc=$?
fi
if [ ! -f "$SWEEP" ]; then
  : # already reported above
elif [ "$c5_rc" -ne 0 ]; then
  fail "C5 process-freshness: sweep crashed (rc=$c5_rc) -- treat as unverified, not clean. Output: $(echo "$c5_report" | tail -2 | tr '\n' ' ')"
else
  echo "$c5_report" | grep -vE '^COUNT' | sed 's/^/  /'
  counts=$(echo "$c5_report" | grep '^COUNT' | head -1)
  n_stale=$(echo "$counts" | cut -f2)
  n_unknown=$(echo "$counts" | cut -f3)
  n_suspect=$(echo "$counts" | cut -f4)
  n_fresh=$(echo "$counts" | cut -f5)
  n_sup=$(echo "$counts" | cut -f6)

  # --- known backlog vs new staleness ---------------------------------------
  # On the day this gate was wired the sweep found 25 stale watchdogs, all of
  # them started before 08-01 and all of them triaged as scheduled hygiene with
  # no live functional regression (card ff114a06). Failing on that backlog would
  # make the gate red on its first real use for a reason the operator cannot fix
  # in the moment -- the surest way to teach the fleet to skip it, which is the
  # failure this whole PR is about.
  #
  # So the backlog is carved out explicitly, by process START TIME, and the
  # carve-out is dated: after GRACE_EXPIRES it stops applying and the backlog
  # fails like anything else. A carve-out without an expiry is how a known
  # exception becomes permanent silence.
  #
  # Anything started AFTER the cutoff is NEW staleness -- exactly what the check
  # is for -- and fails. The supervisor never gets the carve-out: it is the
  # process that deploys everything else.
  KNOWN_STALE_BEFORE="2026-08-01 00:00:00"
  GRACE_EXPIRES="2026-08-11"
  GRACE_CARD="ff114a06"
  cutoff_epoch=$(date -d "$KNOWN_STALE_BEFORE" +%s 2>/dev/null || echo 0)
  grace_active=1
  [ "$(date +%Y-%m-%d)" \< "$GRACE_EXPIRES" ] || grace_active=0

  n_new_stale=0; n_old_stale=0; sup_stale=0
  while IFS=$'\t' read -r label pid script why started; do
    [ "$label" = "STALE" ] || continue
    if [ "$script" = "fleet-supervisor.sh" ]; then sup_stale=$((sup_stale + 1)); continue; fi
    # An unreadable start time cannot prove the process predates the cutoff, so
    # it counts as new -- the carve-out has to fail closed like everything else.
    if [ "$grace_active" -eq 1 ] && [ -n "$started" ] && [ "$started" -lt "$cutoff_epoch" ]; then
      n_old_stale=$((n_old_stale + 1))
    else
      n_new_stale=$((n_new_stale + 1))
    fi
  done <<< "$c5_report"

  if [ "$sup_stale" -gt 0 ]; then
    fail "C5a supervisor-freshness: the running fleet-supervisor is executing code that no longer matches disk -- every supervisor change is INERT. This is never waived; restart it before deploying."
  fi
  if [ "$n_new_stale" -gt 0 ]; then
    if [ "$grace_active" -eq 1 ]; then
      fail "C5a process-freshness: $n_new_stale process(es) started after $KNOWN_STALE_BEFORE are running code that no longer matches disk -- this is NEW staleness, not the known backlog. Their deployed changes are INERT until restarted."
    else
      fail "C5a process-freshness: $n_new_stale process(es) running code that no longer matches disk. The $GRACE_CARD backlog grace expired on $GRACE_EXPIRES, so the pre-existing ones are no longer carved out."
    fi
  fi
  if [ "$n_old_stale" -gt 0 ]; then
    warn "C5a process-freshness: $n_old_stale pre-existing stale process(es) (started before $KNOWN_STALE_BEFORE) -- known backlog, staged restart tracked as card $GRACE_CARD. This carve-out EXPIRES $GRACE_EXPIRES and then fails."
  fi
  if [ "${n_stale:-0}" -eq 0 ]; then
    pass "C5a process-freshness: all $n_fresh repo shell process(es) run current on-disk code"
  fi
  # "Cannot tell" must never read as "fine" -- that fail-open was how the original
  # single-process check would have waved through its own first live run.
  if [ "${n_unknown:-0}" -gt 0 ]; then
    fail "C5b process-freshness: $n_unknown process(es) could not be verified -- unverified is not clean"
  fi
  if [ "${n_suspect:-0}" -gt 0 ]; then
    warn "C5c process-freshness: $n_suspect process(es) match on disk but their file changed after they started -- restart if the change was substantive"
  fi
  # A supervisor that is not running at all is a worse state than a stale one.
  if [ "${n_sup:-0}" -eq 0 ]; then
    fail "C5d supervisor: NO fleet-supervisor process is running -- nothing is keeping the fleet up"
  elif [ "${n_sup:-0}" -gt 1 ]; then
    warn "C5d supervisor: $n_sup fleet-supervisor processes running -- expected exactly one, check for a stale duplicate"
  else
    pass "C5d supervisor: exactly one fleet-supervisor running"
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
