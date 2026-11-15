#!/bin/bash
# Tests build_dashboard_new() -- the dashboard-new (/v2 SPA) frontend build step
# factored out of deploy.sh (card 6b977440). The 11-12 incident: deploy.sh only
# ran the ROOT backend build, never `cd dashboard-new && npm run build`, so the
# served /v2 frontend (PROJECT_ROOT/dashboard-new/dist) shipped STALE.
#
# The function is unit-tested in isolation with a STUB `npm` on PATH, so no real
# vite/tsc build runs. Covers: standard build-in-place, isolated worktree build
# + rsync to the served dist, the served-dist index.html assertion (false-green
# guard), node_modules symlink in isolated mode, and the usage/failure exits.
#
# Run: bash scripts/__tests__/deploy-build-frontend.test.sh

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$INSTALL_DIR/scripts/deploy-build-frontend.sh"

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

[ -f "$HELPER" ] || { echo "FATAL: $HELPER missing"; exit 1; }
# shellcheck source=/dev/null
source "$HELPER"

# A stub `npm` that mimics `npm run build` for dashboard-new: it writes a dist/
# with index.html into the CURRENT directory (the function cd's into the
# dashboard-new dir before invoking it). Behaviour is controlled per-test by the
# STUB_MODE env var: ok=produce dist/index.html; nofile=exit 0 but produce
# nothing (false-green probe); crash=exit 1.
make_stub_npm() {
  local bindir="$1"
  mkdir -p "$bindir"
  cat > "$bindir/npm" <<'STUB'
#!/bin/bash
# only intercept `npm run build`; anything else is a no-op success
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  case "${STUB_MODE:-ok}" in
    ok)     mkdir -p dist && printf '<!doctype html><html></html>' > dist/index.html ;;
    nofile) : ;;                 # succeed but produce no dist (false-green probe)
    crash)  echo "stub build boom" >&2; exit 1 ;;
  esac
fi
exit 0
STUB
  chmod +x "$bindir/npm"
}

# ---------------------------------------------------------------------------
# Part 1: standard (in-place) build writes the served dashboard-new/dist
# ---------------------------------------------------------------------------
echo "--- Part 1: standard build-in-place ---"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
STUB="$WORK/bin"; make_stub_npm "$STUB"
REPO="$WORK/repo"; mkdir -p "$REPO/dashboard-new/node_modules"

STUB_MODE=ok PATH="$STUB:$PATH" build_dashboard_new "$REPO" "" 0
rc=$?
[ "$rc" -eq 0 ] && pass "standard build returns 0" || fail "standard build returned $rc (want 0)"
[ -f "$REPO/dashboard-new/dist/index.html" ] \
  && pass "served dashboard-new/dist/index.html created in place" \
  || fail "served dashboard-new/dist/index.html NOT created"
echo

# ---------------------------------------------------------------------------
# Part 2: served-dist assertion is a real gate (false-green guard)
# A build that exits 0 but leaves no dist/index.html must FAIL, not pass.
# ---------------------------------------------------------------------------
echo "--- Part 2: no-output build fails (false-green guard) ---"
REPO2="$WORK/repo2"; mkdir -p "$REPO2/dashboard-new/node_modules"
STUB_MODE=nofile PATH="$STUB:$PATH" build_dashboard_new "$REPO2" "" 0
rc=$?
[ "$rc" -ne 0 ] && pass "no-output build returns non-zero ($rc)" \
  || fail "no-output build returned 0 (false green!)"
echo

# ---------------------------------------------------------------------------
# Part 3: npm build crash propagates as failure
# ---------------------------------------------------------------------------
echo "--- Part 3: build crash propagates ---"
REPO3="$WORK/repo3"; mkdir -p "$REPO3/dashboard-new/node_modules"
STUB_MODE=crash PATH="$STUB:$PATH" build_dashboard_new "$REPO3" "" 0
rc=$?
[ "$rc" -ne 0 ] && pass "crash build returns non-zero ($rc)" \
  || fail "crash build returned 0 (should have failed)"
echo

# ---------------------------------------------------------------------------
# Part 4: isolated worktree mode builds in the worktree and rsyncs to the
# SERVED repo dist (the server reads PROJECT_ROOT/dashboard-new/dist, never the
# worktree), and shares the repo's node_modules via symlink.
# ---------------------------------------------------------------------------
echo "--- Part 4: isolated worktree build + rsync to served dist ---"
REPO4="$WORK/repo4"; WT="$WORK/wt4"
mkdir -p "$REPO4/dashboard-new/node_modules"   # repo has installed deps
mkdir -p "$WT/dashboard-new"                    # worktree checkout (no node_modules/dist)
# make the repo deps identifiable so we can prove the symlink points at them
touch "$REPO4/dashboard-new/node_modules/.marker"

STUB_MODE=ok PATH="$STUB:$PATH" build_dashboard_new "$REPO4" "$WT" 1
rc=$?
[ "$rc" -eq 0 ] && pass "isolated build returns 0" || fail "isolated build returned $rc (want 0)"
[ -L "$WT/dashboard-new/node_modules" ] \
  && pass "worktree dashboard-new/node_modules is a symlink" \
  || fail "worktree dashboard-new/node_modules symlink NOT created"
[ -f "$WT/dashboard-new/node_modules/.marker" ] \
  && pass "symlink resolves to the repo's installed node_modules" \
  || fail "symlink does not resolve to repo node_modules"
[ -f "$REPO4/dashboard-new/dist/index.html" ] \
  && pass "served repo dashboard-new/dist/index.html populated via rsync" \
  || fail "served repo dist NOT populated (frontend would ship stale)"
echo

# ---------------------------------------------------------------------------
# Part 5: isolated mode without a worktree path is a usage error (exit 2)
# ---------------------------------------------------------------------------
echo "--- Part 5: isolated mode needs a worktree path ---"
REPO5="$WORK/repo5"; mkdir -p "$REPO5/dashboard-new/node_modules"
STUB_MODE=ok PATH="$STUB:$PATH" build_dashboard_new "$REPO5" "" 1
rc=$?
[ "$rc" -eq 2 ] && pass "isolated+no-wtpath returns usage error (2)" \
  || fail "isolated+no-wtpath returned $rc (want 2)"
echo

# ---------------------------------------------------------------------------
# Part 6: deploy.sh actually CALLS the helper (wiring guard -- a factored
# function nobody invokes is the original bug in a new costume).
# ---------------------------------------------------------------------------
echo "--- Part 6: deploy.sh wires in the frontend build ---"
DEPLOY="$INSTALL_DIR/scripts/deploy.sh"
if grep -q "deploy-build-frontend.sh" "$DEPLOY" && grep -q "build_dashboard_new" "$DEPLOY"; then
  pass "deploy.sh sources the helper and calls build_dashboard_new"
else
  fail "deploy.sh does not wire in build_dashboard_new -- frontend still stale"
fi
echo

echo "======================================"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "$FAIL CHECK(S) FAILED"
  exit 1
fi
