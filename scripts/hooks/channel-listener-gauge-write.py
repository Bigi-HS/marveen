#!/usr/bin/env python3
"""
PostToolUse hook: write a per-agent listener-alive gauge heartbeat.

Triggered after mcp__plugin_telegram_telegram__reply or __edit_message.
Writes /tmp/metrics/.agent-channel-{agent_id}.json to prove the channel
listener received and processed a Telegram interaction this cycle.

The gyore-watchdog (and other per-agent channel watchdogs) read this file
to detect listener drops: a stale heartbeat + alive tmux session = listener
dropped without killing the session.

State file format:
  { "connected": true, "last_event_ts": <epoch>, "agent_id": "<id>" }
"""
import json
import os
import re
import sys
import time
from pathlib import Path

METRICS_DIR = Path(os.environ.get('CHANNEL_GAUGE_METRICS_DIR', '/tmp/metrics'))
INSTALL_DIR = Path('/home/domin/marveen')


def _agent_id() -> str:
    cfg = os.environ.get('CLAUDE_CONFIG_DIR', '')
    m = re.search(r'/agents/([^/]+)', cfg)
    if m:
        return m.group(1)
    # Fallback: derive from cwd
    cwd = os.getcwd()
    m2 = re.search(r'/agents/([^/]+)', cwd)
    return m2.group(1) if m2 else 'unknown'


def main():
    agent_id = _agent_id()
    METRICS_DIR.mkdir(parents=True, exist_ok=True)
    state_file = METRICS_DIR / f'.agent-channel-{agent_id}.json'

    try:
        existing = json.loads(state_file.read_text()) if state_file.exists() else {}
    except (json.JSONDecodeError, OSError):
        existing = {}

    now = time.time()
    state = {
        'connected': True,
        'last_event_ts': now,
        'agent_id': agent_id,
        # accumulate event count from prior state
        'event_count': existing.get('event_count', 0) + 1,
    }
    try:
        state_file.write_text(json.dumps(state))
    except OSError as e:
        # Non-fatal: gauge write failure must not block the Telegram reply
        print(f'[listener-gauge] WARN: could not write {state_file}: {e}', file=sys.stderr)


if __name__ == '__main__':
    main()
