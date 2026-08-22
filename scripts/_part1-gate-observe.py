#!/usr/bin/env python3
"""Observe the state of Buster's latest Telegram `reply` tool call, for the Part 1
empirical gate (card 4525ff36). Reads Buster's OWN transcript (the agent-buster
project under the shared ~/.claude/projects symlink) and reports whether the most
recent reply call -- attempted at/after --since -- has SUCCEEDED, FAILED, is still
CALLED (in-flight / hung), or did not happen (NONE).

This is the disambiguation the v1 run lacked: it lets the harness confirm the
reply was attempted WHILE the pipe was wedged, and classify fail-vs-hang-vs-success
instead of guessing from a hook marker alone.

Usage: _part1-gate-observe.py [--since EPOCH]
Prints one line: STATE=<none|called|success|failed> detail=<...>
"""
import sys
import os
import json
import glob
from datetime import datetime, timezone

REPLY_TOOL = "mcp__plugin_telegram_telegram__reply"
PROJ_DIR = os.path.expanduser("~/.claude/projects/-home-domin-marveen-agents-buster")
FAIL_MARKERS = ("text.length", "undefined is not an object")


def parse_since():
    for i, a in enumerate(sys.argv):
        if a == "--since" and i + 1 < len(sys.argv):
            try:
                return float(sys.argv[i + 1])
            except ValueError:
                return 0.0
    return 0.0


def ts_epoch(o):
    t = o.get("timestamp")
    if not t:
        return 0.0
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def main():
    since = parse_since()
    files = glob.glob(os.path.join(PROJ_DIR, "*.jsonl"))
    if not files:
        print("STATE=none detail=no-buster-transcript")
        return
    latest = max(files, key=os.path.getmtime)

    reply_uses = []  # (epoch, tool_use_id)
    results = {}     # tool_use_id -> (is_error, text)
    for ln in open(latest, encoding="utf-8", errors="replace"):
        try:
            o = json.loads(ln)
        except Exception:
            continue
        msg = o.get("message", {})
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        ep = ts_epoch(o)
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use" and c.get("name") == REPLY_TOOL:
                if ep >= since:
                    reply_uses.append((ep, c.get("id")))
            elif c.get("type") == "tool_result":
                tid = c.get("tool_use_id")
                body = c.get("content")
                txt = body if isinstance(body, str) else json.dumps(body)
                results[tid] = (bool(c.get("is_error")), txt or "")

    if not reply_uses:
        print("STATE=none detail=no-reply-call-since-trigger")
        return
    reply_uses.sort()
    _, tid = reply_uses[-1]
    if tid not in results:
        print(f"STATE=called detail=in-flight-or-hung(no-result-for {tid})")
        return
    is_err, txt = results[tid]
    low = txt.lower()
    if is_err or any(m in low for m in FAIL_MARKERS):
        print(f"STATE=failed detail={txt[:160].replace(chr(10),' ')}")
    else:
        print(f"STATE=success detail={txt[:120].replace(chr(10),' ')}")


if __name__ == "__main__":
    main()
