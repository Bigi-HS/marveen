#!/usr/bin/env python3
"""PreToolUse guardrail hook: epistemic ground-truth gate (card 23adafe9).

Before a fleet agent sends a Boss-facing Telegram reply that contains a
high-confidence fact claim or a Boss-contradiction, verify that the CURRENT
turn actually grounded the claim with a tool-call that reads evidence
(Read, Grep, or a DB/file-reading Bash). If not -- emit an advisory WARN
to stderr and exit 0 (fail-open, same contract as every other guard here).

Guarded tool (matched-tool-only):
  mcp__plugin_telegram_telegram__reply

Design (fail-safe, NON-NEGOTIABLE):
  - MATCHED-TOOL-ONLY: only the reply tool is ever inspected.
  - FAIL-OPEN on any error: exit 0. A bug here must NEVER brick Telegram output.
  - WARN-ONLY (exit 0): advisory line to stderr, not a soft-block.
  - CLAIM-LEDGER: best-effort append to epistemic_claim_log in noa.db.
    A DB write failure must NOT change the exit code (still 0 + WARN).
"""
import json
import os
import re
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

GUARDED_TOOL = "mcp__plugin_telegram_telegram__reply"

# ---------------------------------------------------------------------------
# Contradiction / high-confidence assertion markers (whole-sentence, case-insensitive)
# ---------------------------------------------------------------------------
CONTRADICTION_MARKERS = [
    r"val[oó]j[áa]ban",
    r"nem\s+igaz",
    r"t[ée]vedsz",
    r"nem\s+[úu]gy\s+van",
    r"rosszul\s+tudod",
    r"actually",
    r"that['’]s\s+wrong",
]
_MARKER_RE = re.compile(
    r"(?:" + "|".join(CONTRADICTION_MARKERS) + r")",
    re.IGNORECASE,
)

# A numeric/date token: a digit boundary that is NOT inside a code/path/URL/ID
_CODE_SPAN_RE = re.compile(r"`[^`]*`")
_URL_RE = re.compile(r"https?://\S+")
_PATH_RE = re.compile(r"(?<!\w)/[\w./\-]+")  # forward-slash-rooted paths

_DIGIT_RE = re.compile(r"\b\d")

# Hedge phrases: if the full reply contains these, never flag
_HEDGE_PHRASES = [
    r"nem\s+tudom",
    r"i\s+don['’]t\s+know",
]
_HEDGE_RE = re.compile(r"(?:" + "|".join(_HEDGE_PHRASES) + r")", re.IGNORECASE)

# Sentence splitter: use a capturing group so we can inspect the delimiter.
# We split on sentence-ending punctuation and newlines.
_SENTENCE_SPLIT_RE = re.compile(r"([.!?\n]+)")

# Quoted text patterns (skip sentences that are entirely inside quotes).
# Uses raw strings with ASCII double quote chars only.
_QUOTE_PATTERNS = [
    r'"[^"]*"',                        # ASCII double quotes
    r"'[^']*'",                        # ASCII single quotes
    r"„[^”]*”",         # Hungarian low-9 to right double quote
    r"«[^»]*»",         # guillemets
]
_QUOTE_RE = re.compile(
    r"(?:" + "|".join(_QUOTE_PATTERNS) + r")",
    re.DOTALL,
)

