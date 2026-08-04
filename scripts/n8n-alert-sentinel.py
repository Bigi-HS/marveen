#!/usr/bin/env python3
"""
n8n false-alarm sentinel  (read-only, token-free, zero-LLM).

Recurring guard that catches the n8n alert pathologies we hit on 2026-07-31,
BEFORE they spam the Boss. Operationalizes the alert-false-alarm-audit + n8n-ops
forensics. Detects three classes:

  1. GHOST TRIGGER   -- workflow active=0 in the DB but has trigger-mode
                        executions since the running n8n booted (DB flag !=
                        in-memory registry). This is what fired wf-noa-003r hourly.
  2. CONFIG ANTIPATTERN -- an alert workflow whose probe HTTP Request node has
                        neverError=true WITHOUT fullResponse=true (the exact
                        codetree-class: IF on $json.statusCode that never exists
                        -> fires every run). Proactive: caught before it spams.
  3. ALERT SPAM      -- an alert node that ACTUALLY FIRED (verified by deflattening
                        execution_data.runData, not a byte-scan) >= THRESHOLD times
                        in the last WINDOW_H hours. Repeated same-source alerts =
                        probable false alarm or an unresolved incident that needs
                        a human either way.

Exit 0 always. Prints a JSON report to stdout. When run as a scheduled heartbeat
it should only surface to the Boss when findings is non-empty.

Usage: python3 scripts/n8n-alert-sentinel.py [--window-h 24] [--spam-threshold 3]
"""
import sqlite3, os, json, re, sys, subprocess, argparse
from datetime import datetime, timezone

DB = os.path.expanduser("~/.n8n/.n8n/database.sqlite")

# ---------- flatted deflatten (n8n execution_data.data format) ----------
def deflatten(flat):
    cache = {}
    def resolve(n):
        if isinstance(n, str) and n.isdigit() and int(n) < len(flat):
            i = int(n)
            if i in cache:
                return cache[i]
            return build(flat[i], i)
        return n
    def build(node, i):
        if isinstance(node, dict):
            out = {}; cache[i] = out
            for k, v in node.items():
                out[k] = resolve(v)
            return out
        if isinstance(node, list):
            out = []; cache[i] = out
            for v in node:
                out.append(resolve(v))
            return out
        cache[i] = node
        return node
    return resolve("0")

def n8n_boot_epoch():
    """Start time (epoch s) of the running n8n main process; None if not found."""
    try:
        pid = subprocess.check_output(["pgrep", "-f", "n8n start"], text=True).split()[0]
        # /proc/<pid>/stat field 22 = starttime in clock ticks since boot
        with open(f"/proc/{pid}/stat") as f:
            starttime = int(f.read().split()[21])
        hz = os.sysconf("SC_CLK_TCK")
        with open("/proc/uptime") as f:
            uptime = float(f.read().split()[0])
        boot_wall = datetime.now(timezone.utc).timestamp() - uptime
        return boot_wall + starttime / hz
    except Exception:
        return None

def is_alert_node(node):
    t = (node.get("type") or "").lower()
    p = node.get("parameters", {})
    url = json.dumps(p.get("url", ""))
    if "telegram" in t:
        return True
    if t.endswith("httprequest") and ("notify/telegram" in url or "/telegram" in url):
        return True
    return False

def http_probe_antipattern(node, workflow_refs_statuscode):
    """True ONLY for the real codetree-class bug: an httpRequest probe with
    neverError but NOT fullResponse, IN A WORKFLOW WHOSE IF/expressions reference
    `.statusCode` (which does not exist on the body when fullResponse is off ->
    the IF always fires). If nothing references `.statusCode`, neverError-without-
    fullResponse is the CORRECT design (branch on the parsed body) -> NOT flagged.
    This precision matters: a sentinel that cries wolf is itself a false alarm."""
    t = (node.get("type") or "").lower()
    if not t.endswith("httprequest"):
        return False
    resp = node.get("parameters", {}).get("options", {}).get("response", {}).get("response", {})
    return bool(resp.get("neverError")) and not resp.get("fullResponse") and workflow_refs_statuscode

