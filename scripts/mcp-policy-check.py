#!/usr/bin/env python3
"""Adjudicate a proposed external MCP server against the fleet adoption policy.

Background: the fleet runs a Chad-owned gate before any third-party MCP server
is wired in (memory: "Kulso MCP adoption gate"). The policy is hook-first --
an MCP server with no PreToolUse logging/observability hook is CONDITIONAL at
best, and a server that both reads secrets and egresses externally without a
written justification is an outright BLOCK.

This script encodes that table as a pure-stdlib, deterministic decision so the
verdict is reproducible and CI-checkable rather than vibe-based.

Descriptor attributes (all optional; conservative defaults applied):
    maintainer_trust   one of: trusted | community | unknown   (default unknown)
    has_pretooluse_hook bool -- ships/can be wrapped in a PreToolUse hook
    reads_secrets      bool -- can read credentials/tokens/PII
    external_egress    bool -- makes outbound network calls off-box
    requested_by       str  -- the requesting agent/person (justification proxy)

Verdicts:
    PASS         clears the gate unconditionally
    CONDITIONAL  may proceed only with the listed conditions satisfied
    BLOCK        must not be wired in as proposed

Usage:
    # JSON descriptor on stdin
    echo '{"name":"context7","has_pretooluse_hook":true,
           "maintainer_trust":"community","requested_by":"scout"}' \\
        | ./mcp-policy-check.py

    # inline JSON arg
    ./mcp-policy-check.py --name context7 \\
        --attrs '{"has_pretooluse_hook":true,"requested_by":"dave"}'

    # machine-readable
    ./mcp-policy-check.py --json < descriptor.json

Exit code: 0 = PASS, 1 = CONDITIONAL, 2 = BLOCK, 3 = bad input.
"""

import argparse
import json
import sys

PASS = "PASS"
CONDITIONAL = "CONDITIONAL"
BLOCK = "BLOCK"

# verdict -> process exit code
_EXIT = {PASS: 0, CONDITIONAL: 1, BLOCK: 2}

_TRUST_LEVELS = ("trusted", "community", "unknown")

# Privileged agent contexts whose prompts must never ingest attacker-controllable
# external content: a prompt-injection sink here can pivot the whole fleet.
BANNED_CONTEXTS = {"chad", "claudia", "marveen", "applegate"}


