#!/usr/bin/env bash
# NoA-cutover DRY-RUN gate (card d469a65f, W5). marveen mandate 2026-06-25:
# BEFORE the live cutover-deploy, prove the fully-wired build BOOTS and actually
# WRITES to a freshly-migrated noa.db COPY in a NON-LIVE context. This is the HARD
# gate that would have caught the cutover #3 salience crash without touching live.
#
# SAFETY: STORE_DIR / PID_FILENAME / PROJECT_ROOT are derived from the build's
# __dirname and are NOT env-overridable, and the startup race-guard would SIGTERM a
# peer that holds the recorded PID. So we NEVER boot from the live checkout. We copy
# dist/ into an isolated throwaway PROJECT_ROOT (own store/, own PID file) and boot
# there with RESPAWN_ENABLED=false (no fleet spawn) on a throwaway port. The live
# dashboard is never touched.
#
# Proves, against the COPY: (1) boot OK, (2) a live memory write lands, (3) a live
# kanban write lands, (4) a live message write lands. Any failure => non-zero exit.
set -euo pipefail

REPO="${1:-$(pwd)}"
PORT="${DRYRUN_PORT:-3499}"
# Hard safety: never use the live dashboard port. Combined with NOA_BOOT_SMOKE (which
# skips acquireLock's peer-kill) this guarantees the dry-run cannot disturb live.
if [ "$PORT" = "3420" ]; then
  echo "[dryrun] REFUSING to run on the live port 3420" >&2; exit 1
fi
cd "$REPO"

if [ ! -f dist/index.js ]; then
  echo "[dryrun] dist/index.js missing in $REPO -- run 'npm run build' first" >&2; exit 1
fi
if [ ! -f store/noa.db ]; then
  echo "[dryrun] store/noa.db missing in $REPO -- nothing to copy" >&2; exit 1
fi

DRYDIR=$(mktemp -d /tmp/noa-dryrun.XXXXXX)
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$SRV_PID" ] && wait "$SRV_PID" 2>/dev/null || true
  rm -rf "$DRYDIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "[dryrun] isolated PROJECT_ROOT: $DRYDIR  (port $PORT, RESPAWN_ENABLED=false)"
mkdir -p "$DRYDIR/store"
# dist + node_modules (symlink to the repo's, read-only use)
cp -r dist "$DRYDIR/dist"
ln -s "$REPO/node_modules" "$DRYDIR/node_modules"
# a FRESH copy of the migrated noa.db (checkpoint WAL first so the copy is complete)
node -e "const D=require('better-sqlite3');const d=new D('store/noa.db');d.pragma('wal_checkpoint(TRUNCATE)');d.close()" 2>/dev/null || true
cp store/noa.db "$DRYDIR/store/noa.db"
# dryrun gets its own token
TOKEN="dryrun-$(node -e 'process.stdout.write(Math.floor(Math.random()*1e9).toString(36))' 2>/dev/null || echo testtoken)"
printf '%s' "$TOKEN" > "$DRYDIR/store/.dashboard-token"
# carry .env (DB engine / ollama etc.) but the booted server is isolated by PROJECT_ROOT
[ -f .env ] && cp .env "$DRYDIR/.env" || true

BASE="http://localhost:$PORT"
echo "[dryrun] booting build in BOOT-SMOKE mode against the noa.db copy..."
# NOA_BOOT_SMOKE=<port>: db + web listener ONLY, never acquireLock (no peer-kill),
# no schedulers/agents/watchers -- the safe non-live boot path. Binds exactly $PORT.
# `exec` so the subshell BECOMES node -> $! is the REAL node PID and the cleanup
# trap actually kills it (a prior version killed only the wrapping subshell, leaving
# an orphaned node holding the port).
( cd "$DRYDIR" && exec env NOA_BOOT_SMOKE="$PORT" NOA_DB_PATH=store/noa.db node dist/index.js >"$DRYDIR/boot.log" 2>&1 ) &
SRV_PID=$!

# wait up to ~30s for the API to listen
up=0
for i in $(seq 1 60); do
  if curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" "$BASE/api/kanban" 2>/dev/null; then up=1; break; fi
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "[dryrun] FAIL: server process exited during boot. Last log:" >&2; tail -20 "$DRYDIR/boot.log" >&2; exit 1
  fi
  sleep 0.5
done
[ "$up" = "1" ] || { echo "[dryrun] FAIL: API never came up on $BASE. Boot log:" >&2; tail -20 "$DRYDIR/boot.log" >&2; exit 1; }
echo "[dryrun] (1) boot OK"

DRYDB="$DRYDIR/store/noa.db"
count_in() { node -e "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});console.log(d.prepare('SELECT COUNT(*) c FROM '+process.argv[2]+' WHERE '+process.argv[3]+'=?').get(process.argv[4]).c)" "$1" "$2" "$3" "$4"; }

# (2) memory write
MID=$(curl -s -X POST "$BASE/api/memories" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"agent_id":"dave","content":"__dryrun-mem-probe","category":"hot","keywords":"dryrun"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).id))}catch{process.stdout.write('')}})")
[ -n "$MID" ] && [ "$(count_in "$DRYDB" memories id "$MID")" = "1" ] \
  && echo "[dryrun] (2) memory write OK -> copy noa.db" \
  || { echo "[dryrun] FAIL (2): memory write did not land in copy (id=$MID)" >&2; tail -20 "$DRYDIR/boot.log" >&2; exit 1; }

# (3) kanban write
CID=$(curl -s -X POST "$BASE/api/kanban" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"__dryrun-kanban-probe","status":"planned","priority":"low","assignee":"dave"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).id))}catch{process.stdout.write('')}})")
[ -n "$CID" ] && [ "$(count_in "$DRYDB" kanban_cards id "$CID")" = "1" ] \
  && echo "[dryrun] (3) kanban write OK -> copy noa.db" \
  || { echo "[dryrun] FAIL (3): kanban write did not land in copy (id=$CID)" >&2; tail -20 "$DRYDIR/boot.log" >&2; exit 1; }

# (4) message write (legacy getDb domain rides NOA_DB_PATH). Recipient must be a
# REAL agent (the route rejects unknown recipients); boot-smoke runs NO delivery
# loop so the row only lands in the copy and never wakes anyone.
PROBE="__dryrun-msg-probe-$$"
curl -s -o /dev/null -X POST "$BASE/api/messages" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"from\":\"dave\",\"to\":\"marveen\",\"content\":\"$PROBE\"}"
[ "$(count_in "$DRYDB" agent_messages content "$PROBE")" -ge 1 ] \
  && echo "[dryrun] (4) message write OK -> copy noa.db" \
  || { echo "[dryrun] FAIL (4): message write did not land in copy" >&2; tail -20 "$DRYDIR/boot.log" >&2; exit 1; }

echo "[dryrun] PASS: build boots + memory/kanban/message writes all land in the freshly-migrated noa.db copy. Cutover-deploy is cleared for Boss-GO."
