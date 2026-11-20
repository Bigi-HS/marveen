#!/usr/bin/env python3
"""PreToolUse guardrail hook: blanket-GO engedelykero-warn (card f8e81574).

RECURRING FAILURE (Boss TG10317, 2026-11-17): a blanket autonomia-mandatum
(2027-01-31-ig) ellenere NoA ismetlodoen ujra-keri Boss engedelyet
deploy/telepites/onallo dontesre.

Ez a hook a name-gate-mintat koveti: Boss-facing (Telegram reply/edit) szovegben
elkapja az engedelykero mintakat ES -- amig a blanket-GO ablak aktiv (datum <
2027-02-01) -- SOFT-BLOCK (exit 2) figyelmeztetovel emlekeztet:
  "blanket-GO aktiv, hajts es jelents, ne kerdezz"
+ a 4 valodi kivetel emlekeztetoje.

Nem HARD-block: az agent el tudja kuldeni, ha javit; a csekkpontok a 4 kivetel.

Design (fail-OPEN, NON-NEGOTIABLE -- identical sibling convention to name-gate):
  - MATCHED-TOOL-ONLY: csak a Boss-facing Telegram-eszkozok triggerelhetnek.
    Minden mas eszkoz pass-through (exit 0).
  - FAIL-OPEN on any error (crash, date parse fail, regex fail): exit 0.
    Guard-bug soha ne tegye brickelesse az agent Telegram-kimenetjet.
  - DEFAULT-ALLOW: csak pozitivan azonositott engedelykero mintara aktivodik.
  - SOFT-BLOCK (exit 2): nem auto-rewrites; az agentnek kell javitania.
  - DATUM-GATE: ha a mai datum >= 2027-02-01, a hook teljesen inaktiv (exit 0).
    A blanket-GO ablak automatikusan lejart.

Guarded tools:
  - mcp__plugin_telegram_telegram__reply
  - mcp__plugin_telegram_telegram__edit_message

Kivetelezett esetek (a 4 legitim "mikor szabad megis kerdezni"):
  1. Irreverzibilis akcio + preferencia-ketertelmuseg (Boss izlese dontendo)
  2. Scope-on-tuli penz-/jog-/publikus-tartalom-dontesek
  3. Security-BLOCK (guardrail tiltotta)
  4. Mas agenssel nem donto konzultacio (nem Go-keres, hanem kontextus)
"""
import sys
import os
import json
import re
from datetime import date


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GUARDED_MCP_TOOLS = frozenset({
    "mcp__plugin_telegram_telegram__reply",
    "mcp__plugin_telegram_telegram__edit_message",
})

# Blanket-GO ablak vege (exkluziv): 2027-02-01-tol a hook inaktiv
BLANKET_GO_EXPIRES = date(2027, 2, 1)

# Engedelykero regex-mintak (hu/en, case-insensitive).
# Minden minta egy-ket szaval jellemzi az engedelykero hangot.
# Cel: elkapni az ismetlodo "GO-dra var", "elesithet", "jovahagyod" stb. fordulatokat.
# FONTOS: a mintak SZANDEKOSAN TAGUAK (soft-block: false positive csak 1x korrekcioba
# kerul, false negative megengedi a behavior-t ami a card-ot kivalto volt).
PERMISSION_PATTERNS = [
    r'\bGO[-\s]?dra\s+var',          # "GO-dra var", "GOdra var"
    r'\beles[ií]t(?!ett)\w*\b',       # "elesithet", "Elesithed", "elesitheti"; NOT past-tense (-ettem/-ette)
    r'\bjovahagyod',                  # "jovahagyod"
    r'\bjov[aá]hagy(?:od|sz|d|j|hatod|hatsz)\b',  # 2nd-person/imperative only; NOT past-tense (-yta/-ytam)
    r'\benged[eé]lyezed',             # "engedelyezed"
    r'\benged[eé]lyezz',              # "engedelyezz"
    r'\bk[eé]rdelek\b',              # "kerdezlek"
    r'\bszabad[-\s]e\b',             # "szabad-e"
    r'\bszabad[-\s]+e\b',            # "szabad e"
    r'\bbekell[-\s]?k[eé]rnem\b',   # "bekell kernem" (edge)
    r'\bv[aá]rod[-\s]+(?:a\s+)?GO', # "varod a GO", "varod-e GO"
    r'\bv[aá]r(?:ok|j)?[-\s]+(?:a\s+)?GO', # "varok a GOdra"
    r'\b(?:megk[eé]rlek|megk[eé]rdezn[eé]lek)',  # "megkerlek", "megkerdeznelek"
    r'\bbeleegyezel\b',              # "beleegyezel"
    r'\bj[oó]v[aá]hagy[aá]sod(?:ra)?\b',  # "jovahagyasodra"
    r'\b(?:felt[eé]tel[eé]z|k[eé]r[eé]sed)\b',  # "feltetelezed", "keresed"
    r'\b(?:engedsz|engeded)\b',      # "engedsz", "engeded"
    r'\b(?:bele?egyez[eé]s|hozz[aá]j[aá]rul[aá]s)',  # "beleegyezes", "hozzajarulas"
    # English variants (agent might mix)
    r'\b(?:your\s+)?GO[-\s]ahead',   # "GO-ahead", "your GO ahead"
    r'\bawait(?:ing)?\s+(?:your\s+)?(?:approval|permission|ok|go)',
    r'\bwait(?:ing)?\s+(?:for\s+)?(?:your\s+)?(?:approval|permission|go)',
    r'\bdo\s+(?:i\s+)?have\s+(?:your\s+)?(?:permission|ok|go)',
    r'\bplease\s+(?:approve|confirm|authorize)',
    r'\bshould\s+i\s+proceed\b',
    r'\bis\s+it\s+ok\s+(?:if\s+i\b|to\s+(?:deploy|run|send|delete|publish|proceed|merge|push|release)\b)',
    r'\bcan\s+i\s+(?:go\s+ahead|proceed|deploy|run)\b',
    r'\bok\s+(?:to|if\s+i)\b.*(?:deploy|send|run|delete|publish)',
]

