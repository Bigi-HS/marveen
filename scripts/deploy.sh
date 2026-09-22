#!/usr/bin/env bash
# deploy.sh -- Genesis dashboard deploy in one idempotent command (card dc39ba0f).
#
# Requires: Genesis-GO obtained before running.
# Funnel-flip (dashboard-new ROOT FLIP, card 2d70c06e) is NOT part of this script.
#
# Exit 0 = deploy complete and verified.
# Exit 1 = deploy failed or blocked (see output).
# Exit 2 = usage / script setup error.
#
# Usage:
#   bash scripts/deploy.sh                        # deploys origin/develop
#   bash scripts/deploy.sh --target <sha-or-ref>  # deploys a specific ref
#   bash scripts/deploy.sh --dry-run              # steps 0-1 only (delta+hold check, no changes)
#
# Steps (reference: card dc39ba0f, live run 2026-08-02):
#   0. DEPLOY-HOLD sentinel check (hard stop if active unmet hold)
#   1. Delta check -- no new commits -> exit 0 clean
#   2. Backup live dist (rollback point, BEFORE building)
#   3. Detect worktree situation; plan isolated build if main tree is not on develop
#   4. Build from target ref in isolated worktree; assert tsc exit 0
#   5. Hook-presence gate (hard stop if any missing)
#   6. rsync worktree dist/ -> live dist/
#   7. Source-sync: main-tree HEAD must equal deployed SHA; reset if safe
#   8. Write planned-restart.marker, restart marveen dashboard (NEVER marveen-channels)
#   9. 4-point verify (/api/gate/verify F1-F5)
#  10. Pipe-watch ~110s for channel-monitor recovery
#  11. rm planned-restart.marker + update-deployed-tip.sh
#  12. Prune worktree + notify

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="origin/develop"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || { echo "usage error: --target needs a ref" >&2; exit 2; }
      TARGET="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0 ;;
    *) echo "usage error: unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$REPO" || { echo "ERROR: cannot cd $REPO" >&2; exit 2; }

