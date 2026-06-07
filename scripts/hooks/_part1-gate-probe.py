#!/usr/bin/env python3
"""Part 1 empirical-gate DIAGNOSTIC hook (card 4525ff36). NOT a production hook --
it is the instrument that answers the single Part 1 go/no-go question:

    Does a PostToolUseFailure hook FIRE when an MCP `reply` call fails because the
    Telegram MCP transport (the bun stdio socketpair) is WEDGED, and if so, what
    does its payload contain?

Wired (by the gate harness) as a `PostToolUseFailure` hook with matcher `mcp__.*`
in Buster's settings.json. On every fire it:
  - appends the FULL raw stdin payload + a timestamp to store/part1-gate-marker.jsonl
    (so we can inspect the exact schema -- tool_name, tool_result/error fields, etc.),
  - touches store/.part1-gate-hook-fired as a cheap boolean the harness can poll.

Always exits 0: a diagnostic must never block or alter the session under test.
It records EVERY MCP-tool failure it sees; the harness correlates by timestamp
around the deliberate wedge + reply trigger.
"""
import sys
import os
import json
from datetime import datetime

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MARKER = os.path.join(INSTALL_DIR, "store", "part1-gate-marker.jsonl")
FIRED_FLAG = os.path.join(INSTALL_DIR, "store", ".part1-gate-hook-fired")


def main():
    raw = ""
    try:
        raw = sys.stdin.read()
    except Exception:
        pass

    payload = None
    try:
        payload = json.loads(raw) if raw else None
    except Exception:
        payload = None

    tool = ""
    if isinstance(payload, dict):
        tool = payload.get("tool_name", "") or ""

    # Record everything (diagnostic). The harness filters by ts + tool when it
    # reads the marker; we do not gate here so we never miss a fire.
    rec = {
        "ts": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "tool_name": tool,
        "raw_keys": sorted(payload.keys()) if isinstance(payload, dict) else None,
        "payload": payload if payload is not None else raw,
    }
    try:
        with open(MARKER, "a") as f:
            f.write(json.dumps(rec) + "\n")
        with open(FIRED_FLAG, "a") as f:
            f.write(rec["ts"] + " " + tool + "\n")
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