# Kompilalt regex (case-insensitive, Unicode)
_COMPILED_PATTERNS = [
    re.compile(p, re.IGNORECASE | re.UNICODE) for p in PERMISSION_PATTERNS
]

# A warn uzenet (a nemet stilusu fleet-szoveg)
_WARN_MSG = (
    "BLANKET-GO WARN: engedelykero megfogalmazas erkelt Boss-facing szovegben. "
    "A blanket autonomia-mandatum {expires}-ig aktiv: hajts es jelents, ne kerdezz.\n"
    "Kivetelezett esetek (csak ezekben szabad megkerdezni):\n"
    "  1. Irreverzibilis akcio + Boss izlese/preferenciaja ketbirtoku (nem dontod el helyette)\n"
    "  2. Scope-on-tuli penz, jog, vagy nyilvanos publikalas\n"
    "  3. Security-BLOCK: egy guardrail hardblock-olta az akciod\n"
    "  4. Mas agenssel konzultalsz kontextusert (nem GO-keres)\n"
    "Ha egyik sem all fenn, javits: mondj dontest es jelents eredmenyt."
).format(expires=BLANKET_GO_EXPIRES.isoformat())


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

def blanket_go_active(today=None):
    """Return True if the blanket-GO window is still active (today < expires).

    `today` is injectable for tests (date object). Falls back to date.today().
    FAIL-OPEN: on any date parsing error, returns False (hook inactive).
    """
    try:
        if today is None:
            today = date.today()
        return today < BLANKET_GO_EXPIRES
    except Exception:
        return False  # fail open: broken date logic -> hook inactive


def extract_text(payload):
    """Extract Boss-facing outgoing text from the tool call payload.

    Returns (text: str | None, is_guarded: bool).
    is_guarded=False means the tool is outside our scope -> caller exits 0.
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

    return None, False


def contains_permission_request(text):
    """Return True if `text` matches any engedelykero pattern.

    Case-insensitive. Pure (no I/O). FAIL-OPEN: on any regex error returns False.
    """
    if not isinstance(text, str) or not text.strip():
        return False
    try:
        for pat in _COMPILED_PATTERNS:
            if pat.search(text):
                return True
        return False
    except Exception:
        return False  # fail open: regex error -> don't block


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else None
    except Exception:
        sys.exit(0)  # fail open: unreadable/malformed input

    try:
        # 1. Tool-scope gate (matched-tool-only)
        text, is_guarded = extract_text(payload)
        if not is_guarded or not text:
            sys.exit(0)

        # 2. Datum-gate: ha a blanket-GO ablak lejart, a hook inaktiv
        if not blanket_go_active():
            sys.exit(0)

        # 3. Pattern match
        if not contains_permission_request(text):
            sys.exit(0)

        # 4. Soft-block: figyelmeztet, de az agent javithat es ujra probalkozhat
        sys.stderr.write(_WARN_MSG + "\n")
        sys.exit(2)

    except Exception as exc:
        sys.stderr.write(
            "BLANKET-GO WARN: internal error, failing open: {}\n".format(exc)
        )
        sys.exit(0)


if __name__ == "__main__":
    main()
