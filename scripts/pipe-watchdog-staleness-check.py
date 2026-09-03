#!/usr/bin/env python3
"""Pipe-watchdog staleness check (n8n Tier-A, card cd2bd7b9).

Reads store/pipe-watchdog.*.state.json and store/telegram-pipe-watchdog.state.json.
Alerts marveen (inter-agent) if any agent has:
  - consecutiveDead >= 2 (sustained dead: 2+ consecutive probes, ~10 min), OR
  - lastHealthyTs older than STALE_THRESHOLD AND lastCheckedTs recent (watchdog active)

Additionally (OPS-166, belt-and-suspenders): if the marveen main pipe
(telegram-pipe-watchdog.state.json) reports its FIRST dead cycle
(consecutiveDead >= 1), fire the n8n telegram-heal webhook immediately for a
reliable hard-respawn, instead of only pinging marveen at the >=2 stale
threshold. This is an INDEPENDENT detection source from the in-CLI 409 verdict
the telegram-pipe-watchdog itself uses; downstream is debounced by the
dashboard's post-respawn grace, and we additionally debounce per
HEAL_WEBHOOK_SUPPRESS_SECONDS so a cron cadence can't storm the webhook.

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
CHECKED_WINDOW_MS = 2 * 60 * 60 * 1000  # watchdog must have checked within 2h
REALERT_SUPPRESS_SECONDS = 23 * 3600    # suppress repeat alert within 23h
DEFAULT_STATE_FILE = "store/.pipe-watchdog-staleness-state.json"
DEFAULT_TOKEN = "store/.dashboard-token"
DEFAULT_FROM = "forge"

# OPS-166 immediate heal webhook (n8n telegram-heal -> dashboard hard-respawn).
HEAL_WEBHOOK_URL = "http://127.0.0.1:5678/webhook/telegram-heal"
HEAL_WEBHOOK_SUPPRESS_SECONDS = 6 * 60  # match dashboard post-respawn grace; no storm
HEAL_AGENT = "telegram"  # only the marveen main pipe drives the immediate heal webhook


def should_fire_heal(agent: str, consecutive_dead: int, now_s: int,
                     suppress_state: dict,
                     suppress_seconds: int = HEAL_WEBHOOK_SUPPRESS_SECONDS) -> bool:
    """Return True if this agent's dead detection should fire the heal webhook.

    Only the marveen main (telegram) pipe qualifies -- forge's own pipe is
    covered by the channel-health-monitor while the dashboard is up (out of
    scope, per OPS-166). Fires from the FIRST dead cycle (>=1), not the >=2
    stale threshold. Debounced by suppress_seconds keyed on ``heal:<agent>``.
    """
    if agent != HEAL_AGENT:
        return False
    if consecutive_dead < 1:
        return False
    last = suppress_state.get(f"heal:{agent}", 0)
    return (now_s - last) >= suppress_seconds


def fire_heal_webhook(url: str = HEAL_WEBHOOK_URL, timeout: int = 10) -> int:
    """POST the n8n telegram-heal webhook (immediate hard-respawn). Returns HTTP status."""
    payload = json.dumps({
        "reason": "pipe-watchdog-staleness-check: consecutiveDead>=1",
        "source": "staleness-check",
    }).encode()
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status


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
    heal_candidates: list[tuple[str, int]] = []  # (agent, consecutiveDead) for OPS-166 webhook

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

        # OPS-166: any fresh-checked pipe on its first dead cycle is a heal
        # candidate; should_fire_heal() gates it to the marveen main pipe only.
        if consecutive_dead >= 1:
            heal_candidates.append((agent, consecutive_dead))

        age_ms = now_ms - last_healthy
        if consecutive_dead >= 2 or age_ms > stale_threshold_ms:
            stale_agents.append(f"{agent}(dead={consecutive_dead},age={age_ms//60000}m)")
            print(f"[{agent}] STALE consecutiveDead={consecutive_dead} age={age_ms//60000}m")
        else:
            ok_agents.append(agent)
            print(f"[{agent}] ok (age={age_ms//60000}m)")

    # Suppression state is shared by the heal-webhook debounce (heal:<agent>)
    # and the stale re-alert debounce (<agent>). Dry-run never reads/persists it.
    suppress_state = {} if args.dry_run else load_state_file(args.state)
    state_dirty = False
    rc = 0

    # OPS-166: immediate heal webhook on the marveen main pipe's first dead cycle.
    for agent, cdead in heal_candidates:
        if not should_fire_heal(agent, cdead, now_s, suppress_state):
            continue
        if args.dry_run:
            print(f"DRY-RUN would fire heal webhook for {agent} (consecutiveDead={cdead})")
            continue
        try:
            status = fire_heal_webhook()
            suppress_state[f"heal:{agent}"] = now_s
            state_dirty = True
            print(f"Heal webhook fired for {agent} (HTTP {status}, consecutiveDead={cdead})")
        except Exception as e:
            # Belt-and-suspenders: the periodic telegram-pipe-watchdog still
            # covers recovery, so a webhook miss is logged, not fatal.
            print(f"Heal webhook FAILED for {agent}: {e}", file=sys.stderr)

    # Stale inter-agent alert (>=2 sustained, or aged past threshold).
    if stale_agents:
        to_alert = []
        for entry in stale_agents:
            agent = entry.split("(")[0]
            last_alert = suppress_state.get(agent, 0)
            if (now_s - last_alert) < REALERT_SUPPRESS_SECONDS:
                print(f"[{agent}] STALE -> suppressed (alerted {now_s - last_alert}s ago)")
            else:
                to_alert.append((agent, entry))

        if to_alert:
            content = ("Pipe-watchdog STALE: "
                       + "; ".join(e for _, e in to_alert)
                       + ". /mcp reconnect szukseges.")
            if args.dry_run:
                print(f"DRY-RUN would alert: {content}")
            else:
                try:
                    token = Path(args.token_file).read_text().strip()
                    status = send_inter_agent(content, token, args.sender)
                    for agent, _ in to_alert:
                        suppress_state[agent] = now_s
                    state_dirty = True
                    print(f"Alert sent (HTTP {status}): {', '.join(a for a, _ in to_alert)}")
                except Exception as e:
                    print(f"Alert send FAILED: {e}", file=sys.stderr)
                    rc = 1
    else:
        print(f"All pipe-watchdog states healthy ({len(ok_agents)} ok, {len(skipped_agents)} skipped).")

    if not args.dry_run and state_dirty:
        try:
            Path(args.state).write_text(json.dumps(suppress_state))
        except OSError as e:
            print(f"warning: state persist failed: {e}", file=sys.stderr)

    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
