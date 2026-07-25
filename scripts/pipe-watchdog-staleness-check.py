#!/usr/bin/env python3
"""Pipe-watchdog staleness check (n8n Tier-A, card cd2bd7b9).

Reads store/pipe-watchdog.*.state.json and store/telegram-pipe-watchdog.state.json.
Alerts marveen (inter-agent) if any agent has:
  - consecutiveDead >= 2 (sustained dead: 2+ consecutive probes, ~10 min), OR
  - lastHealthyTs older than STALE_THRESHOLD AND lastCheckedTs recent (watchdog active)

Silent if all healthy. Re-alert suppressed within REALERT_SUPPRESS_SECONDS per agent.
--dry-run reports without sending.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

STORE = Path(os.environ.get("NOA_STORE", "store"))
MESSAGES_URL = "http://localhost:3420/api/messages"
STALE_MS = 90 * 60 * 1000          # 1.5h: pipe considered dropped
CHECKED_WINDOW_MS = 2 * 60 * 60 * 1000  # watchdog must have checked within 2h
REALERT_SUPPRESS_SECONDS = 23 * 3600    # suppress repeat alert within 23h
DEFAULT_STATE_FILE = "store/.pipe-watchdog-staleness-state.json"
DEFAULT_TOKEN = "store/.dashboard-token"
DEFAULT_FROM = "forge"


def load_state_file(path: str) -> dict:
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}


def send_inter_agent(content: str, token: str, sender: str = DEFAULT_FROM) -> int:
    data = json.dumps({"from": sender, "to": "marveen", "content": content}).encode()
    req = urllib.request.Request(
        MESSAGES_URL, data=data,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--store", default=str(STORE))
    p.add_argument("--state", default=DEFAULT_STATE_FILE)
    p.add_argument("--token-file", default=DEFAULT_TOKEN)
    p.add_argument("--from", dest="sender", default=DEFAULT_FROM)
    p.add_argument("--stale-minutes", type=int, default=90)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--now-ms", type=int, default=None)
    args = p.parse_args(argv)

    store_path = Path(args.store)
    now_ms = args.now_ms if args.now_ms is not None else int(time.time() * 1000)
    now_s = now_ms // 1000
    stale_threshold_ms = args.stale_minutes * 60 * 1000
    checked_window_ms = CHECKED_WINDOW_MS

    patterns = [
        str(store_path / "pipe-watchdog.*.state.json"),
        str(store_path / "telegram-pipe-watchdog.state.json"),
    ]
    files = []
    for pat in patterns:
        files.extend(glob.glob(pat))
    files = sorted(set(files))

    stale_agents: list[str] = []
    ok_agents: list[str] = []
    skipped_agents: list[str] = []

    for fpath in files:
        name = os.path.basename(fpath)
        if name == "telegram-pipe-watchdog.state.json":
            agent = "telegram"
        else:
            agent = name.replace("pipe-watchdog.", "").replace(".state.json", "")
        try:
            state = json.loads(Path(fpath).read_text())
        except Exception as e:
            print(f"[{agent}] read error: {e}", file=sys.stderr)
            continue

        last_healthy = state.get("lastHealthyTs", 0)
        last_checked = state.get("lastCheckedTs", last_healthy)
        consecutive_dead = state.get("consecutiveDead", 0)

        # Skip if watchdog itself hasn't checked recently (stale data, not stale pipe)
        if now_ms - last_checked > checked_window_ms:
            skipped_agents.append(agent)
            print(f"[{agent}] skip (watchdog last checked {(now_ms - last_checked)//60000}m ago)")
            continue

        age_ms = now_ms - last_healthy
        if consecutive_dead >= 2 or age_ms > stale_threshold_ms:
            stale_agents.append(f"{agent}(dead={consecutive_dead},age={age_ms//60000}m)")
            print(f"[{agent}] STALE consecutiveDead={consecutive_dead} age={age_ms//60000}m")
        else:
            ok_agents.append(agent)
            print(f"[{agent}] ok (age={age_ms//60000}m)")

    if not stale_agents:
        print(f"All pipe-watchdog states healthy ({len(ok_agents)} ok, {len(skipped_agents)} skipped).")
        return 0

    # Load suppression state
    suppress_state = {} if args.dry_run else load_state_file(args.state)

    to_alert = []
    for entry in stale_agents:
        agent = entry.split("(")[0]
        last_alert = suppress_state.get(agent, 0)
        if (now_s - last_alert) < REALERT_SUPPRESS_SECONDS:
            print(f"[{agent}] STALE -> suppressed (alerted {now_s - last_alert}s ago)")
        else:
            to_alert.append((agent, entry))

    if not to_alert:
        return 0

    alert_lines = [e for _, e in to_alert]
    content = "Pipe-watchdog STALE: " + "; ".join(alert_lines) + ". /mcp reconnect szukseges."

    if args.dry_run:
        print(f"DRY-RUN would alert: {content}")
        return 0

    try:
        token = Path(args.token_file).read_text().strip()
        status = send_inter_agent(content, token, args.sender)
        for agent, _ in to_alert:
            suppress_state[agent] = now_s
        print(f"Alert sent (HTTP {status}): {', '.join(a for a, _ in to_alert)}")
    except Exception as e:
        print(f"Alert send FAILED: {e}", file=sys.stderr)
        return 1

    try:
        Path(args.state).write_text(json.dumps(suppress_state))
    except OSError as e:
        print(f"warning: state persist failed: {e}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