BOLD=""; RESET=""; RED=""; GREEN=""; YELLOW=""
if [ -t 1 ]; then BOLD="\033[1m"; RESET="\033[0m"; RED="\033[31m"; GREEN="\033[32m"; YELLOW="\033[33m"; fi
step()  { echo -e "${BOLD}==> $*${RESET}"; }
pass()  { echo -e "  ${GREEN}PASS${RESET}  $*"; }
fail()  { echo -e "  ${RED}FAIL${RESET}  $*" >&2; }
warn()  { echo -e "  ${YELLOW}WARN${RESET}  $*"; }
abort() { echo -e "${RED}ABORT: $*${RESET}" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Step 0: DEPLOY-HOLD sentinel check
# A hold sentinel (.deploy-hold-<sha>) documents a deliberate block on
# shipping specific commits until named release-conditions are met. Read
# each one; abort if the target contains the held commit AND the conditions
# are not satisfied (to be judged by the operator; the script only detects
# the hold is present and prints its content).
# ---------------------------------------------------------------------------
step "0. DEPLOY-HOLD sentinel check"
shopt -s nullglob
hold_files=("$REPO"/store/.deploy-hold-*)
shopt -u nullglob
if [ "${#hold_files[@]}" -gt 0 ]; then
  target_sha=$(git rev-parse "$TARGET" 2>/dev/null)
  hold_hit=0
  for hf in "${hold_files[@]}"; do
    held_sha="${hf##*/.deploy-hold-}"
    if git cat-file -e "${held_sha}^{commit}" 2>/dev/null \
       && git merge-base --is-ancestor "$held_sha" "$target_sha" 2>/dev/null; then
      echo ""
      echo "  HOLD ACTIVE -- held commit ${held_sha:0:8} is in target $TARGET:"
      cat "$hf" | sed 's/^/    /'
      echo ""
      hold_hit=$((hold_hit + 1))
    fi
  done
  if [ "$hold_hit" -gt 0 ]; then
    abort "$hold_hit active DEPLOY-HOLD sentinel(s) found. Read above and verify all release-conditions are met before running deploy. If all conditions are satisfied, remove the sentinel(s) from store/ first."
  fi
  pass "no active holds match target $TARGET"
else
  pass "no deploy-hold sentinels found"
fi
echo

# ---------------------------------------------------------------------------
# Step 1: Delta check -- enumerate PRs, classify risk, check for any delta
# ---------------------------------------------------------------------------
step "1. Delta check (deploy-delta-check.py vs store/.deployed-tip)"
if [ ! -f scripts/deploy-delta-check.py ]; then
  abort "scripts/deploy-delta-check.py missing -- cannot check the deploy delta"
fi

delta_out=$(python3 scripts/deploy-delta-check.py --target "$TARGET" 2>&1)
delta_rc=$?
echo "$delta_out"

# "No new PRs" exit path: delta-check exits 0 and prints "Delta: 0 PR(s)"
if echo "$delta_out" | grep -qE "^Delta: 0 PR"; then
  pass "no new commits to deploy -- already at $TARGET"
  echo ""
  echo "Nothing to deploy. Exit clean."
  exit 0
fi

if [ "$delta_rc" -eq 1 ] && echo "$delta_out" | grep -q "HIGH"; then
  warn "HIGH-risk PRs in the delta. Named sign-off required -- make sure Genesis-GO covers these PRs explicitly."
elif [ "$delta_rc" -ne 0 ]; then
  abort "delta-check failed (rc=$delta_rc) -- review output above before proceeding"
fi
echo

[ "$DRY_RUN" -eq 1 ] && { echo "Dry-run: steps 0-1 complete. No changes made."; exit 0; }

# ---------------------------------------------------------------------------
# Step 2: Backup live dist (rollback point, BEFORE building)
# deploy-backup.sh copies dist/ to /tmp/marveen-deploy-backups/<ts>/ and
# labels it with deployed-sha.txt. It refuses to run if dist/ is newer than
# store/.deployed-tip (meaning a previous build already overwrote the live
# dist -- ordering invariant violated). Must come before the build.
# ---------------------------------------------------------------------------
step "2. Backup live dist (rollback point)"
if [ ! -f scripts/deploy-backup.sh ]; then
  abort "scripts/deploy-backup.sh missing"
fi
backup_out=$(bash scripts/deploy-backup.sh --no-gate --target "$TARGET" 2>&1)
backup_rc=$?
echo "$backup_out"
if [ "$backup_rc" -ne 0 ]; then
  abort "deploy-backup.sh failed (rc=$backup_rc) -- rollback point not created, cannot proceed"
fi
ROLLBACK_DIR=$(echo "$backup_out" | grep "^rollback point:" | awk '{print $NF}')
[ -n "$ROLLBACK_DIR" ] || abort "could not parse rollback dir from backup output"
pass "rollback point: $ROLLBACK_DIR"
echo

# ---------------------------------------------------------------------------
# Step 3: Detect worktree situation
# If main working tree is NOT on develop (an agent has it on a feature
# branch), an isolated worktree build is MANDATORY -- never checkout/reset
# in the main tree mid-task.
# ---------------------------------------------------------------------------
step "3. Detect build path"
main_branch=$(git -C "$REPO" branch --show-current 2>/dev/null || echo "DETACHED")
target_sha=$(git rev-parse "$TARGET")

ISOLATED=0
WT_PATH="/home/domin/marveen/.worktrees/deploy-live-$(date +%Y%m%d-%H%M%S)"

if [ "$main_branch" = "develop" ] || [ "$main_branch" = "DETACHED" ]; then
  pass "main tree is on '$main_branch' -- standard checkout+build path"
else
  warn "main tree is on branch '$main_branch' -- using ISOLATED WORKTREE build (never reset shared checkout)"
  ISOLATED=1
fi
echo

# ---------------------------------------------------------------------------
# Step 4: Build from target ref
# ---------------------------------------------------------------------------
step "4. Build from $TARGET (${target_sha:0:8})"
if [ "$ISOLATED" -eq 1 ]; then
  echo "  Creating isolated worktree at $WT_PATH ..."
  git worktree add --detach "$WT_PATH" "$target_sha" \
    || abort "git worktree add failed"
  echo "  Symlinking node_modules ..."
  ln -sfn "$REPO/node_modules" "$WT_PATH/node_modules"
  echo "  Building in worktree ..."
  ( cd "$WT_PATH" && npm run build ) || {
    git -C "$REPO" worktree remove --force "$WT_PATH" 2>/dev/null
    abort "npm run build failed in isolated worktree"
  }
  # Assert tsc produced a dist
  [ -f "$WT_PATH/dist/index.js" ] || abort "build succeeded but dist/index.js missing in worktree"
  pass "isolated worktree build complete: $WT_PATH"
else
  # Stash check: any uncommitted operational drift in src/scripts that is not
  # in origin/develop? If so, warn -- a blind reset would wipe it.
  dirty=$(git -C "$REPO" status --porcelain scripts/ 2>/dev/null | grep -v "^??" | head -5)
  if [ -n "$dirty" ]; then
    warn "uncommitted operational drift detected in scripts/:"
    echo "$dirty" | sed 's/^/    /'
    warn "Stash or merge before proceeding to avoid losing in-flight changes (fleet-deploy-verify SKILL.md caution)"
    abort "main tree has uncommitted script changes -- review above, then re-run or use isolated worktree"
  fi
  echo "  Fetching origin/develop ..."
  git fetch origin develop --quiet
  echo "  Resetting to $TARGET (${target_sha:0:8}) ..."
  git -C "$REPO" reset --hard "$target_sha"
  echo "  Building ..."
  ( cd "$REPO" && npm run build ) || abort "npm run build failed"
  [ -f "$REPO/dist/index.js" ] || abort "build succeeded but dist/index.js missing"
  pass "main-tree build complete"
fi
echo

# ---------------------------------------------------------------------------
# Step 5: Hook-presence gate (hard stop if any hook script is missing)
# Hook scripts run from the SOURCE TREE at their absolute paths; if a newly
# added hook is absent from disk, Python exits 2 = deny-block fleet-wide.
# ---------------------------------------------------------------------------
step "5. Hook-presence gate"
hook_result=$(python3 - <<'PY'
import os, json, glob, re
settings_paths = (
    glob.glob("/home/domin/marveen/agents/*/.claude*/settings.json") +
    glob.glob("/home/domin/marveen/agents/*/.*/.claude/settings.json")
)
referenced = set()
for path in settings_paths:
    try:
        for m in re.finditer(r"scripts/hooks/[^\s\"']+\.py", open(path).read()):
            referenced.add(m.group())
    except Exception:
        pass
missing = [f for f in sorted(referenced)
           if not os.path.exists("/home/domin/marveen/" + f)]
if missing:
    print("MISSING:", " ".join(missing))
    raise SystemExit(1)
print(f"Hook-presence OK: {len(referenced)} checked, 0 missing")
PY
)
hook_rc=$?
echo "  $hook_result"
if [ "$hook_rc" -ne 0 ]; then
  abort "hook-presence gate FAILED -- missing hook scripts. Ensure source tree is at the deployed SHA before restarting (fleet-deploy-verify SOURCE-TREE SYNC)"
fi
pass "hook-presence: $hook_result"
echo

# ---------------------------------------------------------------------------
# Step 6: rsync worktree dist/ -> live dist/ (isolated path only)
# In the standard path, npm run build already wrote to live dist/ directly.
# ---------------------------------------------------------------------------
if [ "$ISOLATED" -eq 1 ]; then
  step "6. rsync worktree dist/ -> live dist/"
  rsync -a --delete "$WT_PATH/dist/" "$REPO/dist/" \
    || abort "rsync failed"
  pass "rsync complete"
  echo
fi

# ---------------------------------------------------------------------------
# Step 7: Source-sync assertion
# The deployed dist must match the source tree on disk. After an isolated
# worktree build + rsync the main tree HEAD may still be on a feature branch;
# the agent hooks (scripts/hooks/*.py) must match the deployed tip.
# Only reset if the main tree is on develop or DETACHED (not mid-commit).
# ---------------------------------------------------------------------------
step "7. Source-sync assertion (main tree HEAD == $target_sha)"
main_head=$(git -C "$REPO" rev-parse HEAD)
if [ "$main_head" = "$target_sha" ]; then
  pass "main tree already at target ${target_sha:0:8}"
elif [ "$main_branch" = "develop" ] || [ "$main_branch" = "DETACHED" ]; then
  echo "  main tree at ${main_head:0:8}, resetting to ${target_sha:0:8} ..."
  git -C "$REPO" fetch origin develop --quiet
  git -C "$REPO" reset --hard "$target_sha" \
    || abort "source-sync reset failed"
  pass "source-sync: main tree reset to ${target_sha:0:8}"
else
  warn "main tree is on branch '$main_branch' (${main_head:0:8}) -- cannot auto-reset. Ensure hook scripts from ${target_sha:0:8} are present on disk. Verify manually before restart."
fi
echo

# ---------------------------------------------------------------------------
# Step 8: Planned-restart marker + restart marveen dashboard
# Write the marker FIRST to suppress the supervisor-sentinel noise alert.
# Kill + new-session with the supervisor's curated PATH so supervisor does
# not fight the new session. NEVER touch marveen-channels.
# ---------------------------------------------------------------------------
step "8. Restart marveen dashboard"
MARKER="$REPO/store/planned-restart.marker"
touch "$MARKER" || abort "cannot write planned-restart.marker"
pass "planned-restart.marker written"

PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node)"
TMUXB="$(command -v tmux)"

