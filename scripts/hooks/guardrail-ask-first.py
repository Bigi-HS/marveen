#!/usr/bin/env python3
"""PreToolUse guardrail hook: gate irreversible / external-effect MCP tools
behind an explicit one-shot approval (aios-adoption item 2b, the "ASK FIRST"
bucket).

Some MCP tool calls have consequences that leave the sandbox and cannot be
undone -- sending an email under Dominik's name, publishing/going live on a
YouTube/Twitch channel. permissions.deny is the wrong tier for these: a flat
deny would break the legitimate use (the owner agent is *supposed* to send mail
/ set a stream up), and a flat allow leaves an injected or mistaken call free to
fire. The right tier is "ask first": pause the action, route a confirmation
request to the operator (Genesis/marveen), and only let it through once a human
has approved THIS specific action.

This hook is the agent-side gate of that confirm-channel
(ask-first -> inter-agent -> marveen):

  1. Guarded tool called, no fresh approval marker for this exact action
     -> record a `<token>.pending` file describing the action, block the call
        (exit 2) and tell the agent, on stderr, to ask marveen for approval of
        `<token>` via inter-agent.
  2. marveen (the main agent, which CAN write the approvals dir) reviews the
     pending file and, if it approves, creates `<token>.approved`.
  3. The agent re-issues the identical call -> this hook finds the fresh marker,
     CONSUMES it (one-shot), and allows the call (exit 0).

The marker lives ONLY in a directory that is OUTSIDE every agent profile's
`Write(${AGENT_DIR}/**)` allow (default `~/.claude/ask-approvals/`), so an agent
cannot, through the permission layer, forge its own approval. A Bash-capable
agent can still write arbitrary files at the OS layer -- that bypass is the same
class as the permissions.deny pattern bypass and is out of scope here; the hard
boundary for it is item 3 (per-agent scoped credentials). This hook raises the
bar for accidental and injected calls and makes the confirm-channel mandatory
for the happy path.

Design constraints (fail-safe-by-design, NON-NEGOTIABLE -- identical to the
sibling guardrail-telegram-chat.py):
  - CLOSED ENUM / matched-tool-only: only tools in GUARDED_TOOLS can ever be
    affected; every other tool passes through untouched.
  - FAIL-OPEN: any error -- unreadable input, uncomputable token, unwritable
    approvals dir -- results in allow (exit 0). The platform default is already
    fail-open (a crashed/timed-out hook lets the call proceed); a guard bug must
    never wedge an agent. The gate fires ONLY on a positively-matched guarded
    tool with no fresh approval.

Block mechanism: exit 2 with a reason on stderr (the fleet convention). Exit 0
= allow.
"""
import sys
import os
import json
import time
import hashlib

# The closed set of tools that require ask-first approval. Each entry is an exact
# `mcp__<server>__<tool>` name. This is intentionally a hard-coded frozenset, not
# config: the enforcement surface must not be widenable or disable-able from
# outside the reviewed code.
#
# REGISTRATION: add a tool name here when (and only when) a real, live MCP tool
# with irreversible external effect is wired into the fleet.
#   - email send (LIVE, card 5bd18a7e): Claudia's local Google MCP server
#     (src/mcp/google-mcp-server.ts) exposes a `gmail_send` tool under the
#     mcpServers key `claudia_google`, so its namespaced name is
#     `mcp__claudia_google__gmail_send`. The exact string is defined once in
#     src/mcp/tool-names.ts (GUARDED_GMAIL_SEND) and cross-pinned by
#     src/__tests__/google-mcp-tool-names.test.ts; the deploy doc has a live
#     `claude mcp`-roster verification step. The sibling `calendar_today` tool is
#     read-only (calendar.events.readonly) and is intentionally NOT guarded.
#   - YouTube/Twitch publish: bigben has no MCP server configured; that guard
#     should be added in the same change that introduces the publish tool, so
#     the exact tool name is known and cannot drift.
GUARDED_TOOLS = frozenset(
    {
        "mcp__claudia_google__gmail_send",
    }
)

