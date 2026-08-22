#!/usr/bin/env python3
"""PreToolUse guardrail hook: block a Telegram `reply`/`edit_message` whose
`chat_id` is NOT in the running agent's allowlist.

This closes the broadcast/prompt-injection gap (fleet blast-radius audit #3):
the reply tool can send to ANY chat_id it is handed, so a chat_id smuggled in
via web content / email / an inter-agent message could make the agent message a
chat it was never paired with. permissions.deny is a static string match and
cannot reason about a runtime argument, so this guard is a PreToolUse hook
(aios-adoption item 2b, the "never do" bucket -- an agent must NEVER message a
chat it has no relationship with).

Design constraints (fail-safe-by-design, NON-NEGOTIABLE):
  - CLOSED ENUM / matched-tool-only: only the tools in GUARDED_TOOLS can ever be
    blocked; every other tool is passed through untouched.
  - FAIL-OPEN: any error, missing arg, or unresolved allowlist -> allow (exit 0).
    The platform default is already fail-open (a crashed/timed-out hook lets the
    call proceed); this script reinforces it so a guard bug can never brick an
    agent's Telegram. The block path fires ONLY on a positively-matched,
    fully-resolved foreign chat_id.

Block mechanism: exit 2 with a reason on stderr (the fleet convention, see
forge-deploy-guard.py). Exit 0 = allow.
"""
import sys
import os
import json

# The only tools this guard may ever block. Both send/alter visible content in a
# chat; `react`/`download_attachment` are intentionally out of scope (low impact,
# keeps matched-tool-only tight).
GUARDED_TOOLS = frozenset({
    "mcp__plugin_telegram_telegram__reply",
    "mcp__plugin_telegram_telegram__edit_message",
})

# access.json candidate locations, in resolution order. The agent's own file
# (cwd-relative, agents launch with cwd = agent dir) is authoritative; the global
# file covers the main agent (cwd = project root, channel state lives in $HOME).
# We UNION every file that parses: a wider allowlist can only avoid false-blocks,
# never cause one (the safe, fail-open direction).
def _access_json_candidates():
    cwd = os.getcwd()
    return [
        os.path.join(cwd, ".claude", "channels", "telegram", "access.json"),
        os.path.join(os.path.expanduser("~"), ".claude", "channels", "telegram", "access.json"),
    ]


def resolve_allowlist(candidates):
    """Union of every parseable access.json's outbound-legal chat set:
    allowFrom (paired DMs) | groups (paired group chats) | pending (golden-rule
    holding reply to a not-yet-approved sender). Returns a set[str], or None if
    NO candidate parsed -> caller must fail open."""
    found = False
    allow = set()
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        found = True
        for entry in data.get("allowFrom") or []:
            allow.add(str(entry))
        groups = data.get("groups")
        if isinstance(groups, dict):
            for key in groups.keys():
                allow.add(str(key))
        pending = data.get("pending")
        if isinstance(pending, dict):
            for key in pending.keys():
                allow.add(str(key))
    return allow if found else None


def decide(payload, allowlist):
    """Pure decision. Returns (block: bool, reason: str).
    block=True ONLY when: a guarded tool, with a resolvable chat_id, against a
    resolved allowlist, and the chat_id is NOT in it. Every other path = allow."""
    if not isinstance(payload, dict):
        return (False, "")
    if payload.get("tool_name") not in GUARDED_TOOLS:
        return (False, "")  # matched-tool-only
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return (False, "")  # can't reason -> fail open
    chat_id = tool_input.get("chat_id")
    if chat_id is None:
        return (False, "")  # no target arg -> fail open
    chat_id = str(chat_id)
    if allowlist is None:
        return (False, "")  # allowlist unresolved -> fail open
    if chat_id in allowlist:
        return (False, "")  # paired chat -> allow
    return (
        True,
        "BLOCKED by fleet guardrail: Telegram chat_id {cid} is not in this "
        "agent's allowlist (allowFrom/groups/pending). An agent must never "
        "message a chat it was not paired with -- this is the broadcast/"
        "prompt-injection guard. If this chat is legitimate, the operator must "
        "pair it via the /telegram:access skill; do not attempt to bypass."
        .format(cid=chat_id),
    )


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else None
    except Exception:
        sys.exit(0)  # unreadable/malformed input -> fail open

    try:
        allowlist = resolve_allowlist(_access_json_candidates())
        block, reason = decide(payload, allowlist)
    except Exception:
        sys.exit(0)  # any internal error -> fail open

    if block:
        sys.stderr.write(reason + "\n")
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
