#!/usr/bin/env python3
"""Pure risky-instruction classifier for inter-agent message content (autopilot
spec-autopilot-fleet-20261027.md §2.3 RK-01, CRIT).

An inter-agent message whose CONTENT carries an instruction to take an
irreversible / external-effect action (deploy, delete, publish, external write,
merge-to-main) must be ask-first gated at the SENDING point. The risky payload
lives in the message STRING, not in the tool name, so tool-name matching (the
guardrail-ask-first.py pattern) is insufficient -- content-inspection is needed.

SCOPE AND LIMITS (non-negotiable, by design):
  - This is a BEST-EFFORT keyword detector, deliberately TUNED TO OVER-MATCH
    (fail-closed bias): on the guarded `send_agent_message` surface, a false
    positive costs one ask-first round; a false negative lets a risky instruction
    through autonomously. Per the fail-direction asymmetry
    (lesson-gate-fail-direction-asymmetry-1027) a BRAKE gate biases toward blocking.
  - It is BYPASSABLE (synonyms, paraphrase, other languages, encoding). That is
    EXPECTED and is why the spec mandates a SECOND line of defence: the RECEIVING
    agent never executes a risky action on an inter-agent instruction alone
    (lesson-from-field-actor-check-forgeable-shared-token-1025). This module is
    the sender-side tripwire, not the sole guarantee.
  - Normalization resists only CHEAP evasion (casing, runs of whitespace,
    zero-width chars, common separator punctuation between letters). It does NOT
    claim to resist determined obfuscation; see the receiver last-line above.

No regex catastrophic-backtracking: every pattern is a plain substring match over
the normalized text (regex-redos-patterns skill -- no nested quantifiers).
"""

import json
import sys
import unicodedata

# Risky-instruction keyword stems. Matched as plain substrings against the
# normalized (lowercased, de-spaced) text, so e.g. "deploy", "redeploy",
# "deployment" all hit on the "deploy" stem. English + Hungarian, because the
# fleet works bilingually (CLAUDE.md).
#
# REGISTRATION: a stem belongs here only if the ACTION it names is in the spec
# §2.3 RISKY set (irreversible / external-effect). Do not add generic verbs.
RISKY_STEMS = (
    # deploy / release to live
    "deploy",
    "release to prod",
    "go live",
    "elesit",      # élesít (deploy), accent-stripped by normalize
    "kielesit",
    # delete / destroy (irreversible)
    "delete",
    "destroy",
    "rm -rf",
    "drop table",
    "torol",       # töröl (delete), accent-stripped
    "kitorol",
    "letorol",
    # publish externally
    "publish",
    "publikal",    # publikál
    "go public",
    "upload to youtube",
    "post to",
    # merge to the protected branch
    "merge to main",
    "merge to master",
    "merge into main",
    "push to main",
    "merge-to-main",
    # external write / send under the Boss's name
    "send email",
    "send mail",
    "gmail_send",
    "emailt kuld",   # emailt küld
    "levelet kuld",
    # credential / scope mutation
    "rotate credential",
    "grant scope",
    "change permission",
)

# Zero-width / formatting codepoints stripped before matching (cheap evasion).
_ZERO_WIDTH = {
    "​", "‌", "‍", "﻿", "⁠", "­",
}

# Separator punctuation that an evader might sprinkle BETWEEN letters
# (d.e.p.l.o.y / d-e-p-l-o-y). Collapsed only when it sits between two letters so
# we do not destroy legitimate tokens. Kept small and explicit.
_SEP_CHARS = ".-_*~`|/\\"


def normalize(text):
    """Lowercase, strip accents and zero-width chars, collapse whitespace runs to
    a single space, and remove separator punctuation that appears between two
    letters. Pure; returns a string. Non-str input -> ''."""
    if not isinstance(text, str):
        return ""
    # Unicode-normalize and strip combining marks (accents): "töröl" -> "torol".
    decomposed = unicodedata.normalize("NFKD", text)
    no_accents = "".join(c for c in decomposed if not unicodedata.combining(c))
    # Drop zero-width chars.
    cleaned = "".join(c for c in no_accents if c not in _ZERO_WIDTH)
    cleaned = cleaned.lower()
    # Collapse inter-letter separators: only when a sep char is flanked by
    # alphanumerics on BOTH sides (so "rm -rf" keeps its space-based shape via the
    # whitespace pass, but "d-e-p-l-o-y" loses the dashes).
    out = []
    for i, ch in enumerate(cleaned):
        if ch in _SEP_CHARS:
            prev_alnum = i > 0 and cleaned[i - 1].isalnum()
            next_alnum = i + 1 < len(cleaned) and cleaned[i + 1].isalnum()
            if prev_alnum and next_alnum:
                continue  # drop the inter-letter separator
        out.append(ch)
    cleaned = "".join(out)
    # Collapse whitespace runs to single spaces.
    cleaned = " ".join(cleaned.split())
    return cleaned


def is_risky_instruction(text):
    """Pure. Returns (risky: bool, matched_stem: str). risky=True if any RISKY_STEM
    occurs as a substring of the normalized text. matched_stem is '' when not
    risky. Over-matches by design (fail-closed bias on the guarded surface)."""
    norm = normalize(text)
    if not norm:
        return (False, "")
    for stem in RISKY_STEMS:
        # Stems with spaces are matched after normalize collapses whitespace, so
        # compare against the single-spaced normalized form directly.
        stem_norm = " ".join(stem.lower().split())
        if stem_norm in norm:
            return (True, stem)
    return (False, "")


if __name__ == "__main__":
    # CLI: read text from stdin, print a verdict JSON, exit 2 if risky (so it can
    # be chained in a shell pipeline). Not the enforcement path -- that is the
    # PreToolUse hook; this is for manual inspection / debugging.
    txt = sys.stdin.read()
    risky, stem = is_risky_instruction(txt)
    print(json.dumps({"risky": risky, "matched": stem}, ensure_ascii=False))
    sys.exit(2 if risky else 0)
