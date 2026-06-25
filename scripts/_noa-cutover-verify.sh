#!/usr/bin/env bash
# NoA-cutover RE-VERIFY (card 46b3bd75). Run AFTER the server restarts with the
# env-load fix + NOA_DB_PATH set. This replaces the 14:59 false-positive verify
# (which only checked the scheduler sentinel + port-200 -- both green even when the
# MAIN app stayed on claudeclaw.db). Here we prove the MAIN app is on noa.db two
# independent ways:
#   (A) the live server PROCESS env actually carries NOA_DB_PATH (/proc/PID/environ)
#   (B) a real KANBAN write through the live API LANDS IN noa.db (not claudeclaw.db)
# Exits non-zero if either check fails.
set -euo pipefail
cd /home/domin/marveen
TOKEN=$(cat store/.dashboard-token)
BASE=http://localhost:3420

echo "[verify] (A) live server process env carries NOA_DB_PATH"
ok_env=0
for p in $(pgrep -f "server" 2>/dev/null); do
  [ -r "/proc/$p/environ" ] || continue
  cmd=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)
  case "$cmd" in
    *server.ts*|*dist/index*|*dist/mcp*) : ;;  # candidate dashboard server
    *) continue ;;
  esac
  # exclude the google-mcp helper; we want the dashboard server
  case "$cmd" in *google-mcp*) continue ;; esac
  if tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -q '^NOA_DB_PATH=store/noa.db$'; then
    echo "  PID $p : NOA_DB_PATH=store/noa.db  OK"
    ok_env=1
  else
    echo "  PID $p : NOA_DB_PATH MISSING in process env" >&2
  fi
done
[ "$ok_env" = "1" ] || { echo "[verify] FAIL (A): no dashboard server process has NOA_DB_PATH in its env" >&2; exit 1; }

echo "[verify] (B) a live kanban write lands in noa.db (not claudeclaw.db)"
PROBE_TITLE="__cutover-verify-probe-$$"
CID=$(python3 - "$TOKEN" "$BASE" "$PROBE_TITLE" <<'PY'
import urllib.request, json, sys
tok, base, title = sys.argv[1], sys.argv[2], sys.argv[3]
body=json.dumps({"title":title,"description":"cutover verify probe; auto-deleted","status":"planned","priority":"low","assignee":"dave"}).encode()
req=urllib.request.Request(base+"/api/kanban", data=body, headers={"Content-Type":"application/json","Authorization":"Bearer "+tok}, method="POST")
print(json.load(urllib.request.urlopen(req))["id"])
PY
)
echo "  probe card id: $CID"
in_noa=$(node -e "const D=require('better-sqlite3');const d=new D('store/noa.db',{readonly:true});console.log(d.prepare('SELECT COUNT(*) c FROM kanban_cards WHERE id=?').get(process.argv[1]).c)" "$CID")
in_claw=$(node -e "const D=require('better-sqlite3');const d=new D('store/claudeclaw.db',{readonly:true});console.log(d.prepare('SELECT COUNT(*) c FROM kanban_cards WHERE id=?').get(process.argv[1]).c)" "$CID")
echo "  probe card in noa.db=$in_noa  claudeclaw.db=$in_claw"
# cleanup the probe card via the live API (best-effort)
curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/kanban/$CID" || true
if [ "$in_noa" = "1" ] && [ "$in_claw" = "0" ]; then
  echo "[verify] PASS: main app writes to noa.db (cutover is LIVE)."
else
  echo "[verify] FAIL (B): write did NOT land in noa.db (in_noa=$in_noa, in_claw=$in_claw) -- main app NOT on noa.db" >&2
  exit 1
fi
