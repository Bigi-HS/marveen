#!/usr/bin/env python3
"""forge-health-check.py -- F1-F4 SRE health probe for the forge agent.

Designed for */10 min heartbeat scheduling. Contract:
  exit 0  -- all checks green; SILENT (no output).
  exit 1  -- at least one check RED; alert already sent to marveen
             via inter-agent message + written to forge daily-log.

Checks (forge SRE spec, OPS/dc178f99):
  F1  Server alive   -- GET /api/agents -> HTTP 200 + valid JSON
  F2  Sessions live  -- tmux session agent-forge exists + forge-watchdog.sh running
  F3  Channel healthy -- forge channelHealthy == True (False = channel down, FAIL)
  F4  Token vault    -- store/.dashboard-token present + non-empty
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

DASHBOARD_URL = "http://127.0.0.1:3420"
TOKEN_FILE = "/home/domin/marveen/store/.dashboard-token"
FORGE_SESSION = "agent-forge"
FORGE_WATCHDOG_PATTERN = "forge-watchdog.sh"

def read_token():
    try:
        val = open(TOKEN_FILE).read().strip()
        return val if val else None
    except OSError:
        return None


def check_f1_server(token):
    """F1: dashboard server up -- GET /api/agents returns 200 + valid JSON."""
    try:
        req = urllib.request.Request(
            f"{DASHBOARD_URL}/api/agents",
            headers={"Authorization": f"Bearer {token}"},
        )
        resp = urllib.request.urlopen(req, timeout=5)
        if resp.status != 200:
            return False, f"HTTP {resp.status}"
        json.loads(resp.read())
        return True, "ok"
    except Exception as exc:
        return False, str(exc)


def check_f2_sessions():
    """F2: forge tmux session alive + forge-watchdog.sh process running."""
    r_tmux = subprocess.run(
        ["tmux", "has-session", "-t", f"={FORGE_SESSION}"],
        capture_output=True,
    )
    if r_tmux.returncode != 0:
        return False, f"tmux session {FORGE_SESSION} missing"
    r_pgrep = subprocess.run(
        ["pgrep", "-f", FORGE_WATCHDOG_PATTERN],
        capture_output=True,
    )
    if r_pgrep.returncode != 0:
        return False, "forge-watchdog.sh not running (no PID)"
    return True, "ok"


def check_f3_channel(token, agents):
    """F3: forge channelHealthy is True.

    channelHealthy=False means the Telegram channel is down (FAIL).
    Missing field also treated as FAIL (unknown state).
    """
    forge = next((a for a in agents if a.get("name") == "forge"), None)
    if forge is None:
        return False, "forge agent not found in /api/agents"
    if "channelHealthy" not in forge:
        return False, "channelHealthy field missing from agent record"
    healthy = forge["channelHealthy"]
    if healthy:
        return True, "channelHealthy=True"
    return False, "channelHealthy=False"


def check_f4_token():
    """F4: store/.dashboard-token present + non-empty."""
    try:
        content = open(TOKEN_FILE).read().strip()
        if not content:
            return False, "token file is empty"
        return True, "ok"
    except OSError as exc:
        return False, str(exc)


def send_alert(token, failed_checks):
    """Send inter-agent alert to marveen + append to forge daily-log."""
    summary = "; ".join(f"F{n} {desc}" for n, desc in failed_checks)
    alert_text = f"forge-health-check FAILED: {summary}"

    for endpoint, payload_dict in (
        (
            f"{DASHBOARD_URL}/api/messages",
            {"from": "forge", "to": "marveen", "content": alert_text, "priority": "high"},
        ),
        (
            f"{DASHBOARD_URL}/api/daily-log",
            {"agent_id": "forge", "content": f"## forge-health-check\n{alert_text}"},
        ),
    ):
        try:
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(payload_dict).encode(),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {token}",
                },
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as exc:
            sys.stderr.write(f"forge-health-check: alert delivery failed ({endpoint}): {exc}\n")


def main():
    token = read_token()
    if not token:
        sys.stderr.write("forge-health-check: cannot read dashboard token -- aborting\n")
        sys.exit(1)

    failed = []

    ok1, detail1 = check_f1_server(token)
    if not ok1:
        failed.append((1, f"server: {detail1}"))

    # Fetch agents list once; reuse for F3.
    agents = []
    try:
        req = urllib.request.Request(
            f"{DASHBOARD_URL}/api/agents",
            headers={"Authorization": f"Bearer {token}"},
        )
        resp = urllib.request.urlopen(req, timeout=5)
        agents = json.loads(resp.read())
    except Exception:
        pass  # F1 already captured this failure if applicable

    ok2, detail2 = check_f2_sessions()
    if not ok2:
        failed.append((2, detail2))

    ok3, detail3 = check_f3_channel(token, agents)
    if not ok3:
        failed.append((3, detail3))

    ok4, detail4 = check_f4_token()
    if not ok4:
        failed.append((4, detail4))

    if failed:
        send_alert(token, failed)
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
