#!/usr/bin/env python3
"""DA post-run finding-followup check (card 76c6be72).

Heartbeat task: scheduled at T+72h after a DA run with CRITICAL/HIGH BLOCK
findings. Checks whether the triggering agent has replied. If not, sends a
follow-up message with the still-open findings and self-deletes.

Called by a scheduled heartbeat task. Self-deletes after firing once
(i.e., after the 72h window has elapsed, regardless of reply status).

Usage (from scheduled task prompt):
    python3 scripts/da-followup-check.py \
        --sentinel store/da-runs/T3-abc12345.json \
        --task-name da-followup-T3-abc12345 \
        --triggering-agent dave \
        --run-ts 1790000000 \
        --token-file store/.dashboard-token

Exit codes: always 0 (heartbeat -- never blocks).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from typing import Any

FOLLOWUP_DELAY_SECONDS = 72 * 3600  # 72h


# --------------------------------------------------------------------------- #
# Pure logic helpers (testable without I/O)
# --------------------------------------------------------------------------- #

def should_schedule_followup(sentinel: dict) -> bool:
    """Return True if this run warrants a follow-up task."""
    return (
        sentinel.get("critical_count", 0) > 0
        or sentinel.get("high_block_count", 0) > 0
    )


def followup_task_name(trigger: str, run_id: str) -> str:
    """Return the canonical follow-up task name for a run."""
    return f"da-followup-{trigger}-{run_id}"


def build_followup_sentinel_fields(*, scheduled: bool, task_name: str) -> dict:
    """Return the follow_up_* fields to merge into a sentinel JSON."""
    if scheduled:
        return {
            "follow_up_scheduled": True,
            "follow_up_task_name": task_name,
        }
    return {
        "follow_up_scheduled": False,
        "follow_up_task_name": "",
    }


def get_open_critical_high(sentinel: dict) -> list[dict]:
    """Return findings that are CRITICAL (any verdict) or HIGH BLOCK."""
    findings = sentinel.get("findings", [])
    result = []
    for f in findings:
        sev = f.get("severity", "").upper()
        verdict = f.get("verdict", "").upper()
        if sev == "CRITICAL":
            result.append(f)
        elif sev == "HIGH" and "BLOCK" in verdict:
            result.append(f)
    return result


# --------------------------------------------------------------------------- #
# I/O helpers (injectable for testing)
# --------------------------------------------------------------------------- #

def check_for_reply(api_base: str, token: str, agent: str, run_ts: int) -> bool:
    """Return True if `agent` sent a message to devil-advocate after `run_ts`."""
    url = f"{api_base}/api/messages?agent=devil-advocate&limit=50"
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        data = json.loads(urllib.request.urlopen(req, timeout=10).read())
        msgs = data if isinstance(data, list) else data.get("messages", [])
        for m in msgs:
            sender = m.get("from_agent", "")
            ts = m.get("created_at", 0)
            if sender == agent and ts > run_ts:
                return True
    except Exception as exc:
        print(f"[da-followup] check_for_reply error: {exc}", file=sys.stderr)
    return False


def send_followup_message(
    api_base: str,
    token: str,
    agent: str,
    findings: list[dict],
    sentinel: dict,
) -> None:
    """Send a follow-up inter-agent message to `agent` about open findings."""
    trigger = sentinel.get("trigger", "T?")
    run_id = sentinel.get("id", sentinel.get("decision_id", "?"))
    lines = [
        f"DA follow-up ({trigger}-{run_id}): 72h elapsed, no reply found. "
        "Still-open CRITICAL/HIGH BLOCK findings:"
    ]
    for f in findings:
        lines.append(f"  [{f.get('verdict','?')}] {f.get('id','?')} -- "
                     f"{f.get('severity','?')}: {f.get('label','')}")
    lines.append("Please acknowledge or report status.")
    content = "\n".join(lines)

    body = json.dumps({"from": "devil-advocate", "to": agent, "content": content}).encode()
    req = urllib.request.Request(
        f"{api_base}/api/messages",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=10)


def delete_task(api_base: str, token: str, task_name: str) -> None:
    """Self-delete via DELETE /api/schedules/{task_name}."""
    req = urllib.request.Request(
        f"{api_base}/api/schedules/{task_name}",
        headers={"Authorization": f"Bearer {token}"},
        method="DELETE",
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise


# --------------------------------------------------------------------------- #
# Main logic
# --------------------------------------------------------------------------- #

def run_followup_check(
    *,
    sentinel_path: str,
    task_name: str,
    triggering_agent: str,
    run_ts: int,
    api_base: str,
    token: str,
    _now: int | None = None,
) -> str:
    """Run the follow-up check. Returns 'too-early', 'replied', or 'sent'."""
    now = _now if _now is not None else int(time.time())
    elapsed = now - run_ts

    if elapsed < FOLLOWUP_DELAY_SECONDS:
        print(f"[da-followup] {elapsed}s elapsed, waiting for {FOLLOWUP_DELAY_SECONDS}s")
        return "too-early"

    sentinel = json.loads(open(sentinel_path).read())
    findings = get_open_critical_high(sentinel)

    tok = open(token).readline().strip()

    if check_for_reply(api_base, tok, triggering_agent, run_ts):
        print(f"[da-followup] Reply found from {triggering_agent}, no follow-up needed")
        delete_task(api_base, tok, task_name)
        return "replied"

    if findings:
        send_followup_message(api_base, tok, triggering_agent, findings, sentinel)
        print(f"[da-followup] Follow-up sent to {triggering_agent} ({len(findings)} findings)")
    else:
        print("[da-followup] No CRITICAL/HIGH BLOCK findings in sentinel, skipping message")

    delete_task(api_base, tok, task_name)
    return "sent"


def main() -> None:
    parser = argparse.ArgumentParser(description="DA follow-up check heartbeat")
    parser.add_argument("--sentinel", required=True, help="Path to sentinel JSON")
    parser.add_argument("--task-name", required=True, help="Scheduled task name (for self-delete)")
    parser.add_argument("--triggering-agent", required=True)
    parser.add_argument("--run-ts", type=int, required=True, help="Run completed_at unix epoch")
    parser.add_argument("--api-base", default="http://localhost:3420")
    parser.add_argument("--token-file", default="store/.dashboard-token")
    args = parser.parse_args()

    run_followup_check(
        sentinel_path=args.sentinel,
        task_name=args.task_name,
        triggering_agent=args.triggering_agent,
        run_ts=args.run_ts,
        api_base=args.api_base,
        token=args.token_file,
    )


if __name__ == "__main__":
    main()