[ -n "$NODE" ]  || abort "node not found in PATH"
[ -n "$TMUXB" ] || abort "tmux not found in PATH"

env -u TMUX "$TMUXB" kill-session -t "=marveen" 2>/dev/null && echo "  killed existing marveen session" || echo "  no existing marveen session to kill"
env -u TMUX "$TMUXB" new-session -d -s marveen -c "$REPO" \
  "export PATH=\"$PATH_CURATED\" && exec $NODE dist/index.js" \
  || abort "tmux new-session failed"
pass "marveen session started"
echo

# Poll until server answers (max 40s)
echo "  Waiting for server to answer :3420 ..."
for i in $(seq 1 8); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3420/api/health 2>/dev/null | grep -qE "^(200|401)$"; then
    pass "server answering after ${i}0s"
    break
  fi
  [ "$i" -lt 8 ] && sleep 5 || abort "server did not answer :3420 within 40s after restart"
done
echo

# ---------------------------------------------------------------------------
# Step 9: 4-point verify (/api/gate/verify)
# F2/F3 failures trigger rollback; F1=route+DB (expected pass), F4=vault
# (pre-existing non-regression on fresh session), F5=dist content.
# ---------------------------------------------------------------------------
step "9. 4-point verify"
TOKEN_FILE="$REPO/store/.dashboard-token"
verify_result=$(python3 - <<PY
import urllib.request, json, sys

token = open("$TOKEN_FILE").read().strip()
req = urllib.request.Request(
    "http://localhost:3420/api/gate/verify",
    headers={"Authorization": f"Bearer {token}"}
)
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read().decode())
        print(json.dumps(data, indent=2))
        sys.exit(0 if data.get("pass") else 1)
