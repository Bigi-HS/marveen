#!/usr/bin/env python3
"""PostToolUse hook: emit a tool-call event to the P0 telemetry bus.

On every tool call this posts a Tier-A (best-effort, fire-and-forget) event
to POST /api/telemetry. A failure here MUST NOT block the tool call -- this
hook always exits 0.

Event shape:
  actor       -- GENESIS_AGENT_ID env (or 'unknown')
  verb        -- 'tool-call'
  object      -- tool_name
  object_type -- 'tool'
  status      -- 'ok' | 'error'
  meta        -- {session_id, event_key (Tier-A: omitted)}

Tier-A (best-effort): no outbox, no retry, server-down = event silently lost.
This is intentional for high-volume tool-call events whose loss does not distort
the neuron-graph (statistical aggregation, 1 event loss per 1000 is acceptable).

Security: targets localhost only (loopback guard in /api/telemetry).
         Never sends raw tool input/output (only tool_name + success flag).

Wiring: add to .claude/settings.json PostToolUse:
  {"matcher": ".*", "hooks": [{"type": "command",
    "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/telemetry-emit.py\"",
    "timeout": 5}]}
"""
import json
import os
import sys
import urllib.parse
import urllib.request

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_TOKEN_PATH = os.path.join(INSTALL_DIR, 'store', '.dashboard-token')
DEFAULT_DASHBOARD_URL = 'http://localhost:3420'


def _read_token() -> str:
    token = os.environ.get('GENESIS_AGENT_TOKEN') or os.environ.get('BUSTER_CI_TOKEN')
    if token:
        return token
    path = os.environ.get('DASHBOARD_TOKEN_PATH', DEFAULT_TOKEN_PATH)
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return ''


def _infer_status(tool_response: object) -> str:
    if isinstance(tool_response, dict):
        if tool_response.get('error') or tool_response.get('is_error'):
            return 'error'
    return 'ok'


def build_event(hook_json: dict) -> dict | None:
    tool = hook_json.get('tool_name')
    if not isinstance(tool, str) or not tool.strip():
        return None
    actor = os.environ.get('GENESIS_AGENT_ID', 'unknown')
    session_id = hook_json.get('session_id', '')
    meta: dict = {}
    if isinstance(session_id, str) and session_id:
        meta['session_id'] = session_id
    return {
        'actor': actor,
        'verb': 'tool-call',
        'object': tool,
        'object_type': 'tool',
        'status': _infer_status(hook_json.get('tool_response')),
        'meta': meta if meta else None,
    }


def emit(event: dict) -> None:
    token = _read_token()
    if not token:
        return
    base = os.environ.get('DASHBOARD_URL', DEFAULT_DASHBOARD_URL).rstrip('/')
    parsed = urllib.parse.urlparse(base)
    if parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
        return
    payload = json.dumps(event).encode()
    req = urllib.request.Request(
        base + '/api/telemetry',
        data=payload,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as _:
            pass
    except Exception:
        pass  # fire-and-forget: a failed emit is never surfaced to the agent


def main() -> None:
    try:
        raw = sys.stdin.read()
        hook_json = json.loads(raw) if raw.strip() else {}
        event = build_event(hook_json)
        if event is not None:
            emit(event)
    except Exception:
        pass
    sys.exit(0)


if __name__ == '__main__':
    main()
