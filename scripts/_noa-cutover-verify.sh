#!/usr/bin/env bash
# NoA-cutover RE-VERIFY (card 46b3bd75 / d469a65f). Run AFTER the live server
# restarts with the env-load fix + NOA_DB_PATH set. Replaces the 14:59 false-positive
# verify (which only checked the scheduler sentinel + port-200 -- both green even when
# the MAIN app stayed on claudeclaw.db). The lesson (verify-status-before-claiming-live,
# 06-25): a COUNTER does NOT prove a cutover. Only a LIVE WRITE through the live API
# that LANDS IN noa.db proves getDb()/getNoaDb() actually point there. Four proofs:
#   (A) the :3420 socket-owner PROCESS env carries NOA_DB_PATH
#   (B) a live KANBAN write lands in noa.db (noa-kanban path)
#   (C) a live MEMORY write lands in noa.db (noa-memory path)
#   (D) a live MESSAGE write lands in noa.db (legacy getDb path that rides NOA_DB_PATH)
# (B)+(C) cover the route-wired noa-* modules; (D) covers the legacy getDb domains.
# Exits non-zero if any check fails.
set -euo pipefail
cd /home/domin/marveen
TOKEN=$(cat store/.dashboard-token)
BASE=http://localhost:3420

count_in() { node -e "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});console.log(d.prepare('SELECT COUNT(*) c FROM '+process.argv[2]+' WHERE '+process.argv[3]+'=?').get(process.argv[4]).c)" "$1" "$2" "$3" "$4"; }

echo "[verify] (A) live dashboard process env carries NOA_DB_PATH"
# Identify the dashboard by the process LISTENING on :3420 -- NOT a cmdline grep.
# The built server runs as `node dist/index.js` (no "server" substring), so a
# pgrep -f "server" matched only the per-agent telegram plugins and never the real
# dashboard. The socket owner is the single source of truth.
SRV_PID=$(ss -ltnp 2>/dev/null | awk '/127.0.0.1:3420 /{print}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ -z "${SRV_PID:-}" ]; then
  echo "[verify] FAIL (A): no process is listening on 127.0.0.1:3420" >&2; exit 1
fi
cmd=$(tr '\0' ' ' < "/proc/$SRV_PID/cmdline" 2>/dev/null)
echo "  dashboard PID $SRV_PID :: $cmd"
if tr '\0' '\n' < "/proc/$SRV_PID/environ" 2>/dev/null | grep -q '^NOA_DB_PATH=store/noa.db$'; then
  echo "  PID $SRV_PID : NOA_DB_PATH=store/noa.db  OK"
else
  echo "[verify] FAIL (A): dashboard PID $SRV_PID (the :3420 listener) has no NOA_DB_PATH=store/noa.db in its process env" >&2
  exit 1
fi

echo "[verify] (B) a live kanban write lands in noa.db (not claudeclaw.db)"
CID=$(curl -s -X POST "$BASE/api/kanban" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"__cutover-verify-probe","description":"auto-deleted","status":"planned","priority":"low","assignee":"dave"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(String(JSON.parse(s).id))})")
echo "  probe card id: $CID"
in_noa=$(count_in store/noa.db kanban_cards id "$CID")
in_claw=$(count_in store/claudeclaw.db kanban_cards id "$CID")
echo "  in noa.db=$in_noa  claudeclaw.db=$in_claw"
curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/kanban/$CID" || true
[ "$in_noa" = "1" ] && [ "$in_claw" = "0" ] && echo "  (B) kanban write OK -> noa.db" \
  || { echo "[verify] FAIL (B): kanban write not on noa.db (noa=$in_noa claw=$in_claw)" >&2; exit 1; }

echo "[verify] (C) a live MEMORY write lands in noa.db (not claudeclaw.db)"
MID=$(curl -s -X POST "$BASE/api/memories" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"agent_id":"dave","content":"__cutover-verify-mem-probe","category":"hot","keywords":"cutover, probe"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(String(JSON.parse(s).id))})")
echo "  probe memory id: $MID"
m_noa=$(count_in store/noa.db memories id "$MID")
m_claw=$(count_in store/claudeclaw.db memories id "$MID")
echo "  in noa.db=$m_noa  claudeclaw.db=$m_claw"
curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/memories/$MID" || true
[ "$m_noa" = "1" ] && [ "$m_claw" = "0" ] && echo "  (C) memory write OK -> noa.db" \
  || { echo "[verify] FAIL (C): memory write not on noa.db (noa=$m_noa claw=$m_claw)" >&2; exit 1; }

echo "[verify] (D) a live MESSAGE write lands in noa.db (not claudeclaw.db)"
# Sentinel target -> the row INSERTs (proof) but never delivers / wakes anyone.
PROBE="__cutover-verify-msg-probe-$$"
curl -s -o /dev/null -X POST "$BASE/api/messages" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"from\":\"dave\",\"to\":\"__cutover_probe_sink__\",\"content\":\"$PROBE\"}"
g_noa=$(count_in store/noa.db agent_messages content "$PROBE")
g_claw=$(count_in store/claudeclaw.db agent_messages content "$PROBE")
echo "  in noa.db=$g_noa  claudeclaw.db=$g_claw"
node -e "for(const f of ['store/noa.db','store/claudeclaw.db']){try{const D=require('better-sqlite3');const d=new D(f);d.prepare('DELETE FROM agent_messages WHERE content=?').run(process.argv[1]);}catch(e){}}" "$PROBE" || true
[ "$g_noa" -ge 1 ] && [ "$g_claw" = "0" ] && echo "  (D) message write OK -> noa.db" \
  || { echo "[verify] FAIL (D): message write not on noa.db (noa=$g_noa claw=$g_claw)" >&2; exit 1; }

echo "[verify] PASS: dashboard env + kanban + memory + message writes all land in noa.db (cutover is LIVE)."
