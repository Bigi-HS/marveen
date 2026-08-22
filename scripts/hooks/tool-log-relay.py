#!/usr/bin/env python3
"""PostToolUse relay hook: stream tool activity to the dashboard hook-event feed.

Card 229a9000 (agent-flow event-relay steal). On every tool call this posts a
METADATA-ONLY record to POST /api/tool-log; the backend persists it and relays a
thin-notify 'hook-event' onto the SSE bus so the dashboard "Hook Stream" tab
shows fleet tool activity in real time (agent-flow's zero-latency streaming).

SECURITY POSTURE (why this stays metadata-only):
  - It NEVER sends raw command bodies, prompt text, or tool output. The
    input_summary is drawn ONLY from a whitelist of structural, human-authored
    fields (description, file_path, pattern, url, ...), truncated hard. Same
    "identifiers not content" rule as the context7 audit hook.
  - It targets localhost only (the dashboard on 127.0.0.1) with the agent's
    existing bearer token. No new egress.
  - It is a pure LOGGING hook: it ALWAYS exits 0 and can never block a tool call.
    A relay failure (dashboard down, timeout) is swallowed silently.

OPT-IN: this hook is intentionally NOT wired into .claude/settings.json by the
adoption PR -- enabling fleet-wide tool-call capture is a separate rollout
decision. To enable for one agent, add to that agent's PostToolUse hooks:
    {"matcher": "*", "hooks": [{"type": "command",
      "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/tool-log-relay.py\"",
      "timeout": 5}]}

Config env: DASHBOARD_URL (default http://localhost:3420),
DASHBOARD_TOKEN_PATH (default <install>/store/.dashboard-token).
"""
import json
import os
import sys
import urllib.request

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_TOKEN_PATH = os.path.join(INSTALL_DIR, "store", ".dashboard-token")

# Structural / human-authored fields that name WHAT a tool touched without
# carrying secrets. Ordered by preference; the first present non-empty string
# wins. Every other tool_input field (command body, content, prompt) is ignored.
SAFE_INPUT_KEYS = (
    "description", "file_path", "notebook_path", "pattern", "url", "query", "path",
)
SUMMARY_CAP = 100


def _safe_summary(tool_input):
    """A bounded, non-sensitive descriptor from whitelisted fields, or None."""
    if not isinstance(tool_input, dict):
        return None
    for key in SAFE_INPUT_KEYS:
        val = tool_input.get(key)
        if isinstance(val, str) and val.strip():
            s = val.strip()
            return s[:SUMMARY_CAP] if len(s) > SUMMARY_CAP else s
    return None


def _infer_success(tool_response):
    """Best-effort success flag. Defaults to True; only a clear error marker in
    the tool_response flips it to False."""
    if isinstance(tool_response, dict):
        if tool_response.get("is_error") is True:
            return False
        err = tool_response.get("error")
        if isinstance(err, str) and err.strip():
            return False
        if err not in (None, "", False):
            return False
    return True


def build_payload(hook_json):
    """Pure: map a PostToolUse hook payload to the /api/tool-log request body, or
    None for anything unusable (non-dict, no tool name). Never raises."""
    if not isinstance(hook_json, dict):
        return None
    tool = hook_json.get("tool_name")
    if not isinstance(tool, str) or not tool.strip():
        return None
    session = hook_json.get("session_id")
    if not isinstance(session, str) or not session.strip():
        session = "unknown"
    return {
        "session_id": session,
        "tool_name": tool,
        "input_summary": _safe_summary(hook_json.get("tool_input")),
        "success": _infer_success(hook_json.get("tool_response")),
    }


def _read_token():
    path = os.environ.get("DASHBOARD_TOKEN_PATH", DEFAULT_TOKEN_PATH)
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return ""


def _post(payload):
    """POST the record; swallow every failure (a logging hook never blocks)."""
    token = _read_token()
    if not token:
        return
    base = os.environ.get("DASHBOARD_URL", "http://localhost:3420").rstrip("/")
    req = urllib.request.Request(
        base + "/api/tool-log",
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    try:
        urllib.request.urlopen(req, timeout=3).close()
    except Exception:
        pass


def main():
    try:
        raw = sys.stdin.read()
        payload = build_payload(json.loads(raw)) if raw.strip() else None
        if payload is not None:
            _post(payload)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
