#!/usr/bin/env python3
"""PreToolUse hook (Bash): pre-send PII / prompt-injection scan for inter-agent
messages. Mirrors the fleet AIDefence concept (RuFlo mining catalog #1) as a
deterministic, auditable hook in front of the inter-agent send path.

Scope (conscious): only inspects Bash commands that POST to the inter-agent
messages endpoint -- `curl ... /api/messages`. It does NOT touch ordinary Bash,
memory saves, or read-only API calls. The intent is to catch a message that
would carry raw PII out of the fleet, or carry injected command-like instructions
from foreign/untrusted content into another agent's context BEFORE it is sent.

What it flags:
  - PII:        email address, phone number, credit-card-like 13-16 digit run,
                long API-key / token-like strings (sk-..., ghp_..., 32+ hex).
  - Injection:  imperative override phrases commonly used by prompt injection
                ("ignore previous instructions", "disregard the above",
                "you are now", "system prompt", "exfiltrate", "send the token").

On a match it BLOCKS (exit 2) and tells the agent which category tripped, so the
sender can redact PII or strip the untrusted instruction before retrying. Every
block is also appended to store/aidefence.log for the security audit trail (Chad).

Exit 0 = allow. Exit 2 = block (Claude Code shows the reason to the agent).

NOTE: This is a hook-level guard for agents that opt in via settings.json. The
server-side filter on POST /api/messages remains the authoritative layer; this
hook gives an earlier, agent-local signal so untrusted content never leaves the
agent in the first place.
"""
import sys
import os
import json
import re
from datetime import datetime

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AUDIT_LOG = os.path.join(INSTALL_DIR, "store", "aidefence.log")

# Only inspect inter-agent sends (POST to the messages endpoint).
MESSAGES_ENDPOINT_RX = re.compile(r"curl\b.*?/api/messages", re.IGNORECASE | re.DOTALL)

PII_PATTERNS = {
    "email": re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),
    "phone": re.compile(r"(?<!\d)(?:\+?\d[\d \-]{8,}\d)(?!\d)"),
    "credit-card": re.compile(r"(?<!\d)(?:\d[ -]?){13,16}(?!\d)"),
    "api-key": re.compile(r"\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|[A-Fa-f0-9]{32,})\b"),
}

INJECTION_RX = re.compile(
    r"(ignore\s+(?:all\s+)?previous\s+instructions"
    r"|disregard\s+(?:the\s+)?above"
    r"|you\s+are\s+now\b"
    r"|new\s+system\s+prompt"
    r"|reveal\s+(?:the\s+)?system\s+prompt"
    r"|exfiltrate"
    r"|send\s+(?:me\s+)?(?:the\s+)?(?:token|secret|password|credential))",
    re.IGNORECASE,
)


def _extract_payload_text(cmd):
    """Best-effort extraction of the message body from a curl command so PII in
    the JSON payload is caught, not just literal flags. Falls back to the whole
    command string. Phone/credit-card matching uses a digit-dense slice to limit
    false positives from unrelated long numbers."""
    # Prefer the JSON sent via -d / --data so headers/URLs don't pollute the scan.
    m = re.search(r"(?:--data(?:-raw)?|-d)\s+(['\"])(.*?)\1", cmd, re.DOTALL)
    if m:
        return m.group(2)
    return cmd


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if payload.get("tool_name") != "Bash":
        sys.exit(0)

    cmd = (payload.get("tool_input") or {}).get("command", "")
    if not MESSAGES_ENDPOINT_RX.search(cmd):
        sys.exit(0)

    body = _extract_payload_text(cmd)

    hits = []
    for label, rx in PII_PATTERNS.items():
        if rx.search(body):
            hits.append(f"PII:{label}")
    if INJECTION_RX.search(body):
        hits.append("injection")

    if not hits:
        sys.exit(0)

    tags = list(dict.fromkeys(hits))

    # Audit trail (Chad). Never let logging failure change the gate decision.
    try:
        ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        agent = (payload.get("tool_input") or {}).get("agent_id") or "?"
        with open(AUDIT_LOG, "a") as f:
            f.write(f"{ts} [block] {tags} agent={agent}\n")
    except Exception:
        pass

    print(json.dumps({
        "reason": (
            "INTER-AGENT SEND BLOCKED by AIDefence pre-send scan. "
            f"Flagged: {', '.join(tags)}. "
            "Redact any PII (emails, phone numbers, card numbers, tokens) and strip "
            "untrusted command-like instructions before resending. If this is a false "
            "positive, route the message through the server-side /api/messages filter "
            "instead of the hooked Bash path."
        )
    }))
    sys.exit(2)


if __name__ == "__main__":
    main()
