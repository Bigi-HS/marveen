#!/usr/bin/env python3
"""De-brand text engine -- deterministic marveen->noa classifier/rewriter (card 901ecb0b).

Spec: store/specs/v2-debrand-hybrid-tooling.md (Thor PASS + DA T1 closed).

This is the authoritative engine the spec names `debrand-text.py`; the module is named
with an underscore (`debrand_text`) so it is IMPORTABLE -- `migrate-to-noa.py` imports
`apply`/`classify` for the memory content-transform seam (a hyphenated module name is
not importable in Python). The CLI entrypoint can still be invoked as
`python3 scripts/debrand_text.py`.

Design (this PR -- the deterministic CODE-context core):
  classify(value, context='code', key=None) -> Verdict, where Verdict.action is one of
  REWRITE / REFUSE(tag) / NOOP. Precedence is fail-closed: an occurrence that matches no
  known SAFE shape is REFUSE(unclassified), never a blind rewrite. Order:
    1. no `marveen` token            -> NOOP
    2. blocklist pattern (wins all)  -> REFUSE(coordinated-infra)
    3. A1 embedded path prefix       -> REWRITE
    4. A3 route literal              -> REFUSE(contract-change-route)
    5. A2 agent-id literal, key-gated-> REWRITE
    6. otherwise                     -> REFUSE(unclassified)
  Blocklist is PATTERN-based (not a literal list) so a future variant (com.marveen.X,
  agent-marveen-prod) is caught -- the glued-shorthand/CLI-allowlist lesson.

The prose/memory tier (A4 comments, memory M1/M2/M3, provenance opt-out, the
blocklist-token pre-scan GATE) and the migrate-to-noa.py extension land in the
follow-up PR; this core is what both consumers build on.
"""
from __future__ import annotations

import re

# --- Verdict action constants ---------------------------------------------------------
REWRITE = "REWRITE"
REFUSE = "REFUSE"
NOOP = "NOOP"

# Agent-id key contexts in which a bare 'marveen' literal is a safe A2 rewrite.
# Includes DEFAULT_AGENT (DA-5: migrate-to-noa.py:40 `DEFAULT_AGENT = "marveen"`).
A2_AGENTID_KEYS = frozenset(
    {"agent_id", "agentId", "from", "to", "MAIN_AGENT_ID", "DEFAULT_AGENT", "source"}
)

_MARVEEN = re.compile(r"marveen", re.IGNORECASE)

# Blocklist patterns (pattern-based per Thor-F3 / DA-F3). Order-independent; any match
# REFUSES as coordinated-infra. The literal known instances are the test fixture; these
# regexes are the matcher so future variants are still caught.
_BLOCKLIST_PATTERNS = (
    re.compile(r"\bcom\.marveen\.[\w.-]+", re.IGNORECASE),            # launchd labels
    re.compile(r"\b(?:agent-)?marveen-[\w-]*", re.IGNORECASE),        # tmux/session names
    re.compile(r"@marveen[\w-]*", re.IGNORECASE),                     # external @handle
    re.compile(r"[\w-]*marveen-marketplace\b", re.IGNORECASE),        # external workspace
)

_A1_PATH = re.compile(r"/home/domin/marveen\b")
_A3_ROUTE = re.compile(r"/(?:api/)?marveen\b")


class Verdict:
    """Classification result. action in {REWRITE, REFUSE, NOOP}."""

    __slots__ = ("action", "tag", "new_value", "needs_glance")

    def __init__(self, action, tag=None, new_value=None, needs_glance=False):
        self.action = action
        self.tag = tag              # set for REFUSE
        self.new_value = new_value  # set for REWRITE
        self.needs_glance = needs_glance

    def __eq__(self, other):
        return (
            isinstance(other, Verdict)
            and self.action == other.action
            and self.tag == other.tag
            and self.new_value == other.new_value
            and self.needs_glance == other.needs_glance
        )

    def __repr__(self):
        return (
            f"Verdict({self.action!r}, tag={self.tag!r}, "
            f"new_value={self.new_value!r}, needs_glance={self.needs_glance!r})"
        )


def case_map(text: str) -> str:
    """Replace every `marveen` occurrence with `noa`, preserving case form.

    marveen->noa, Marveen->Noa, MARVEEN->NOA. Mixed/other casings fall back to the
    lower-case replacement.
    """

    def repl(m: re.Match) -> str:
        tok = m.group(0)
        if tok.isupper():
            return "NOA"
        if tok[0].isupper():
            return "Noa"
        return "noa"

    return _MARVEEN.sub(repl, text)


def _matches_blocklist(value: str) -> bool:
    return any(p.search(value) for p in _BLOCKLIST_PATTERNS)


def classify(value: str, context: str = "code", key: str | None = None) -> Verdict:
    """Classify a single `marveen`-bearing value. Fail-closed.

    value   -- the text under consideration (a path, a string-literal content, a route,
               a label, etc.).
    context -- 'code' (this PR) or 'memory' (follow-up PR).
    key     -- the surrounding key/identifier name, if known, used to recognise an
               A2 agent-id literal (e.g. key='agent_id').
    """
    if not _MARVEEN.search(value):
        return Verdict(NOOP)

    # 2. Blocklist wins over everything, even an agent-id key context.
    if _matches_blocklist(value):
        return Verdict(REFUSE, tag="coordinated-infra")

    # 3. A1 embedded path prefix.
    if _A1_PATH.search(value):
        return Verdict(REWRITE, new_value=_A1_PATH.sub("/home/domin/noa", value))

    # 4. A3 route literal -> contract change, never auto-rewritten.
    if _A3_ROUTE.search(value):
        return Verdict(REFUSE, tag="contract-change-route")

    # 5. A2 agent-id literal, key-gated: the value IS the agent id.
    if key in A2_AGENTID_KEYS and value.strip().lower() == "marveen":
        return Verdict(REWRITE, new_value=case_map(value.strip()))

    # 6. Fail-closed: unknown shape -> manual review, never a blind rewrite.
    return Verdict(REFUSE, tag="unclassified")


def apply(value: str, context: str = "code", key: str | None = None):
    """Classify and apply. Returns (new_value, Verdict). REFUSE/NOOP leave value as-is."""
    v = classify(value, context=context, key=key)
    if v.action == REWRITE:
        return v.new_value, v
    return value, v


if __name__ == "__main__":  # pragma: no cover -- thin CLI shell (dry-run report)
    import sys

    ctx = "memory" if "--memory" in sys.argv[1:] else "code"
    for line in sys.stdin:
        val = line.rstrip("\n")
        verdict = classify(val, context=ctx)
        print(f"{verdict.action}\t{verdict.tag or ''}\t{val}")