# How long an approval marker is honored after it is created. Bounds replay: a
# stale marker is ignored and the action must be re-approved.
APPROVAL_TTL_SECONDS = 900  # 15 minutes


def approvals_dir():
    """Directory holding pending/approved markers. MUST be outside every agent
    profile's Write allow (so an agent cannot self-approve via the permission
    layer). Overridable via env for tests ONLY -- the hook subprocess inherits
    Claude Code's environment, not the agent's shell, so the agent cannot set
    this at call time."""
    override = os.environ.get("ASK_APPROVALS_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".claude", "ask-approvals")


def action_token(tool_name, tool_input):
    """Stable, collision-resistant token binding an approval to THIS exact
    action. Canonical JSON (sorted keys, no insignificant whitespace) so the
    token is identical for the pending record and the agent's re-issued call."""
    canonical = json.dumps(
        {"tool": tool_name, "input": tool_input},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


def classify(payload):
    """Pure. Returns (guarded: bool, token: str). guarded=True only for a
    guarded tool with a dict tool_input we can tokenize; everything else ->
    (False, "") = pass through (fail open / matched-tool-only)."""
    if not isinstance(payload, dict):
        return (False, "")
    if payload.get("tool_name") not in GUARDED_TOOLS:
        return (False, "")  # matched-tool-only
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return (False, "")  # can't tokenize -> fail open
    return (True, action_token(payload["tool_name"], tool_input))


def approval_status(directory, token, now):
    """IO: classify the approval marker for `token`. Returns 'fresh' (exists and
    within TTL), 'stale' (exists but expired), or 'absent'."""
    path = os.path.join(directory, token + ".approved")
    try:
        mtime = os.stat(path).st_mtime
    except Exception:
        return "absent"
    if now - mtime <= APPROVAL_TTL_SECONDS:
        return "fresh"
    return "stale"


def decide(guarded, status):
    """Pure mapping from (guarded, approval status) to an action:
      'allow'   -> not guarded; pass through.
      'consume' -> guarded and a fresh approval exists; delete marker then allow.
      'block'   -> guarded and no fresh approval; record pending then block."""
    if not guarded:
        return "allow"
    if status == "fresh":
        return "consume"
    return "block"


def _reason(token, pending_path, tool_name):
    return (
        "ASK-FIRST GUARD: '{tool}' is an irreversible / external-effect action "
        "and requires explicit approval before it can run. A pending request was "
        "recorded as token={token} ({path}). Do NOT retry directly. Send an "
        "inter-agent message to marveen (Genesis) asking to approve token={token}, "
        "and summarize what this action does. marveen reviews the pending file and, "
        "if it is safe, creates the approval marker; then re-issue this exact call. "
        "This is the ask-first -> inter-agent -> marveen confirm-channel; do not "
        "attempt to bypass it.".format(tool=tool_name, token=token, path=pending_path)
    )


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else None
    except Exception:
        sys.exit(0)  # unreadable/malformed input -> fail open

    try:
        guarded, token = classify(payload)
        if not guarded:
            sys.exit(0)

        directory = approvals_dir()
        now = time.time()
        status = approval_status(directory, token, now)
        action = decide(guarded, status)

        if action == "consume":
            # One-shot: remove the marker so a later identical call needs fresh
            # approval. If removal fails we still allow this call (fail open);
            # the TTL still bounds any replay window.
            try:
                os.remove(os.path.join(directory, token + ".approved"))
            except Exception:
                pass
            sys.exit(0)

        # action == 'block': record the exact action for marveen to review, then
        # block. If we cannot even record the pending request, fail open -- a
        # broken guard must never wedge the agent.
        os.makedirs(directory, exist_ok=True)
        pending_path = os.path.join(directory, token + ".pending")
        with open(pending_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "token": token,
                    "tool_name": payload.get("tool_name"),
                    "tool_input": payload.get("tool_input"),
                    "recorded_at": int(now),
                },
                f,
                indent=2,
                ensure_ascii=False,
            )
    except Exception:
        sys.exit(0)  # any internal error -> fail open

    sys.stderr.write(_reason(token, pending_path, payload.get("tool_name")) + "\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
