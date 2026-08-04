#!/usr/bin/env python3
"""MCP health-probe for the marveen heartbeat (card d99be4e4).

Checks the orchestrator's Telegram pipe health from the watchdog state file.
If the pipe is dead or stale:
  1. Sends a fleet-alert inter-agent message to forge.
  2. Launches orchestrator-mcp-reconnect.sh in the background (non-blocking).
  3. Exits 1 so the heartbeat caller knows the pipe had a problem.

If healthy: prints one status line and exits 0.

Exit codes:
  0 -- pipe healthy (or state file missing = unknown, treated as OK)
  1 -- pipe dead/stale, alert sent, reconnect launched
  2 -- config/env error (non-fatal, heartbeat continues)
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

STATE_FILE = os.path.join(PROJECT_ROOT, "store", "telegram-pipe-watchdog.state.json")
TOKEN_FILE = os.path.join(PROJECT_ROOT, "store", ".dashboard-token")
RECONNECT_SH = os.path.join(SCRIPT_DIR, "orchestrator-mcp-reconnect.sh")
DASH = "http://localhost:3420"

# Thresholds
DEAD_CONSECUTIVE = 2       # consecutiveDead >= this -> dead
STALE_HEALTHY_MS = 10 * 60 * 1000  # lastHealthyTs older than 10 min -> stale (watchdog runs every 60s)


def read_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception as e:
        print(f"mcp-health-probe: state read error: {e}", file=sys.stderr)
        return None


def send_inter_agent(token, msg):
    body = json.dumps({"from": "marveen", "to": "forge", "content": msg}).encode()
    req = urllib.request.Request(
        DASH + "/api/messages",
        data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except Exception as e:
        print(f"mcp-health-probe: inter-agent send failed: {e}", file=sys.stderr)
        return None


def launch_reconnect():
    if not os.path.exists(RECONNECT_SH):
        print(f"mcp-health-probe: reconnect script not found: {RECONNECT_SH}", file=sys.stderr)
        return False
    try:
        subprocess.Popen(
            ["bash", RECONNECT_SH],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True
    except Exception as e:
        print(f"mcp-health-probe: reconnect launch failed: {e}", file=sys.stderr)
        return False


def main():
    state = read_state()
    if state is None:
        # No state file -- pipe watchdog not yet run or fresh start; treat as OK.
        print("mcp-health-probe: state file missing, skipping (OK)")
        return 0

    consecutive_dead = state.get("consecutiveDead", 0)
    last_healthy_ts = state.get("lastHealthyTs", 0)
    now_ms = int(time.time() * 1000)
    staleness_ms = now_ms - last_healthy_ts

    dead_by_count = consecutive_dead >= DEAD_CONSECUTIVE
    dead_by_stale = staleness_ms > STALE_HEALTHY_MS

    if not dead_by_count and not dead_by_stale:
        age_s = staleness_ms // 1000
        print(f"mcp-health-probe: pipe OK (consecutiveDead={consecutive_dead}, lastHealthy={age_s}s ago)")
        return 0

    # Dead signal
    reason_parts = []
    if dead_by_count:
        reason_parts.append(f"consecutiveDead={consecutive_dead}")
    if dead_by_stale:
        reason_parts.append(f"lastHealthyTs={staleness_ms // 1000}s ago")
    reason = ", ".join(reason_parts)

    print(f"mcp-health-probe: DEAD PIPE detected ({reason}) -- alerting + reconnect")

    try:
        token = open(TOKEN_FILE).read().strip()
    except Exception:
        print("mcp-health-probe: cannot read dashboard token, skipping alert", file=sys.stderr)
        return 2

    alert_msg = (
        f"MCP health-probe: Telegram pipe DEAD ({reason}). "
        f"Auto-reconnect inditva. Ha 5 percen belul nem gyogyul, /mcp kell a marveen-channels-ban."
    )
    send_inter_agent(token, alert_msg)
    launch_reconnect()

    return 1


if __name__ == "__main__":
    sys.exit(main())
