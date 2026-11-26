#!/usr/bin/env python3
"""PreToolUse hook (SEC-119): outbound PII / content egress-filter guard.

Fires on a CLOSED SET of egress surfaces:
  (a) MCP data-carrying sends: gmail_send and drive_upload_file for BOTH
      google providers (claudia_google / bigben_google). Read-only ops and
      non-data-carrying ops (trash, delete, filter) are NOT in scope here --
      they are guarded by guardrail-ask-first.py.
  (b) Bash commands that reach:
        - an n8n webhook URL on :5678/webhook/ in ANY loopback spelling
          (127.0.0.1 / localhost / [::1]) -- external effect even though the
          host is local, because n8n forwards the webhook outward.
        - any non-local http(s):// target via curl or wget.
      Local-only targets (localhost / 127.0.0.1 / ::1) are NOT blocked EXCEPT
      the n8n webhook port 5678. The inter-agent /api/messages Bash path is
      NOT double-blocked here (owned by pii-injection-scan.py).

For a matched call the payload text is extracted and scanned with the PII
patterns copied verbatim from pii-injection-scan.py (source of truth). On a
HIT: BLOCK (exit 2), print the matched categories on stderr, append one
[egress-block] line to store/aidefence.log.

FAIL-OPEN / CLOSED-ENUM (NON-NEGOTIABLE, identical to siblings):
  - ONLY a positively-matched egress surface can ever block.
  - ANY parse error / exception / unwritable log -> exit 0 (allow), with the
    exception audited to stderr so a crashed scanner is distinguishable from
    a clean scan.
  - Non-egress tools pass through untouched (exit 0, no stderr).

Calibration residuals (v1 known, do NOT try to close here):
  (1) Owner's own email/phone in a legitimately-sent mail triggers the PII
      block. v1 convention matches pii-injection-scan.py: block-and-tell,
      let the agent redact. A future allow-list of owner PII is a v2 concern.
  (2) n8n webhook health payloads (zepp/heal) may carry long numeric runs
      that trip the 13-16 digit credit-card-like pattern. The pattern is kept
      as-is for v1; a future tightening (e.g., Luhn check or narrower context)
      may reduce this. Do NOT silently weaken the pattern.
  (3) Bash-layer bypass via Python requests, Node fetch, etc. is inherent to
      the hook's scope (Bash command scanner only). The authoritative boundary
      for non-Bash egress is per-agent scoped credentials; this hook does not
      and cannot close that gap.
"""
import sys
import os
import json
import re
from datetime import datetime

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AUDIT_LOG = os.path.join(INSTALL_DIR, "store", "aidefence.log")

# Closed set of MCP data-carrying egress tools (gmail_send + drive_upload_file
# for both google providers). Modeled on guardrail-ask-first.py GUARDED_TOOLS
# shape. Restricted to data-CARRYING sends, NOT trash/delete/filter ops.
EGRESS_TOOLS = frozenset({
    "mcp__claudia_google__gmail_send",
    "mcp__claudia_google__drive_upload_file",
    "mcp__bigben_google__gmail_send",
    "mcp__bigben_google__drive_upload_file",
})

# PII patterns copied verbatim from scripts/hooks/pii-injection-scan.py.
# Source of truth for the pattern set is that file. Keep in sync.
PII_PATTERNS = {
    "email": re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),
    "phone": re.compile(r"(?<!\d)(?:\+?\d[\d \-]{8,}\d)(?!\d)"),
    "credit-card": re.compile(r"(?<!\d)(?:\d[ -]?){13,16}(?!\d)"),
    "api-key": re.compile(r"\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|[A-Fa-f0-9]{32,})\b"),
}

# Bash egress matchers.
# (a) n8n webhook port 5678 -- external effect even on loopback. n8n forwards
#     the webhook OUTWARD (it is an egress proxy), so the loopback HOST SPELLING
#     does not make it safe: cover every loopback form (127.0.0.1 / localhost /
#     [::1]) on :5678/webhook/. (v1 matched only 127.0.0.1, letting the
#     `localhost:5678/webhook/` spelling slip the scan -- a real exfil hole.)
#     `/+webhook/` matches one OR MORE slashes: `//webhook/` (double-slash) is a
#     valid URL that n8n normalizes to the same route, so it must not slip the
#     scan (a single `/webhook/` anchor let `localhost:5678//webhook/` bypass).
#     SEPARATOR-NORMALIZATION CLASS (card 0b8c31ed): the separator between :5678
#     and `webhook/` now accepts any mix of the path-normalization bypass family,
#     not just literal slashes:
#       - `/`      literal slash (incl. `//`, already covered by `/+`)
#       - `/./`    dot-segment -- a REAL live egress: curl CLIENT-normalizes
#                  `:5678/./webhook/` to `:5678/webhook/` BEFORE sending, so the
#                  bytes that actually leave the box hit the n8n webhook route.
#                  Missing it = a silent exfil hole. MUST be caught.
#       - `%2f`/`%2F`  url-encoded slash -- defense-in-depth over-match. Current
#                  n8n does NOT path-decode this (it falls to the SPA, harmless),
#                  but encode-the-separator is a classic bypass family, so we
#                  over-approximate toward the SAFE direction and future-proof it.
#     This is INTENTIONAL over-approximation toward SAFE: a false-block on n8n
#     egress is cheap, a missed exfil is not. Anchored to :5678 only (n8n-only);
#     it does NOT over-match generic traffic because the :5678/.../webhook/ shape
#     stays required.
_N8N_WEBHOOK_RX = re.compile(
    r"https?://(?:127\.0\.0\.1|localhost|\[::1\]):5678"
    r"(?:/|/\./|%2f)+webhook/",
    re.IGNORECASE,
)
# (b) Non-local http(s) target via curl or wget.
#     Negative lookahead excludes localhost / 127.0.0.1 / ::1 (non-5678 ports
#     of these hosts are safe). The n8n check above already handles the
#     :5678/webhook/ egress for every loopback spelling.
#     The inter-agent /api/messages curl is NOT matched here (pii-injection-scan.py
#     owns that surface). We match the verb+URL structure with a bounded gap to
#     avoid quadratic backtracking on pathological inputs.
_CURL_NONLOCAL_RX = re.compile(
    r"\b(?:curl|wget)\b.{0,500}?https?://(?!localhost(?:[:/]|$)|127\.0\.0\.1(?:[:/]|$)|::1(?:[:/]|$))",
    re.IGNORECASE | re.DOTALL,
)