def alert_fired(execdata_row):
    """Deflatten runData; return True if an alert node ran AND delivered."""
    try:
        root = deflatten(json.loads(execdata_row))
        rd = root.get("resultData", {}).get("runData", {})
        wf = root.get("workflowData", {})
        alert_names = {n["name"] for n in wf.get("nodes", []) if is_alert_node(n)}
        for name in alert_names:
            for run in rd.get(name, []) or []:
                if run.get("executionStatus") != "success":
                    continue
                out = json.dumps(run.get("data", {}))
                if "message_id" in out or '"ok":true' in out or '"ok": true' in out:
                    return True
        return False
    except Exception:
        return False

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window-h", type=int, default=24)
    ap.add_argument("--spam-threshold", type=int, default=3)
    args = ap.parse_args()

    findings = []
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    wfs = con.execute("SELECT id, name, active, nodes FROM workflow_entity").fetchall()
    boot = n8n_boot_epoch()
    boot_iso = datetime.fromtimestamp(boot, timezone.utc).isoformat() if boot else None

    # ---- 1. GHOST triggers: active=0 but trigger-execs since boot ----
    if boot_iso:
        for w in wfs:
            if w["active"]:
                continue
            n = con.execute(
                "SELECT COUNT(*) c FROM execution_entity "
                "WHERE workflowId=? AND mode='trigger' AND startedAt > ?",
                (w["id"], boot_iso),
            ).fetchone()["c"]
            if n > 0:
                findings.append({"class": "GHOST_TRIGGER", "severity": "high",
                                 "workflow": w["name"], "id": w["id"],
                                 "detail": f"active=0 but {n} trigger execs since boot {boot_iso}",
                                 "fix": "n8n-ops recipe 2: API activate->deactivate"})

    # ---- 2. CONFIG antipattern (only on workflows that CAN alert) ----
    for w in wfs:
        try:
            nodes = json.loads(w["nodes"])
        except Exception:
            continue
        if not any(is_alert_node(n) for n in nodes):
            continue
        refs_statuscode = "statusCode" in w["nodes"]
        for n in nodes:
            if http_probe_antipattern(n, refs_statuscode):
                findings.append({"class": "CONFIG_ANTIPATTERN", "severity": "medium",
                                 "workflow": w["name"], "id": w["id"], "node": n.get("name"),
                                 "detail": "httpRequest has neverError without fullResponse "
                                           "-> IF on $json.statusCode always fires (codetree-class)",
                                 "fix": "enable Full Response (fullResponse:true) or test the real body"})

    # ---- 3. ALERT SPAM: verified sends >= threshold in window ----
    cutoff = datetime.now(timezone.utc).timestamp() - args.window_h * 3600
    cutoff_iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
    for w in wfs:
        try:
            if not any(is_alert_node(n) for n in json.loads(w["nodes"])):
                continue
        except Exception:
            continue
        rows = con.execute(
            "SELECT ed.data FROM execution_entity e JOIN execution_data ed ON ed.executionId=e.id "
            "WHERE e.workflowId=? AND e.startedAt > ?", (w["id"], cutoff_iso)).fetchall()
        sent = sum(1 for r in rows if alert_fired(r["data"]))
        if sent >= args.spam_threshold:
            findings.append({"class": "ALERT_SPAM", "severity": "high",
                             "workflow": w["name"], "id": w["id"],
                             "detail": f"{sent} verified alert sends in last {args.window_h}h "
                                       f"(threshold {args.spam_threshold}) -- false alarm or unresolved incident",
                             "fix": "audit the alert condition (benign-state guard, dedup); "
                                    "see alert-false-alarm-audit + n8n-ops"})
    con.close()

    report = {
        "sentinel": "n8n-alert-sentinel",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "n8n_boot": boot_iso,
        "workflows_scanned": len(wfs),
        "window_h": args.window_h,
        "spam_threshold": args.spam_threshold,
        "findings": findings,
        "ok": len(findings) == 0,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