def _as_bool(value):
    """Coerce JSON-ish truthy values to bool, conservatively."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "y", "on")
    return bool(value)


def _normalize(attrs):
    """Return a clean attribute dict with conservative defaults applied."""
    trust = str(attrs.get("maintainer_trust", "unknown")).strip().lower()
    if trust not in _TRUST_LEVELS:
        trust = "unknown"
    requested_by = attrs.get("requested_by")
    external_egress = _as_bool(attrs.get("external_egress", False))
    # Q2 of the policy: does the server inject external content into the model's
    # prompt? If not stated, assume it can whenever it egresses off-box
    # (conservative -- an egressing server usually returns content we then read).
    injects_into_prompt = _as_bool(
        attrs.get("injects_into_prompt", external_egress)
    )
    return {
        "maintainer_trust": trust,
        "has_pretooluse_hook": _as_bool(attrs.get("has_pretooluse_hook", False)),
        "reads_secrets": _as_bool(attrs.get("reads_secrets", False)),
        "external_egress": external_egress,
        "injects_into_prompt": injects_into_prompt,
        "requested_by": str(requested_by).strip() if requested_by else "",
    }


def evaluate(name, attrs):
    """Adjudicate one MCP descriptor.

    Returns a dict: {name, verdict, reasons[], conditions[], attributes}.
    Importable -- callers can act on the dict without parsing stdout.
    """
    a = _normalize(attrs)
    reasons = []
    conditions = []
    verdict = PASS

    def downgrade(target):
        nonlocal verdict
        order = {PASS: 0, CONDITIONAL: 1, BLOCK: 2}
        if order[target] > order[verdict]:
            verdict = target

    has_justification = bool(a["requested_by"])

    # --- BLOCK rules (hard stops) -------------------------------------
    # Secret-reading + off-box egress is exfiltration-shaped; it needs an
    # explicit named requester to even be considered, and even then is
    # only ever CONDITIONAL (handled below), never an automatic PASS.
    if a["reads_secrets"] and a["external_egress"] and not has_justification:
        downgrade(BLOCK)
        reasons.append(
            "reads_secrets + external_egress with no requested_by "
            "(unjustified exfiltration surface)"
        )

    if a["maintainer_trust"] == "unknown" and a["external_egress"]:
        downgrade(BLOCK)
        reasons.append(
            "unknown maintainer with external_egress "
            "(supply-chain + data-egress risk)"
        )

    # A prompt-injection sink wired into a privileged agent context is a
    # fleet-pivot risk; hard stop regardless of trust/hook.
    if a["injects_into_prompt"] and a["requested_by"].lower() in BANNED_CONTEXTS:
        downgrade(BLOCK)
        reasons.append(
            "injects external content into a privileged context "
            f"'{a['requested_by']}' (banned: {sorted(BANNED_CONTEXTS)})"
        )

    # --- CONDITIONAL rules (proceed only with conditions) -------------
    # Hook-first precondition: no PreToolUse hook means no observability,
    # so it can never auto-PASS.
    if not a["has_pretooluse_hook"]:
        downgrade(CONDITIONAL)
        reasons.append("no PreToolUse hook (no call observability)")
        conditions.append("wrap server in a PreToolUse logging hook before wiring")

    if a["reads_secrets"] and a["external_egress"] and has_justification:
        downgrade(CONDITIONAL)
        reasons.append(
            "reads_secrets + external_egress (justified by "
            f"'{a['requested_by']}')"
        )
        conditions.append(
            "scope credentials to least-privilege + log all egress destinations"
        )

    if a["injects_into_prompt"]:
        downgrade(CONDITIONAL)
        reasons.append(
            "injects external content into the prompt (injection surface)"
        )
        conditions.append(
            "restrict to a named agent scope + mandatory PreToolUse hook"
        )

    if a["maintainer_trust"] == "community" and not a["external_egress"]:
        downgrade(CONDITIONAL)
        reasons.append("community maintainer (review pinned version + diff)")
        conditions.append("pin to a reviewed commit/tag, not a floating tag")

    if a["maintainer_trust"] == "unknown" and not a["external_egress"]:
        downgrade(CONDITIONAL)
        reasons.append("unknown maintainer (local-only, but unvetted)")
        conditions.append("Chad reviews source before adoption")

    if verdict == PASS:
        reasons.append("trusted maintainer, hooked, no secret/egress risk")

    return {
        "name": name,
        "verdict": verdict,
        "reasons": reasons,
        "conditions": conditions,
        "attributes": a,
    }


def format_text(result):
    """Human-readable report for the CLI."""
    lines = [f"MCP policy check: {result['name'] or '<unnamed>'}"]
    lines.append(f"  verdict: {result['verdict']}")
    for r in result["reasons"]:
        lines.append(f"    reason: {r}")
    for c in result["conditions"]:
        lines.append(f"    condition: {c}")
    return "\n".join(lines)


def _load_descriptor(args):
    """Build (name, attrs) from CLI args / stdin. Raises ValueError on bad input."""
    attrs = {}
    name = args.name or ""

    if args.attrs is not None:
        attrs = json.loads(args.attrs)
        if not isinstance(attrs, dict):
            raise ValueError("--attrs must be a JSON object")
    elif not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
        if raw:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("stdin descriptor must be a JSON object")
            # a full descriptor may carry name inline
            name = name or str(data.get("name", "") or "")
            attrs = {k: v for k, v in data.items() if k != "name"}

    return name, attrs


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Adjudicate a proposed external MCP server against fleet policy."
    )
    parser.add_argument("--name", help="MCP server name")
    parser.add_argument(
        "--attrs",
        help="JSON object of attributes (overrides stdin)",
    )
    parser.add_argument(
        "--json", action="store_true", help="emit the verdict as JSON"
    )
    args = parser.parse_args(argv)

    try:
        name, attrs = _load_descriptor(args)
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"error: invalid descriptor: {exc}", file=sys.stderr)
        return 3

    result = evaluate(name, attrs)

    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(format_text(result))

    return _EXIT[result["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