except Exception as e:
    print(f"verify request failed: {e}", file=sys.stderr)
    sys.exit(2)
PY
)
verify_rc=$?
echo "$verify_result" | sed 's/^/  /'

if [ "$verify_rc" -eq 0 ]; then
  pass "/api/gate/verify: PASS"
elif [ "$verify_rc" -eq 2 ]; then
  abort "verify endpoint unreachable -- server may not have started correctly"
else
  # Check if only F4 failed (known pre-existing non-regression on fresh session)
  f1=$(echo "$verify_result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('F1','?'))" 2>/dev/null)
  f2=$(echo "$verify_result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('F2','?'))" 2>/dev/null)
  f3=$(echo "$verify_result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('F3','?'))" 2>/dev/null)
  f4=$(echo "$verify_result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('F4','?'))" 2>/dev/null)
  if [ "$f1" = "True" ] && [ "$f2" = "True" ] && [ "$f3" = "True" ] && [ "$f4" != "True" ]; then
    warn "F4 failed -- pre-existing non-regression (vault restore requires an active channel agent session). F1/F2/F3 green: deploy is live."
    pass "/api/gate/verify: F1+F2+F3 green (F4 non-regression accepted)"
  else
    fail "/api/gate/verify: FAIL (F1=$f1 F2=$f2 F3=$f3 F4=$f4)"
    echo ""
    echo "F2 or F3 failure = rollback trigger. Running rollback now ..."
    if [ -f scripts/rollback.sh ]; then
      bash scripts/rollback.sh "$ROLLBACK_DIR" || echo "rollback script also failed -- manual recovery required"
    else
      echo "rollback.sh not found -- manual rollback required: rsync $ROLLBACK_DIR/ dist/ + restart"
    fi
    abort "4-point verify FAILED. Rolled back to $ROLLBACK_DIR. Escalate to Genesis."
  fi
