#!/usr/bin/env python3
"""PreToolUse guardrail hook: last-match-wins permission ruleset (card 13974213).

Implements three fleet-default deny rules for Bash, Write, and Edit tools.
Sibling of guardrail-destructive-bash.py (hard-block) and guardrail-ask-first.py
(ask-first). This hook covers the gaps between them:

  R1 external-dir -- Write/Edit to a path containing .. (cross-worktree HEAD churn,
       stops agents from accidentally writing into a sibling worktree or agent dir)
  R2 env-file-print -- Bash print-verb (cat/head/tail/echo/base64...) reading
       a .env or .env.* file (secret exfiltration, complement to destructive-bash R4
       which guards only ~/.git-credentials)
  R3 external-curl -- Bash curl with a mutating HTTP method (-X POST/PUT/DELETE or
       --request POST/PUT/DELETE) to a non-localhost host (exfiltration / unintended
       external side-effect); read-only GET curl to any host is allowed

Evaluation: rules are iterated in order; the LAST matching rule determines the
outcome (last-match-wins). Default = allow. This is intentional: a per-agent
override appended after the fleet defaults can widen or narrow scope without
rewriting the whole list.

Fail-safe design (NON-NEGOTIABLE):
  - MATCHED-TOOL-ONLY: only Bash, Write, Edit are ever inspected; every other tool
    passes through untouched.
  - DEFAULT-ALLOW: a call is allowed unless it positively matches a deny rule.
  - FAIL-OPEN on internal error: any crash or unreadable input -> allow (exit 0) +
    loud stderr log. Same rationale as sibling hooks: a crashed guard that fails
    CLOSED would block every matched-tool call fleet-wide.

Block mechanism: exit 2 with a reason on stderr (fleet convention). Exit 0 = allow.

Store this hook's threat model alongside the other guardrails in
store/destructive-bash-guard-threat-model.md (the file covers the full PreToolUse
guard family; this hook's rules appear in the permission-rules section).
"""
import sys
import os
import re
import json
import shlex

# ── helpers (shared with destructive-bash) ───────────────────────────────────

_CMD_SUBST_RE = re.compile(r'\$\(|\)|`')

def _split_subcommands(command):
    """Split on shell sequencing operators + command substitution boundaries."""
    normalized = _CMD_SUBST_RE.sub(';', command)
    return re.split(r'(?:&&|\|\||[;|\n])', normalized)

def _tokenize(piece):
    try:
        return shlex.split(piece, comments=False, posix=True)
    except ValueError:
        return None

def _command_word(tokens):
    for tok in tokens:
        if tok == 'sudo':
            continue
        if '=' in tok and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', tok):
            continue
        return os.path.basename(tok)
    return ''

# Verbs that read their positional argument AS A FILE (not as a string to print).
# echo/printf are intentionally absent: they print their string ARGUMENTS, they do
# not read files. `echo $(cat .env)` IS caught because _split_subcommands breaks out
# the inner `cat .env` as its own sub-piece, where `cat` IS in this set.
_FILE_READ_VERBS = frozenset(
    {'cat', 'head', 'tail', 'xxd', 'base64', 'less', 'more', 'strings'}
)

# Localhost / fleet-internal hosts that external-curl allows.
_LOCALHOST_RE = re.compile(
    r'^https?://(?:localhost|127\.0\.0\.1|::1)(?::\d+)?(?:/|$)',
    re.IGNORECASE,
)

# Mutating HTTP methods that trigger external-curl R3.
_MUTATING_METHODS = frozenset({'POST', 'PUT', 'DELETE', 'PATCH'})

# .env file pattern: basename is `.env` or `.env.<something>`.
_ENV_FILE_RE = re.compile(r'(?:^|/)\.env(?:\.[^/\s]+)?$')


# ── R1: external-directory (Write / Edit) ────────────────────────────────────

def match_external_dir(tool_name: str, path: str) -> bool:
    """R1: Write or Edit tool writing to a path that contains '..' (traversal).
    Cross-worktree HEAD churn: agents must never write outside their own project
    subtree. A path containing '..' (before or after join normalisation) is the
    signal; we check the raw string because an agent constructing a path with
    '../' is almost always doing so intentionally (accidental traversal is rare).
    """
    if tool_name not in ('Write', 'Edit'):
        return False
    # Check for .. segments anywhere in the path.
    segments = path.replace('\\', '/').split('/')
    return any(seg == '..' for seg in segments)


# ── R2: .env file print via Bash ─────────────────────────────────────────────

def match_env_file_print(command: str) -> bool:
    """R2: A print-style Bash command reading a .env or .env.* file.
    .env files commonly hold the most sensitive credentials in a project;
    reading them via shell is almost never the right approach (use os.environ
    or a dotenv library). The guard triggers on the FILENAME, not the env var
    name, so it does not interfere with env var expansion like $MY_SECRET.
    """
    for piece in _split_subcommands(command):
        tokens = _tokenize(piece)
        if not tokens:
            continue
        if _command_word(tokens) not in _FILE_READ_VERBS:
            continue
        # Check every non-flag argument for a .env file pattern.
        for tok in tokens[1:]:
            if tok.startswith('-'):
                continue
            if _ENV_FILE_RE.search(tok):
                return True
    return False


# ── R3: external curl with mutating method ───────────────────────────────────

