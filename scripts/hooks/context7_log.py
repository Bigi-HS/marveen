#!/usr/bin/env python3
"""PreToolUse logging hook for the context7 external MCP (Tier-B gate condition).

Appends ONE JSONL audit line per context7 tool call: timestamp, agent, tool
name, and the TARGET LIBRARY identifier only. It NEVER logs prompt content, the
requested topic, token counts, or any free text -- per the External MCP Adoption
Policy gate (store/mcp-external-adoption-policy.md), only "tool name + target
library + timestamp" may be recorded (token-leak avoidance).

This is a pure LOGGING hook, not a guard: it ALWAYS exits 0 and can never block
a tool call. A logging failure must never brick context7 for Dave. Any tool
other than context7 is a silent no-op pass-through.

Registered (per-agent settings.json) under PreToolUse matcher "mcp__context7__.*".
Log path defaults to <install>/store/context7-usage.log; override with the
CONTEXT7_LOG_PATH env var (used by the tests).
"""
import json
import os
import sys
import time

# The MCP server is configured under the name "context7", so its tools surface
# as mcp__context7__<tool> (e.g. resolve-library-id, get-library-docs).
CONTEXT7_PREFIX = "mcp__context7__"

# Library-identifying argument names, in resolution priority. These name a
# PUBLIC library (id/name), not content -- safe to audit. Every OTHER field in
# tool_input (topic, tokens, ...) is deliberately never read.
LIBRARY_KEYS = ("context7CompatibleLibraryID", "libraryName", "library")

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_LOG_PATH = os.path.join(INSTALL_DIR, "store", "context7-usage.log")


def _agent_id():
    """Best-effort agent identity from the launch cwd (.../agents/<name>/...),
    falling back to an env hint or 'unknown'. Never raises."""
    try:
        parts = os.getcwd().split(os.sep)
        if "agents" in parts:
            i = parts.index("agents")
            if i + 1 < len(parts) and parts[i + 1]:
                return parts[i + 1]
    except Exception:
        pass
    return os.environ.get("MARVEEN_AGENT_ID", "unknown")


def extract_entry(payload, now):
    """Build the audit entry for a context7 tool call, or None for any
    non-context7 / unparseable input. The entry carries EXACTLY four keys
    (ts, agent, tool, library) and never any content. Never raises."""
    if not isinstance(payload, dict):
        return None
    tool = payload.get("tool_name")
    if not isinstance(tool, str) or not tool.startswith(CONTEXT7_PREFIX):
        return None
    library = ""
    tool_input = payload.get("tool_input")
    if isinstance(tool_input, dict):
        for key in LIBRARY_KEYS:
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                library = value.strip()
                break
    return {"ts": int(now), "agent": _agent_id(), "tool": tool, "library": library}


def _append(entry, log_path):
    """Append one JSONL line. Best-effort: a write failure is swallowed so the
    tool call is never blocked by a logging problem. A freshly created log is
    chmod'd to 0600 to match the store/ convention (owner-only)."""
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        is_new = not os.path.exists(log_path)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        if is_new:
            try:
                os.chmod(log_path, 0o600)
            except Exception:
                pass
    except Exception:
        pass


def main():
    log_path = os.environ.get("CONTEXT7_LOG_PATH") or DEFAULT_LOG_PATH
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else None
    except Exception:
        sys.exit(0)  # unreadable/malformed input -> never block
    try:
        entry = extract_entry(payload, time.time())
        if entry is not None:
            _append(entry, log_path)
    except Exception:
        pass  # logging must never block the tool call
    sys.exit(0)


if __name__ == "__main__":
    main()