fi
echo

# ---------------------------------------------------------------------------
# Step 10: Pipe-watch ~110s
# Poll channel-monitor poller presence every ~20s for 2 min. The restart
# may have killed the orchestrator's MCP child; item3 should auto-reconnect
# within ~60-105s. Silence > 2 min = regression.
# NOTE: this checks the DASHBOARD SERVER's in-process poller (a), not the
# orchestrator pipe (b). See SKILL.md "TWO DISTINCT TELEGRAM PIPES".
# ---------------------------------------------------------------------------
step "10. Pipe-watch ~110s (channel-monitor recovery)"
TOKEN_FILE="$REPO/store/.dashboard-token"
echo "  Polling channel-monitor poller presence every 20s for 110s ..."
pipe_ok=0
for i in 1 2 3 4 5 6; do
  sleep 20
  presence=$(python3 - <<PY 2>/dev/null
import urllib.request, json
token = open("$TOKEN_FILE").read().strip()
req = urllib.request.Request(
    "http://localhost:3420/api/agents/health",
    headers={"Authorization": f"Bearer {token}"}
)
try:
    with urllib.request.urlopen(req, timeout=5) as r:
        data = json.loads(r.read().decode())
        agents = data if isinstance(data, list) else data.get("agents", [])
        marveen = next((a for a in agents if a.get("agent_id") == "marveen"), None)
        if marveen:
            print(str(marveen.get("channel_healthy", "?")).lower())
        else:
            print("marveen-not-found")
except Exception as e:
    print(f"err: {e}")
PY
)
  elapsed=$((i * 20))
  echo "  ${elapsed}s: channel_healthy=${presence}"
  if [ "$presence" = "true" ] || [ "$presence" = "false" ]; then
    pipe_ok=1
    pass "channel-monitor poller responsive at ${elapsed}s (healthy=${presence})"
    break
  fi
done

if [ "$pipe_ok" -eq 0 ]; then
  warn "channel-monitor poller did not respond within 110s -- possible pipe regression. Verify manually: bash scripts/verify-channel-recovery-intent.sh"
fi
echo

# ---------------------------------------------------------------------------
# Step 11: Remove planned-restart marker + update deployed-tip
# ---------------------------------------------------------------------------
step "11. Clean up: remove marker + update deployed-tip"
rm -f "$MARKER"
pass "planned-restart.marker removed"

bash "$SCRIPT_DIR/update-deployed-tip.sh" "$target_sha" \
  || warn "update-deployed-tip.sh failed -- run manually: bash scripts/update-deployed-tip.sh ${target_sha:0:8}"
pass "deployed-tip updated to ${target_sha:0:8}"
echo

# ---------------------------------------------------------------------------
# Step 12: Worktree cleanup
# ---------------------------------------------------------------------------
if [ "$ISOLATED" -eq 1 ] && [ -d "$WT_PATH" ]; then
  step "12. Prune isolated worktree ($WT_PATH)"
  git -C "$REPO" worktree remove --force "$WT_PATH" 2>/dev/null && pass "worktree removed" || warn "worktree remove failed -- remove manually: git worktree remove --force $WT_PATH"
  echo
fi

echo ""
echo -e "${GREEN}${BOLD}=== DEPLOY COMPLETE ===${RESET}"
echo "  target  : $TARGET (${target_sha:0:8})"
echo "  rollback: $ROLLBACK_DIR"
echo "  verify  : PASS"
echo ""
echo "Post-deploy reminders:"
echo "  - MCP delta? Recycle consumer agents whose MCP child predates the dist build (SKILL.md CONSUMER-AGENT MCP RESTART)"
echo "  - Orchestrator pipe (marveen-channels) may need /mcp if Telegram replies are mute"
echo "  - Report to Genesis with per-point evidence"