# ---------------------------------------------------------------------------
# Ground-truth tool-call names we accept as evidence
# ---------------------------------------------------------------------------
VERIFY_TOOLS_EXACT = frozenset({"Read", "Grep"})
# Bash command keywords that indicate a file/DB read
_BASH_EVIDENCE_RE = re.compile(
    r"noa\.db|sqlite|/api/|\.db|grep\b|rg\b|cat\b",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Ledger helpers
# ---------------------------------------------------------------------------
_CLAIM_TABLE_DDL = (
    "CREATE TABLE IF NOT EXISTS epistemic_claim_log ("
    "  id INTEGER PRIMARY KEY,"
    "  agent_id TEXT,"
    "  trigger_phrase TEXT,"
    "  excerpt TEXT,"
    "  had_verify INTEGER,"
    "  created_at INTEGER"
    ")"
)
_CLAIM_TABLE_IDX = (
    "CREATE INDEX IF NOT EXISTS idx_eclg_agent "
    "ON epistemic_claim_log(agent_id, created_at)"
)


def _append_claim_log(agent_id, trigger_phrase, excerpt, had_verify):
    """Best-effort write to epistemic_claim_log. Never raises."""
    try:
        path = ledger_lib.db_path()
        con = sqlite3.connect(path, timeout=5)
        try:
            con.execute(_CLAIM_TABLE_DDL)
            con.execute(_CLAIM_TABLE_IDX)
            con.execute(
                "INSERT INTO epistemic_claim_log"
                " (agent_id, trigger_phrase, excerpt, had_verify, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (str(agent_id), str(trigger_phrase), str(excerpt), int(had_verify), int(time.time())),
            )
            con.commit()
        finally:
            con.close()
    except Exception:
        pass  # best-effort; never change exit code


# ---------------------------------------------------------------------------
# Turn-scope ground-truth detection
# ---------------------------------------------------------------------------

def _parse_transcript_jsonl(path):
    """Parse a JSONL transcript and return list of dicts (best-effort)."""
    lines = []
    if not path:
        return lines
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    lines.append(json.loads(raw))
                except Exception:
                    pass
    except Exception:
        pass
    return lines


def _is_real_user_line(entry):
    """True if this is a user turn carrying actual user message content
    (not a tool_result-only response)."""
    if entry.get("type") != "user":
        return False
    msg = entry.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        # A tool_result-only user line has ONLY tool_result blocks
        for block in content:
            if isinstance(block, dict) and block.get("type") != "tool_result":
                return True
        return False
    return False


def has_ground_truth_in_current_turn(transcript_path):
    """Return True if the current turn (since the last real user message) contains
    at least one evidence-bearing tool call: Read, Grep, or a DB/file-reading Bash.
    """
    entries = _parse_transcript_jsonl(transcript_path)
    if not entries:
        return False

    # Find the last real user line index
    last_user_idx = None
    for i, entry in enumerate(entries):
        if _is_real_user_line(entry):
            last_user_idx = i

    if last_user_idx is None:
        # No user message found -- can't determine turn boundary; fail-open
        return True

    # Scan assistant entries AFTER the last real user line
    for entry in entries[last_user_idx + 1:]:
        if entry.get("type") != "assistant":
            continue
        msg = entry.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") != "tool_use":
                continue
            name = block.get("name", "")
            if name in VERIFY_TOOLS_EXACT:
                return True
            if name == "Bash":
                cmd = (block.get("input") or {}).get("command") or ""
                if _BASH_EVIDENCE_RE.search(cmd):
                    return True

    return False


# ---------------------------------------------------------------------------
# Claim detection
# ---------------------------------------------------------------------------

def _strip_exclusion_spans(text):
    """Remove code spans, URLs, and paths from text to avoid false-positive
    digit matches inside identifiers/URLs/paths."""
    t = _CODE_SPAN_RE.sub(" ", text)
    t = _URL_RE.sub(" ", t)
    t = _PATH_RE.sub(" ", t)
    return t


_OPEN_QUOTE_CHARS = frozenset({'"', "'", '“', '„', '«'})


def _is_quoted_sentence(sentence):
    """True if the sentence is entirely within a quoted span.

    Handles two cases:
    1. The whole sentence is wrapped in quotes: _QUOTE_RE removes everything.
    2. The sentence is a fragment starting with a quote char (the period-split
       broke a quoted clause like '"Foo bar." -> '"Foo bar' + '.' + '" more'
       -- the opening fragment starts with a quote and has no closing match).
    """
    stripped = sentence.strip()
    if not stripped:
        return True
    # Case 2: sentence starts with an opening quote char -> treat as quoted fragment
    if stripped[0] in _OPEN_QUOTE_CHARS:
        return True
    # Case 1: remove all quote spans; if nothing real remains, it was all quoted
    cleaned = _QUOTE_RE.sub("", stripped).strip()
    return not cleaned


def find_claim_trigger(text):
    """Return the first trigger phrase found in `text` that satisfies the
    conjunctive rule (marker + digit in same sentence, not quoted, not question).
    Returns the phrase string or None.

    Uses a capturing-group split so we can inspect whether the sentence was
    terminated by '?' and skip it (questions don't assert facts).
    """
    # Split keeping delimiters: even indices are sentence text, odd are delimiters
    parts = _SENTENCE_SPLIT_RE.split(text)
    i = 0
    while i < len(parts):
        sentence = parts[i]
        # The delimiter immediately follows the sentence text (if present)
        delimiter = parts[i + 1] if (i + 1) < len(parts) else ""
        i += 2

        if not sentence.strip():
            continue
        # Skip question sentences: terminated by '?'
        if "?" in delimiter:
            continue
        if _is_quoted_sentence(sentence):
            continue
        m = _MARKER_RE.search(sentence)
        if not m:
            continue
        # Check for numeric/date token in the sanitized version of this sentence
        clean = _strip_exclusion_spans(sentence)
        if _DIGIT_RE.search(clean):
            return m.group(0)
    return None


def is_hedged(text):
    """Return True if the reply contains a hedge phrase (nem tudom / i don\'t know)."""
    return bool(_HEDGE_RE.search(text))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else None
    except Exception:
        sys.exit(0)  # fail-open: malformed/missing stdin

    try:
        if not isinstance(payload, dict):
            sys.exit(0)

        tool_name = payload.get("tool_name", "")
        if tool_name != GUARDED_TOOL:
            sys.exit(0)  # only act on the reply tool

        tool_input = payload.get("tool_input") or {}
        if not isinstance(tool_input, dict):
            sys.exit(0)

        text = tool_input.get("text") or ""
        if not text:
            sys.exit(0)

        # Hedge override: never flag if the reply contains a hedge phrase
        if is_hedged(text):
            sys.exit(0)

        trigger_phrase = find_claim_trigger(text)
        if not trigger_phrase:
            sys.exit(0)

        # We have a trigger -- check for ground-truth in this turn
        transcript_path = payload.get("transcript_path")
        had_verify = has_ground_truth_in_current_turn(transcript_path)

        if had_verify:
            sys.exit(0)

        # Flag: WARN on stderr, append audit row, exit 0 (fail-open)
        agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
        excerpt = text[:120].replace("\n", " ")

        sys.stderr.write(
            "EPISTEMIC-GATE WARN: Boss-facing reply tartalmaz ellentmondas-markert "
            "('{}') utan szamot/datumot, de az aktualis turnben nincs ground-truth "
            "verifykalo tool-hivas (Read/Grep/DB-Bash). "
            "Ellenorizd az allitast mielott elkuldod.\n".format(trigger_phrase)
        )

        _append_claim_log(agent_id, trigger_phrase, excerpt, had_verify=0)

    except Exception as exc:
        sys.stderr.write("EPISTEMIC-GATE: internal error, failing open: {}\n".format(exc))

    sys.exit(0)


if __name__ == "__main__":
    main()