def match_external_curl(command: str) -> bool:
    """R3: Bash `curl` with a mutating HTTP method (-X POST/PUT/DELETE/PATCH or
    --request POST/...) to a non-localhost URL. Read-only GET requests are
    intentionally allowed (documentation, GitHub API reads, WebFetch fallback).
    Localhost / fleet API calls (localhost:3420) are always allowed.

    Rationale: mutating external curl is the canonical exfiltration / unintended
    webhook vector. A prompt-injected agent can POST data to an attacker-controlled
    endpoint; this rule intercepts that before it fires.
    """
    for piece in _split_subcommands(command):
        tokens = _tokenize(piece)
        if not tokens:
            continue
        if _command_word(tokens) != 'curl':
            continue

        method = 'GET'  # curl default
        urls = []
        i = 1
        while i < len(tokens):
            tok = tokens[i]
            if tok in ('-X', '--request') and i + 1 < len(tokens):
                method = tokens[i + 1].upper()
                i += 2
                continue
            if tok.startswith('-X') and len(tok) > 2:
                method = tok[2:].upper()
                i += 1
                continue
            if (tok.startswith('http://') or tok.startswith('https://')):
                urls.append(tok)
            i += 1

        if method not in _MUTATING_METHODS:
            continue
        for url in urls:
            if not _LOCALHOST_RE.match(url):
                return True
    return False


# ── rule table & classifier ───────────────────────────────────────────────────

class Rule:
    __slots__ = ('name', 'reason', 'matcher')

    def __init__(self, name, reason, matcher):
        self.name = name
        self.reason = reason
        self.matcher = matcher


# Fleet-default rules, evaluated in order -- LAST match wins.
RULES = [
    Rule(
        'external-dir',
        'Write/Edit to a path with .. (cross-worktree traversal; stops agents from '
        'writing outside the project into a sibling worktree or agent directory)',
        lambda tool, inp: match_external_dir(tool, inp),
    ),
    Rule(
        'env-file-print',
        'Bash print-verb reading a .env/.env.* file '
        '(secret exfiltration; use os.environ or a dotenv library instead)',
        lambda tool, inp: match_env_file_print(inp) if tool == 'Bash' else False,
    ),
    Rule(
        'external-curl',
        'Bash curl with a mutating method (POST/PUT/DELETE/PATCH) to a non-localhost '
        'host (exfiltration / unintended external side-effect; read-only GET allowed)',
        lambda tool, inp: match_external_curl(inp) if tool == 'Bash' else False,
    ),
]


def first_denied_rule(tool_name: str, inp: str):
    """Last-match-wins: iterate all rules, return the last matching deny rule.
    Returns None when no rule matches (default allow)."""
    matched = None
    for rule in RULES:
        try:
            if rule.matcher(tool_name, inp):
                matched = rule
        except Exception:
            continue  # misfiring matcher: fail open per rule
    return matched


def classify(payload):
    """Pure. Returns (denied: bool, rule_name: str, reason: str).
    denied=True only for Write/Edit/Bash that positively matches a deny rule.
    Everything else -> (False, '', '') = pass through."""
    if not isinstance(payload, dict):
        return (False, '', '')
    tool_name = payload.get('tool_name')
    if tool_name not in ('Bash', 'Write', 'Edit'):
        return (False, '', '')  # matched-tool-only
    tool_input = payload.get('tool_input')
    if not isinstance(tool_input, dict):
        return (False, '', '')
    # For Bash the key is 'command'; for Write/Edit it is 'file_path'.
    if tool_name == 'Bash':
        inp = tool_input.get('command')
    else:
        inp = tool_input.get('file_path')
    if not isinstance(inp, str) or not inp.strip():
        return (False, '', '')
    rule = first_denied_rule(tool_name, inp)
    if rule is None:
        return (False, '', '')
    return (True, rule.name, rule.reason)


def _reason(rule_name, reason):
    return (
        "PERMISSION RULES GUARD: this {tool} call is blocked by the '{name}' rule "
        "-- {reason}. This action has been assessed as an unintended / risky "
        "side-effect and is blocked by the fleet-default permission policy. "
        "Do NOT retry or work around it. If this is a genuine, intended operation, "
        "ask marveen (Genesis) for explicit approval or hand it to the operator "
        "(Dominik) to run manually. See store/destructive-bash-guard-threat-model.md "
        "and card 13974213.".format(
            tool='{tool_name}',  # filled at call site
            name=rule_name,
            reason=reason,
        )
    )


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else None
    except Exception:
        sys.exit(0)  # unreadable/malformed -> fail open

    try:
        denied, name, reason = classify(payload)
    except Exception as exc:
        sys.stderr.write(
            'PERMISSION RULES GUARD: internal error, failing open: {}\n'.format(exc)
        )
        sys.exit(0)

    if not denied:
        sys.exit(0)

    tool_name = (payload or {}).get('tool_name', 'tool')
    msg = (
        "PERMISSION RULES GUARD: this {tool} call is blocked by the '{name}' rule "
        "-- {reason}. Do NOT retry or work around it. If this is a genuine, intended "
        "operation, ask marveen (Genesis) for explicit approval or hand it to the "
        "operator (Dominik) to run manually. See card 13974213."
    ).format(tool=tool_name, name=name, reason=reason)
    sys.stderr.write(msg + '\n')
    sys.exit(2)


if __name__ == '__main__':
    main()
