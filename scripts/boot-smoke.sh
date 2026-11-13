#!/usr/bin/env bash
# boot-smoke.sh -- isolated boot-smoke for the compiled dist (card 2e3779c5).
#
# Proves the BUILT dist actually BOOTS under Node-native ESM before it reaches a
# deploy. tsc --noEmit (@types interop) and vitest/vite (synthesises a default
# export) both go green on an ESM default-vs-named import mismatch; only a real
# `node dist/index.js` boot catches it. That class caused the 2026-11-12 LIVE
# dashboard outage (src/web/routes/push.ts default-imported web-push@4, which is
# named-only ESM -> boot crash; fix PR #972). This gate would have caught it.
#
# This is the BOOT-ONLY sibling of scripts/_noa-cutover-dryrun.sh: same isolation
# recipe, but it stops at "did it bind its port" and runs NO write probes, so it
# stays well under the ~40s gate budget.
#
# ISOLATION (the whole point -- a misconfigured env reproduces the very outage):
#   * NOA_BOOT_SMOKE=<port>: db + web listener ONLY; never acquireLock() (no
#     :3420 peer-kill), no schedulers/agents/watchers (src/index.ts boot-smoke path).
#   * Boots in a throwaway PROJECT_ROOT (mktemp): the build derives store/, the PID
#     file and the token from its own __dirname, so it CANNOT reach the live tree.
#   * The noa.db is a fresh COPY placed at store/sandbox/noa.db; NOA_DB_PATH points
#     there and SANDBOX_ISOLATION=1 makes the build ABORT if that path ever resolves
#     to the canonical <root>/store/noa.db (sandbox-guard.ts). Double safety.
#   * The live dashboard port 3420 is REFUSED outright.
#
# Usage:  scripts/boot-smoke.sh [REPO]        (REPO defaults to $PWD)
#   BOOT_SMOKE_PORT   port to bind       (default 3498; 3420 is refused)
#   BOOT_SMOKE_TIMEOUT  seconds to wait for the listener (default 30)
#
# Exit codes (consumed by check_boot_smoke / deploy-preflight C6):
#   0  PASS  -- booted and bound its port
#   1  BLOCK -- process exited during boot or never bound (== boot failure)
#   2  SKIP  -- precondition unmet (missing dist/db, or an unsafe port)
set -euo pipefail

REPO="${1:-$(pwd)}"
PORT="${BOOT_SMOKE_PORT:-3498}"
TIMEOUT="${BOOT_SMOKE_TIMEOUT:-30}"

# Hard safety: never touch the live dashboard port. Combined with the isolated
# PROJECT_ROOT and SANDBOX_ISOLATION=1 this guarantees the smoke cannot disturb live.
if [ "$PORT" = "3420" ]; then
  echo "[boot-smoke] SKIP: REFUSING to boot on the live dashboard port 3420" >&2
  exit 2
fi

cd "$REPO"

if [ ! -f dist/index.js ]; then
  echo "[boot-smoke] SKIP: dist/index.js missing in $REPO -- run 'npm run build' first" >&2
  exit 2
fi
if [ ! -f store/noa.db ]; then
  echo "[boot-smoke] SKIP: store/noa.db missing in $REPO -- nothing to copy" >&2
  exit 2
fi

SMOKEDIR=$(mktemp -d /tmp/noa-boot-smoke.XXXXXX)
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$SRV_PID" ] && wait "$SRV_PID" 2>/dev/null || true
  rm -rf "$SMOKEDIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "[boot-smoke] isolated PROJECT_ROOT: $SMOKEDIR  (port $PORT, SANDBOX_ISOLATION=1)"
mkdir -p "$SMOKEDIR/store/sandbox"
cp -r dist "$SMOKEDIR/dist"
ln -s "$REPO/node_modules" "$SMOKEDIR/node_modules"
# A FRESH copy of noa.db at a NON-canonical path. Checkpoint the WAL first so the
# copy is complete; fail-open if better-sqlite3 is unavailable (the copy still works).
node -e "const D=require('better-sqlite3');const d=new D('store/noa.db');d.pragma('wal_checkpoint(TRUNCATE)');d.close()" 2>/dev/null || true
cp store/noa.db "$SMOKEDIR/store/sandbox/noa.db"
printf '%s' "boot-smoke-$$" > "$SMOKEDIR/store/.dashboard-token"
# Carry .env (DB engine etc.) but the booted server is isolated by PROJECT_ROOT.
[ -f .env ] && cp .env "$SMOKEDIR/.env" || true

TOKEN="boot-smoke-$$"
BASE="http://localhost:$PORT"
echo "[boot-smoke] booting dist in BOOT-SMOKE mode (db + web only)..."
# NOA_DB_PATH points at the sandbox COPY (NOT <root>/store/noa.db), so the
# SANDBOX_ISOLATION=1 guard passes while actively asserting we are off the live
# path. `exec` so the subshell BECOMES node -> $! is the REAL node pid and the
# cleanup trap actually kills it (never leave an orphan holding the port).
( cd "$SMOKEDIR" && exec env \
    NOA_BOOT_SMOKE="$PORT" \
    NOA_DB_PATH=store/sandbox/noa.db \
    SANDBOX_ISOLATION=1 \
    RESPAWN_ENABLED=false \
    node dist/index.js >"$SMOKEDIR/boot.log" 2>&1 ) &
SRV_PID=$!

# Wait up to TIMEOUT seconds for the listener (poll every 0.5s).
polls=$(( TIMEOUT * 2 ))
up=0
for _ in $(seq 1 "$polls"); do
  if curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" "$BASE/api/kanban" 2>/dev/null; then
    up=1; break
  fi
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "[boot-smoke] BLOCK: process EXITED during boot (boot crash). Last log:" >&2
    tail -20 "$SMOKEDIR/boot.log" >&2
    exit 1
  fi
  sleep 0.5
done

if [ "$up" != "1" ]; then
  echo "[boot-smoke] BLOCK: dist never bound $BASE within ${TIMEOUT}s. Boot log:" >&2
  tail -20 "$SMOKEDIR/boot.log" >&2
  exit 1
fi

echo "[boot-smoke] PASS: dist boots and binds $BASE in an isolated root (no ESM/boot crash, live untouched)."
exit 0
