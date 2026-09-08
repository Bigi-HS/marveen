#!/usr/bin/env python3
"""PreToolUse guardrail hook: name-gate (card 16fd807a).

Scans Boss-facing outgoing text for routing-id occurrences (e.g. 'scout',
'forge') and soft-blocks with the correct display name ('Dr. Stone', 'Armorer').

Guarded tools (matched-tool-only):
  - mcp__plugin_telegram_telegram__reply
  - mcp__plugin_telegram_telegram__edit_message
  - Bash where the command targets /api/notify/telegram

Excluded (IDs are correct in these contexts):
  - inter-agent /api/messages calls (the routing-id IS the correct address)
  - server-generated structured strings (covered by readAgentDisplayName server-side)
  - every other tool (pass-through)

Design (fail-safe, NON-NEGOTIABLE):
  - MATCHED-TOOL-ONLY: only the three paths above can ever be blocked.
  - FAIL-OPEN on any error (crash, missing map, unreadable configs): exit 0.
    A guard bug must never brick an agent's Telegram output.
  - DEFAULT-ALLOW: blocks only on a positively identified routing-id.
  - SOFT-BLOCK (exit 2): never auto-rewrites prose; the agent must correct and retry.
  - CASE-INSENSITIVE whole-word match: 'Scout', 'SCOUT' etc. all trigger.
    The intent is that no form of the routing-id should appear in Boss-facing text.
"""
import sys
import os
import json
import re
import glob
from pathlib import Path


GUARDED_MCP_TOOLS = frozenset({
    "mcp__plugin_telegram_telegram__reply",
    "mcp__plugin_telegram_telegram__edit_message",
})


def _project_root():
    """Return the marveen project root (3 levels up from this file)."""
    return Path(__file__).resolve().parent.parent.parent


def build_id_map(agents_dir=None):
    """Return {routing_id: display_name} for agents where displayName differs from id.

    Reads agents/*/agent-config.json.  Returns an empty dict on any I/O failure
    (caller must fail open).
    """
    if agents_dir is None:
        agents_dir = _project_root() / "agents"
    result = {}
    try:
        pattern = str(Path(agents_dir) / "*" / "agent-config.json")
        for p in glob.glob(pattern):
            try:
                with open(p, encoding="utf-8") as f:
                    d = json.load(f)
                agent_id = os.path.basename(os.path.dirname(p))
                display = d.get("displayName", "")
                if display and display != agent_id:
                    result[agent_id] = display
            except Exception:
                pass
    except Exception:
        pass
    return result


def extract_text(payload):
    """Extract the outgoing text from the tool call payload.

    Returns (text: str | None, is_guarded: bool).
    is_guarded=False means the tool is outside our scope; caller should exit 0.
    """
    if not isinstance(payload, dict):
        return None, False

    tool = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {})
    if not isinstance(tool_input, dict):
        return None, False

    if tool in GUARDED_MCP_TOOLS:
        text = tool_input.get("text") or ""
        return (text if text else None), True

    if tool == "Bash":
        command = tool_input.get("command") or ""
        if "/api/notify/telegram" not in command:
            return None, False
        text = _extract_notify_text(command)
        return (text if text else None), True

    return None, False


def _extract_notify_text(command):
    """Extract the 'text' field from a curl /api/notify/telegram command.

    Tries to parse the -d/--data JSON body to isolate the 'text' field.
    Falls back to scanning the full command string (may trigger on false positives
    but that is safer than missing a routing-id in the actual text).
    """
    # Match common -d 'JSON' and --data 'JSON' forms
    for pat in [
        r"""-d\s+'([^']+)'""",
        r"""-d\s+"([^"]+)"\s""",
        r"""--data\s+'([^']+)'""",
        r"""--data\s+"([^"]+)"\s""",
    ]:
        m = re.search(pat, command)
        if m:
            try:
                body = json.loads(m.group(1))
                if isinstance(body, dict):
                    return body.get("text") or ""
            except Exception:
                pass
    # Fallback: scan the whole command
    return command


def find_routing_ids(text, id_map):
    """Return list of (routing_id, display_name) found in text as whole words.

    Case-insensitive match with \\b word boundaries.  Returns only distinct
    routing-ids (even if the id appears more than once in the text).
    """
    found = []
    for rid, display in sorted(id_map.items()):
        pattern = r'\b' + re.escape(rid) + r'\b'
        if re.search(pattern, text, re.IGNORECASE):
            found.append((rid, display))
    return found


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else None
    except Exception:
        sys.exit(0)  # fail open: unreadable/malformed input

    try:
        text, is_guarded = extract_text(payload)
        if not is_guarded or not text:
            sys.exit(0)

        id_map = build_id_map()
        if not id_map:
            sys.exit(0)  # fail open: no map (broken config dir etc.)

        found = find_routing_ids(text, id_map)
        if not found:
            sys.exit(0)

        fixes = "; ".join(
            "'{rid}' -> '{display}'".format(rid=rid, display=display)
            for rid, display in found
        )
        sys.stderr.write(
            "NAME-GATE: Boss-facing szovegben routing-id talalhato: {fixes}. "
            "Hasznald a helyes display-nevet. Javits es probald ujra.\n".format(fixes=fixes)
        )
        sys.exit(2)

    except Exception as exc:
        sys.stderr.write("NAME-GATE: internal error, failing open: {}\n".format(exc))
        sys.exit(0)


if __name__ == "__main__":
    main()
