#!/usr/bin/env python3
"""
n8n ghost-trigger auto-flush (card a9e4e35e, fleet-supervisor §6.9).

Called by fleet-supervisor check_n8n_ghosts every 30 min when n8n is alive.
Detects workflows that are active=0 in DB but fired trigger-mode executions
since the running n8n process booted (ghost state = n8n in-memory cache drift).

On detection:
  - Flushes each ghost via API activate -> deactivate (same fix as OPS-083 manual)
  - Alerts marveen via dashboard inter-agent (suppressed: once per n8n boot epoch)
  - Logs findings to stdout (fleet-supervisor redirects to store/n8n-ghost-flush.log)

Exit 0 always (never crash the supervisor tick).
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

N8N_DB = os.path.expanduser("~/.n8n/.n8n/database.sqlite")
INSTALL_DIR = Path(__file__).resolve().parent.parent
STORE = INSTALL_DIR / "store"
STATE_FILE = STORE / ".n8n-ghost-flush.state"
DASHBOARD_TOKEN_FILE = STORE / ".dashboard-token"
MESSAGES_URL = "http://localhost:3420/api/messages"
N8N_BASE = "http://127.0.0.1:5678/api/v1"
LOG_MAX_LINES = 500


def _n8n_boot_epoch() -> float | None:
    try:
        pid = subprocess.check_output(["pgrep", "-f", "n8n start"], text=True).split()[0]
        with open(f"/proc/{pid}/stat") as f:
            starttime = int(f.read().split()[21])
        hz = os.sysconf("SC_CLK_TCK")
        with open("/proc/uptime") as f:
            uptime = float(f.read().split()[0])
        boot_wall = datetime.now(timezone.utc).timestamp() - uptime
        return boot_wall + starttime / hz
    except Exception:
        return None


def _find_ghosts(boot_iso: str) -> list[dict]:
    try:
        con = sqlite3.connect(f"file:{N8N_DB}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        wfs = con.execute(
            "SELECT id, name FROM workflow_entity WHERE active=0"
        ).fetchall()
        ghosts = []
        for w in wfs:
            n = con.execute(
                "SELECT COUNT(*) c FROM execution_entity "
                "WHERE workflowId=? AND mode='trigger' AND startedAt > ?",
                (w["id"], boot_iso),
            ).fetchone()["c"]
            if n > 0:
                ghosts.append({"id": w["id"], "name": w["name"], "exec_count": n})
        con.close()
        return ghosts
    except Exception as e:
        print(f"[ghost-flush] DB read error: {e}", file=sys.stderr)
        return []


def _get_n8n_api_key() -> str | None:
    try:
        con = sqlite3.connect(f"file:{N8N_DB}?mode=ro", uri=True)
        row = con.execute(
            "SELECT apiKey FROM user_api_keys WHERE label='forge-automation'"
        ).fetchone()
        con.close()
        return row[0] if row else None
    except Exception:
        return None


def _n8n_post(url: str, api_key: str) -> int:
    req = urllib.request.Request(
        url, data=b"{}",
        headers={"X-N8N-API-KEY": api_key, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return r.status


def _flush_ghost(wf_id: str, api_key: str) -> bool:
    """Activate then deactivate to flush ghost state.

    Guard: if activate succeeds but deactivate fails, we retry once and, on
    continued failure, attempt a forced deactivate + emit a loud alert so the
    workflow does not remain live. Returns True only when deactivate confirmed.
    """
    activate_url = f"{N8N_BASE}/workflows/{wf_id}/activate"
    deactivate_url = f"{N8N_BASE}/workflows/{wf_id}/deactivate"

    # Step 1: activate
    try:
        status = _n8n_post(activate_url, api_key)
        if status not in (200, 201):
            print(f"[ghost-flush] {wf_id} activate: unexpected HTTP {status}")
            return False
    except Exception as e:
        print(f"[ghost-flush] {wf_id} activate FAILED: {e}")
        return False

    # Step 2: deactivate (retry once; on failure force-deactivate + loud alert)
    for attempt in range(2):
        try:
            status = _n8n_post(deactivate_url, api_key)
            if status in (200, 201):
                return True
            print(f"[ghost-flush] {wf_id} deactivate attempt {attempt+1}: HTTP {status}")
        except Exception as e:
            print(f"[ghost-flush] {wf_id} deactivate attempt {attempt+1} FAILED: {e}")

    # Deactivate failed twice: workflow may be live. Force a final attempt and alert.
    print(f"[ghost-flush] CRITICAL: {wf_id} deactivate failed after activate -- "
          "workflow may be LIVE; forcing final deactivate attempt")
    try:
        _n8n_post(deactivate_url, api_key)
    except Exception as e:
        print(f"[ghost-flush] {wf_id} forced deactivate also FAILED: {e}")
    # Return False so caller marks this ghost as not cleanly flushed
    return False


def _alert_marveen(ghosts: list[dict], boot_epoch: float) -> None:
    try:
        token = DASHBOARD_TOKEN_FILE.read_text().strip()
    except OSError:
        print("[ghost-flush] dashboard token not found, skipping alert")
        return
    names = ", ".join(f"{g['name']} ({g['exec_count']} execs)" for g in ghosts)
    content = (
        f"n8n ghost-flush AUTO: {len(ghosts)} ghost workflow(s) gedetektalt es kiflusholt "
        f"(boot={datetime.fromtimestamp(boot_epoch, timezone.utc).strftime('%Y-%m-%dT%H:%MZ')}): "
        f"{names}. Tartos torlese ajanlott ha visszater."
    )
    data = json.dumps({"from": "forge", "to": "marveen", "content": content}).encode()
    req = urllib.request.Request(
        MESSAGES_URL,
        data=data,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        print(f"[ghost-flush] marveen alert sent HTTP {r.status}")


def _load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _save_state(state: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state))
    except OSError as e:
        print(f"[ghost-flush] state write failed: {e}", file=sys.stderr)


def _rotate_log(log_path: Path, max_lines: int = LOG_MAX_LINES) -> None:
    """Trim log to last max_lines lines to prevent unbounded growth (OPS-092)."""
    try:
        if not log_path.exists():
            return
        lines = log_path.read_text(errors="replace").splitlines(keepends=True)
        if len(lines) > max_lines:
            log_path.write_text("".join(lines[-max_lines:]))
    except OSError:
        pass


def main() -> int:
    now = time.time()
    boot = _n8n_boot_epoch()
    if boot is None:
        print("[ghost-flush] n8n process not found, skipping")
        return 0

    # Format must match execution_entity.startedAt TEXT: '2026-08-02 12:30:00.047'
    # (space separator, ms precision, no TZ offset -- TypeORM UTC default).
    # datetime.isoformat() produces '...T...+00:00' which string-compares GREATER
    # than any space-separated timestamp on the same UTC day, hiding same-day ghosts.
    boot_iso = datetime.fromtimestamp(boot, timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    ghosts = _find_ghosts(boot_iso)

    if not ghosts:
        print(f"[ghost-flush] {datetime.now(timezone.utc).strftime('%H:%M:%SZ')} clean -- 0 ghosts")
        return 0

    print(f"[ghost-flush] {len(ghosts)} ghost(s) found: {[g['id'] for g in ghosts]}")

    api_key = _get_n8n_api_key()
    if not api_key:
        print("[ghost-flush] no n8n API key found, cannot flush")
        return 0

    flushed = []
    for g in ghosts:
        ok = _flush_ghost(g["id"], api_key)
        if ok:
            flushed.append(g)
            print(f"[ghost-flush] flushed {g['id']} ({g['name']})")
        else:
            print(f"[ghost-flush] flush FAILED for {g['id']}")

    if not flushed:
        return 0

    # Alert marveen once per n8n boot session (suppress repeats for same boot)
    state = _load_state()
    alerted_boot = state.get("alerted_boot_epoch", 0)
    # Boot epochs drift by <1s due to float arithmetic; use 10s tolerance
    if abs(alerted_boot - boot) > 10:
        try:
            _alert_marveen(flushed, boot)
            state["alerted_boot_epoch"] = boot
            state["last_flush_epoch"] = now
            _save_state(state)
        except Exception as e:
            print(f"[ghost-flush] alert failed: {e}", file=sys.stderr)
    else:
        print("[ghost-flush] alert suppressed (already alerted for this boot session)")
        state["last_flush_epoch"] = now
        _save_state(state)

    _rotate_log(STORE / "n8n-ghost-flush.log")
    return 0


if __name__ == "__main__":
    sys.exit(main())