# How deep _flatten descends before truncating.
_MAX_DEPTH = 8


def _flatten(obj, depth: int = 0) -> str:
    """Recursively flatten a tool_input dict to a string for PII scanning.
    Bounded depth to avoid stack overflow / time attacks. Modeled on
    mcp-output-pi-scan.py _flatten.
    """
    if depth > _MAX_DEPTH:
        return ""
    if isinstance(obj, str):
        return obj
    if isinstance(obj, list):
        return "\n".join(_flatten(x, depth + 1) for x in obj)
    if isinstance(obj, dict):
        parts = []
        for value in obj.values():
            parts.append(_flatten(value, depth + 1))
        return "\n".join(p for p in parts if p)
    return str(obj)


def _extract_payload_text(cmd: str) -> str:
    """Best-effort extraction of the POST body from a curl/wget command.
    Handles:
      - spaced form:  -d 'PAYLOAD' / --data 'PAYLOAD' / --data-raw 'PAYLOAD'
      - glued form:   -dPAYLOAD (no space; adversarial case per spec)
    Falls back to the full command string.

    Source of pattern idea: pii-injection-scan.py _extract_payload_text,
    extended to handle glued flag form.
    """
    # Spaced form: -d/--data/--data-raw followed by optional space then quoted or bare value.
    m = re.search(r"(?:--data(?:-raw)?|-d)\s+(['\"])(.*?)\1", cmd, re.DOTALL)
    if m:
        return m.group(2)
    # Glued form: -dPAYLOAD (flag and value with no space). Note: -d must be
    # immediately followed by non-space content that is not another flag char.
    m = re.search(r"-d([^\s'\"-][^\s]*)", cmd)
    if m:
        return m.group(1)
    return cmd


def _is_bash_egress(cmd: str) -> bool:
    """Return True if this Bash command targets an egress surface we scan."""
    # n8n webhook (port 5678 on loopback) -- always egress.
    if _N8N_WEBHOOK_RX.search(cmd):
        return True
    # Non-local http(s) curl/wget -- egress. The inter-agent /api/messages path
    # stays out: its host is localhost:3420 and the negative lookahead excludes
    # localhost, so it passes through cleanly.
    if _CURL_NONLOCAL_RX.search(cmd):
        return True
    return False


def _scan_pii(text: str) -> list:
    """Return list of matched PII category names."""
    hits = []
    for label, rx in PII_PATTERNS.items():
        if rx.search(text):
            hits.append(label)
    return hits


def _audit(tag: str) -> None:
    """Append one [egress-block] line to the aidefence.log audit trail.
    Never raises (fail-open guarantee).
    """
    try:
        ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        with open(AUDIT_LOG, "a") as f:
            f.write(f"{ts} [egress-block] {tag}\n")
    except Exception:
        pass


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        # Fail-open: malformed/empty stdin -> allow; audit so a crash is visible.
        sys.stderr.write(f"[egress-pii-scan] parse error (fail-open): {exc}\n")
        sys.exit(0)

    if not isinstance(payload, dict):
        sys.exit(0)

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}

    try:
        # --- MCP egress surface ---
        if tool_name in EGRESS_TOOLS:
            text = _flatten(tool_input)
            hits = _scan_pii(text)
            if hits:
                tag = f"tool={tool_name} pii={hits}"
                sys.stderr.write(
                    f"EGRESS PII BLOCK: tool '{tool_name}' payload contains "
                    f"PII category(s): {', '.join(hits)}. Redact PII before sending.\n"
                )
                _audit(tag)
                sys.exit(2)
            sys.exit(0)

        # --- Bash egress surface ---
        if tool_name == "Bash":
            cmd = tool_input.get("command", "") if isinstance(tool_input, dict) else ""
            if not _is_bash_egress(cmd):
                sys.exit(0)
            body = _extract_payload_text(cmd)
            hits = _scan_pii(body)
            if hits:
                tag = f"tool=Bash pii={hits}"
                sys.stderr.write(
                    f"EGRESS PII BLOCK: Bash command targets an egress surface and "
                    f"contains PII category(s): {', '.join(hits)}. Redact PII before sending.\n"
                )
                _audit(tag)
                sys.exit(2)
            sys.exit(0)

    except Exception as exc:
        # Fail-open: any internal error -> allow; note to stderr for auditing.
        sys.stderr.write(f"[egress-pii-scan] scan error (fail-open): {exc}\n")
        sys.exit(0)

    # Non-egress tool: pass through untouched.
    sys.exit(0)


if __name__ == "__main__":
    main()
