#!/usr/bin/env python3
"""PreToolUse guardrail hook: HARD-BLOCK a narrow set of catastrophic Bash
commands (card dd48afb6, GitHub-adoption meeting 06-16).

This is the sibling of guardrail-ask-first.py, kept as a SEPARATE file on
purpose (NoA decision 06-16, option B): one hook = one responsibility, and the
two fail-policies must not be mixed in one file. ask-first is a "pause and route
to marveen for one-shot approval" gate over irreversible *MCP* tools and is
FAIL-OPEN; this hook is a flat, unconditional HARD-DENY over a handful of
unambiguously destructive *Bash* commands with no approval path.

It is DEFENSE-IN-DEPTH, not a sandbox. The primary boundaries stay the per-agent
filesystem permissions, scoped credentials, and the human merge/deploy gate. A
determined malicious agent can evade a regex (base64, variable indirection,
splitting a command); we only raise the bar against the two realistic vectors:
prompt-injection-induced and accidental destructive commands. See
store/destructive-bash-guard-threat-model.md for the full model.

Fail-safe design (NON-NEGOTIABLE):
  - MATCHED-BASH-ONLY: only the `Bash` tool is ever inspected; every other tool
    passes through untouched.
  - DEFAULT-ALLOW: a Bash command is allowed unless it positively matches one of
    the NARROW deny rules below. The narrowness + the adversarial fixture set
    (test_guardrail_destructive_bash.py) are what prevent a too-broad pattern
    from blocking a legitimate fleet op (self-inflicted false-positive DoS).
  - FAIL-OPEN on internal error: unreadable/malformed stdin or any compute crash
    -> allow (exit 0) + a loud stderr log. A crashed hook that failed CLOSED
    would block every Bash call on every agent = instant fleet-wide outage, far
    worse than the rare window where this secondary guard is briefly down. The
    platform default for a crashed PreToolUse hook is already fail-open.

Block mechanism: exit 2 with a reason on stderr (the fleet convention). Exit 0
= allow.
"""
import sys
import os
import re
import json
import shlex

# Protected branches whose history must never be force-rewritten by an agent.
PROTECTED_BRANCHES = ("main", "develop")

# Top-level roots that must never be the target of a recursive force-delete.
# Matched as a WHOLE argument token (shlex keeps ~ and $HOME literal -> good).
_RM_ROOT_RE = re.compile(
    r"^(?:/|~|~/|\$HOME/?|\$\{HOME\}/?|/home/[^/]+/?)$"
)

# A .git-credentials path as a WHOLE token (the raw PAT file; never legitimately
# shell-printed -- the merge recipe extracts it in-process via python).
_CRED_FILE_RE = re.compile(
    r"^(?:~|\$HOME|\$\{HOME\}|/home/[^/]+)?/?\.git-credentials$"
)

# R4-enum (card 48d3c0f9): a CLOSED set of additional high-sensitivity files that
# are never legitimately printed through a shell. Each matched as a WHOLE token
# (shlex keeps ~ / $HOME literal). Scope agreed with Chad (the gate owner):
#   - SSH PRIVATE keys ~/.ssh/id_*  (the .pub is public -> excluded via lookahead)
#   - ~/.netrc, ~/.aws/credentials
#   - store/.session-secret, store/.dashboard-session-secret (dashboard signing keys)
#   - store/.claude-session  (Dominik's claude.ai sessionKey + cf_clearance; a
#     FULL-ACCOUNT bearer credential -- card 7fe5662f usage panel. Additive
#     hardening: strengthens the blocklist, never a bypass.)
#   - oauth-tokens.json  (OAuth refresh tokens, in any channel dir)
# DELIBERATELY OUT OF SCOPE: store/.dashboard-token (fleet-ops idiom, read in every
# recipe), .env/.env.* (covered by the permission-ruleset R2), ~/.git-credentials
# (already _CRED_FILE_RE above), ~/.aws/config (false-positive risky).
_HOME_PREFIX = r"(?:~|\$HOME|\$\{HOME\}|/home/[^/]+)"
_SENSITIVE_FILE_RES = (
    re.compile(rf"^{_HOME_PREFIX}/\.ssh/id_(?!.*\.pub$)[^/]*$"),  # SSH private key, not .pub
    re.compile(rf"^{_HOME_PREFIX}/\.netrc$"),
    re.compile(rf"^{_HOME_PREFIX}/\.aws/credentials$"),
    re.compile(r"^(?:.*/)?store/\.session-secret$"),
    re.compile(r"^(?:.*/)?store/\.dashboard-session-secret$"),
    re.compile(r"^(?:.*/)?store/\.claude-session$"),
    re.compile(r"^(?:.*/)?oauth-tokens\.json$"),
)

_PRINT_VERBS = frozenset(
    # tac (reverse-cat) and od (octal/hex dump) both read+emit raw file content,
    # so they exfil a credential file just like cat/strings (card 6f5af73d).
    {"cat", "echo", "printf", "head", "tail", "tac", "od", "xxd", "base64", "less", "more", "strings"}
)
_SQL_CLIENTS = frozenset({"sqlite3", "psql", "mysql", "mariadb"})

# DROP/TRUNCATE of a TABLE/DATABASE, anywhere in the command (case-insensitive).
_SQL_DROP_RE = re.compile(r"\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE)\b", re.IGNORECASE)


def _split_subcommands(command, *, nested=True):
    """Split a command line into the pieces that each start with their own
    command word, on the shell operators that sequence commands and on
    command-substitution boundaries. Lets us catch `echo x && rm -rf ~` and the
    inner `rm` of `$( ... )` while keeping per-piece command-word context.

    Quote-aware, and that is the point of card 151a0756. This file used to find
    the substitution boundaries in a regex PRE-PASS over the raw string, blind
    to quoting, so a close paren inside a quoted ARGUMENT was rewritten to a
    separator and the split landed in the middle of the string. Both halves were
    left with an unbalanced quote, `_tokenize` raised, and every rule skips a
    piece it cannot tokenize -- so the dangerous piece was never examined:

        rm -rf /            -> ['rm -rf /']              BLOCK
        rm -rf / "note )"   -> ['rm -rf / "note ', '"']  allow

    Five rules, four quoted forms, twenty cells, all open, and no wrapper
    needed. Finding the boundaries DURING this scan is what closes it: a close
    paren is a boundary only where bash treats it as one.

    `nested=False` yields top-level segments instead. Nothing in this file calls
    that mode; it is carried so that both copies of this function stay identical,
    which SiblingSourceIdentityTests asserts.

    The two guards hold COPIES rather than importing one shared module on
    purpose: promote-guard.py promotes a SINGLE file into .guard/, so an import
    of a neighbouring module would resolve against a directory that does not
    contain it, the hook would raise on every invocation, and a crashing hook
    fails open on everything. The duplication is deliberate; the test is what
    keeps it honest.
    """
    command = re.sub(r'\\\n[ \t]*', ' ', command)
    parts: list[str] = []
    buf: list[str] = []
    # Quote state saved on entering a substitution: a substitution starts a
    # FRESH quoting context, so `"$(cat '.env')"` must honour the inner single
    # quotes rather than inherit the outer double ones.
    stack: list[tuple[bool, bool, str]] = []
    in_sq = False  # inside '...'
    in_dq = False  # inside "..."

    def _open_substitution(opener, closer):
        """Flush the enclosing fragment and start the nested command.

        The flushed fragment must stay parseable on its own: lifting
        `$(...)` out of `-H "Bearer $(cat f)"` would otherwise leave a dangling
        `"` behind, shlex raises, and the piece becomes _PARSE_FAIL -- turning a
        readable command into a fail-closed block. So the open quote is closed on
        the way out and re-opened on the way back in.

        In top-level mode nothing is flushed: the substitution keeps its literal
        text inside the enclosing segment, and the stack only records that we are
        no longer at top level.
        """
        nonlocal buf, in_sq, in_dq
        if nested:
            parts.append(''.join(buf) + ('"' if in_dq else ''))
            buf = []
        else:
            buf.append(opener)
        stack.append((in_sq, in_dq, closer))
        in_sq = in_dq = False

    def _close_substitution(closer):
        nonlocal buf, in_sq, in_dq
        if nested:
            parts.append(''.join(buf))
            in_sq, in_dq, _ = stack.pop()
            buf = ['"'] if in_dq else []
        else:
            buf.append(closer)
            in_sq, in_dq, _ = stack.pop()

    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        nxt = command[i + 1] if i + 1 < n else ''

        # Inside double quotes a backslash escapes only these four; unquoted it
        # escapes anything -- `find . \( -name x \)` must not be read as a
        # subshell.  Inside single quotes a backslash is literal.
        if ch == '\\' and not in_sq and nxt:
            if in_dq and nxt not in ('"', '$', '`', '\\'):
                buf.append(ch); i += 1
                continue
            buf.append(ch); buf.append(nxt); i += 2
            continue

        if ch == "'" and not in_dq:
            in_sq = not in_sq
            buf.append(ch); i += 1
            continue
        if ch == '"' and not in_sq:
            in_dq = not in_dq
            buf.append(ch); i += 1
            continue

        if not in_sq and ch == '$' and nxt == '(':
            _open_substitution('$(', ')')
            i += 2
            continue
        if not in_sq and ch == '`':
            # In nested mode a closing backtick simply opens another (empty)
            # piece, which is harmless there. Top-level mode must actually close,
            # or the rest of the command would stay inside a substitution that
            # never ends and would never split into segments again.
            if not nested and stack and stack[-1][2] == '`':
                _close_substitution('`')
            else:
                _open_substitution('`', '`')
            i += 1
            continue
        if not in_sq and not in_dq and ch in '<>' and nxt == '(':
            _open_substitution(ch + '(', ')')
            i += 2
            continue
        # A bare `( ... )` subshell at command position is a nested command too:
        # `(curl -X PUT ...)` must still classify as curl (card ec7754d7).  Only
        # at command position -- a stray '(' inside an argument is not an opener.
        if (not in_sq and not in_dq and ch == '('
                and not ''.join(buf).strip().split(';')[-1].strip()):
            _open_substitution('(', ')')
            i += 1
            continue
        # The closer has to be as quote-aware as the openers above, or a close
        # paren sitting inside quotes INSIDE the substitution pops the stack
        # early and swallows the rest of the command into one piece -- the same
        # endpoint as the defect this function was rewritten to fix (DA-62-C).
        # Measured: `echo "$(echo 'x)' ; echo M)"` prints M, so that paren
        # closes nothing.  The stack reset means in_sq/in_dq here are the
        # substitution's OWN quotes, not the enclosing ones.
        # Nested mode pops on ANY ')' with a non-empty stack, unchanged. Top-level
        # mode requires the opener to match, so a ')' inside a backtick pair does
        # not end the segment early.
        if (ch == ')' and stack and not in_sq and not in_dq
                and (nested or stack[-1][2] == ')')):
            _close_substitution(')')
            i += 1
            continue

        # Separators split only at top level. In nested mode the stack is empty
        # whenever we are inside a substitution's own piece, so this reads the
        # same as before; in top-level mode it keeps `a $(b; c) d` as one segment.
        if not in_sq and not in_dq and not (stack and not nested):
            if ch in (';', '\n'):
                parts.append(''.join(buf)); buf = []; i += 1
                continue
            if ch == '|':
                # || (logical-OR) -> skip second |, split once
                if nxt == '|':
                    i += 1
                parts.append(''.join(buf)); buf = []; i += 1
                continue
            if ch == '&' and nxt == '&':
                # && (logical-AND) -> skip second &, split once
                i += 1
                parts.append(''.join(buf)); buf = []; i += 1
                continue

        buf.append(ch); i += 1
    parts.append(''.join(buf))
    return parts


# Sentinel returned by _tokenize on shlex ValueError (malformed shell syntax).
# Callers skip such a piece. That is safe only while an unparseable piece implies
# an UNRUNNABLE command -- true for an unbalanced quote the operator typed, false
# for one the old pre-pass manufactured out of a valid command.
# QuotedSeparatorFailOpenTests asserts that implication against `bash -n`.
_PARSE_FAIL = object()


def _expand_ansi_c(body):
    r"""Expand the escapes bash expands inside `$'...'`, and only those.

    The escape set is the shell's: the named ones, `\xHH`, `\uHHHH`,
    `\UHHHHHHHH`, one to three octal digits, and `\cX` for a control character.
    An escape bash does not recognise is left alone, backslash included, because
    bash leaves it alone too -- guessing here would invent a token no shell would
    ever build.

    TOTAL BY CONSTRUCTION, which is the property that matters more than the
    fidelity. `chr()` stops at 0x10FFFF and bash does not: it writes the bytes
    and carries on. A codepoint above the ceiling therefore has to degrade to
    literal text here, because the alternative is an exception crossing into
    _tokenize, where every rule would skip the piece and a destructive command
    would be allowed by a word appended to it (card 151a0756, rackham Q family).
    The value this produces is not what bash produces; the point is only that the
    REST of the command stays visible to the rules.

    A NUL cannot survive in a bash word, so it is dropped rather than carried
    into a regex that would then match on something the shell never passes.
    """
    hexdigits = "0123456789abcdefABCDEF"
    named = {
        "a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f",
        "n": "\n", "r": "\r", "t": "\t", "v": "\v",
        "\\": "\\", "'": "'", '"': '"', "?": "?",
    }
    out = []
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        nxt = body[i + 1]
        if nxt in named:
            out.append(named[nxt])
            i += 2
        elif nxt in ("x", "u", "U"):
            width = {"x": 2, "u": 4, "U": 8}[nxt]
            j = i + 2
            digits = ""
            while j < n and len(digits) < width and body[j] in hexdigits:
                digits += body[j]
                j += 1
            if not digits:
                out.append(ch)
                out.append(nxt)
                i += 2
                continue
            try:
                out.append(chr(int(digits, 16)))
            except ValueError:
                out.append(ch)
                out.append(nxt)
                out.append(digits)
            i = j
        elif nxt in "01234567":
            j = i + 1
            digits = ""
            while j < n and len(digits) < 3 and body[j] in "01234567":
                digits += body[j]
                j += 1
            out.append(chr(int(digits, 8) & 0xFF))
            i = j
        elif nxt == "c" and i + 2 < n:
            # Lower-cased ASCII only. `str.upper()` can return TWO characters for
            # some codepoints, and `ord()` on those raises a TypeError that the
            # ValueError guard above would not even catch.
            code = ord(body[i + 2])
            if 0x61 <= code <= 0x7A:
                code -= 0x20
            out.append(chr(code ^ 0x40))
            i += 3
        else:
            out.append(ch)
            out.append(nxt)
            i += 2
    return "".join(out).replace("\x00", "")


def _expand_dollar_quoting(piece):
    r"""Resolve ANSI-C (`$'...'`) and locale (`$"..."`) quoting the way bash does.

    shlex implements neither, so it leaves the dollar glued to the token while
    bash strips it -- and, for the ANSI-C form, expands the escapes inside it.
    Both halves hide a rule's subject, at two different heights:

        cat $'~/.git-credentials'  ->  ['cat', '$~/.git-credentials']   (path)
        $'\x72m' -rf /             ->  ['\x72m', '-rf', '/']            (verb)

    The path form defeats rules that anchor a path to the whole token. The verb
    form is worse, because no rule reaches its subject at all -- the guard sees a
    command word it has never heard of and moves on. Both are fixed here, in the
    tokenizer, rather than by loosening the anchors: the anchoring is deliberate
    (card 48d3c0f9), and a substring search would trade one false negative for a
    class of false positives.

    Scoped exactly as bash scopes it, which is the part that keeps this from
    blocking ordinary work. bash applies neither form inside single or double
    quotes, so escape text in a commit message or in `awk '{print $1}'` survives
    untouched; a real expansion (`$HOME/...`) keeps its dollar; and a plain
    `'\x72m'` stays the literal string it is -- that one is not a near miss, it
    is a command bash refuses to find, so allowing it is the correct verdict and
    an expander that ignored the dollar would be blocking a string.
    """
    out = []
    in_sq = in_dq = False
    i = 0
    n = len(piece)
    while i < n:
        ch = piece[i]
        if ch == "\\" and not in_sq and i + 1 < n:
            out.append(ch)
            out.append(piece[i + 1])
            i += 2
            continue
        if ch == "'" and not in_dq:
            in_sq = not in_sq
        elif ch == '"' and not in_sq:
            in_dq = not in_dq
        elif (ch == "$" and not in_sq and not in_dq
                and i + 1 < n and piece[i + 1] == "'"):
            j = i + 2
            while j < n and piece[j] != "'":
                j += 2 if piece[j] == "\\" else 1
            if j >= n:
                # Unterminated: bash will not run this either. Drop the dollar
                # and let the dangling quote reach shlex, which is where the
                # unparseable verdict already lives.
                i += 1
                continue
            out.append(shlex.quote(_expand_ansi_c(piece[i + 2:j])))
            i = j + 1
            continue
        elif (ch == "$" and not in_sq and not in_dq
                and i + 1 < n and piece[i + 1] == '"'):
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _tokenize(piece):
    """shlex tokens for a sub-command. shlex does NOT expand ~ or $HOME, so they
    stay literal and matchable.

    The quoting is resolved OUTSIDE the try on purpose. `except ValueError` here
    means one thing -- shlex could not parse the quoting -- and an expander that
    raised inside it would be answering a different question with that branch:
    the piece would become _PARSE_FAIL and every rule would skip it, silently.
    An internal failure belongs to main(), which fails open LOUDLY instead."""
    expanded = _expand_dollar_quoting(piece)
    try:
        return shlex.split(expanded, comments=False, posix=True)
    except ValueError:
        return _PARSE_FAIL


# Words that can stand where the command word stands without BEING the command.
# Kept in sync with the sibling guard on purpose: the two files hold COPIES of
# these helpers, and a fix landing in one copy while silently missing the other
# is how this defect survived -- the paren handling of card ec7754d7 reached the
# sibling and never got here, which is what made the two measurably disagree.
_SHELL_KEYWORDS = frozenset(
    {
        "do", "done", "then", "else", "elif", "fi", "esac", "in", "coproc",
        "for", "if", "while", "until", "case", "select", "function", "{", "}", "!",
    }
)

# Wrappers that RUN the command that follows, so the real command word is further
# right. Measured, not assumed: each of these reaches the command.
_COMMAND_PREFIXES = frozenset(
    {
        "sudo", "command", "builtin", "exec", "nohup", "env", "nice", "ionice",
        "time", "timeout", "stdbuf", "setsid", "doas",
    }
)

# A wrapper may carry its own argument before the command (`timeout 5 rm -rf /`),
# so skipping cannot be "skip token 0" -- that returns the duration as the
# command word and misses the rm.
_PREFIX_ARG_RE = re.compile(r"^\d+(?:\.\d+)?[smhd]?$")


def _command_word(tokens):
    """The effective command word of a token list: skip words that cannot BE the
    command -- `sudo`, env assignments (FOO=bar), shell keywords, and wrappers
    that run what follows -- then return the basename, or ''.

    Before card 151a0756 only `sudo` and assignments were skipped, so the piece
    `do rm -rf /` reported `do`, and every rule in this file stopped applying.
    """
    after_prefix = False
    for tok in tokens:
        if tok in _SHELL_KEYWORDS:
            after_prefix = False
            continue
        if "=" in tok and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            continue  # env assignment prefix
        # A subshell tokenizes as '(rm', so the paren is not part of the name.
        cmd = tok.lstrip("(")
        if not cmd:
            continue
        cmd = os.path.basename(cmd)
        if cmd in _COMMAND_PREFIXES:
            after_prefix = True
            continue
        # Only a wrapper's own flags and duration are skipped, and only directly
        # after it. Widening this to any unrecognised word would make `echo rm
        # -rf /` a block, and echo destroys nothing.
        if after_prefix and (tok.startswith("-") or _PREFIX_ARG_RE.match(tok)):
            continue
        return cmd
    return ""


def match_rm_rf_root(command):
    """R1: `rm` with BOTH recursive and force flags whose target is a top-level
    root (/, ~, $HOME, /home/<user>). NOT a deeper path (worktree rm is fine)."""
    for piece in _split_subcommands(command):
        tokens = _tokenize(piece)
        if tokens is _PARSE_FAIL or not tokens:
            continue
        if _command_word(tokens) != "rm":
            continue
        recursive = force = False
        targets = []
        seen_rm = False
        for tok in tokens:
            if not seen_rm:
                if os.path.basename(tok) == "rm":
                    seen_rm = True
                continue
            if tok.startswith("--"):
                if tok == "--recursive":
                    recursive = True
                elif tok == "--force":
                    force = True
                # --no-preserve-root and other long opts: ignored as flags
            elif tok.startswith("-") and len(tok) > 1:
                if "r" in tok[1:]:
                    recursive = True
                if "f" in tok[1:]:
                    force = True
            else:
                targets.append(tok)
        if recursive and force and any(_RM_ROOT_RE.match(t) for t in targets):
            return True
    return False


def match_force_push_protected(command):
    """R2: `git push` that force-rewrites a protected branch -- either a force
    flag (--force/-f/--force-with-lease) together with a main/develop ref, or
    the force-refspec form (+main / +develop). A feature-branch force-push and a
    non-force push to main both pass."""
    for piece in _split_subcommands(command):
        tokens = _tokenize(piece)
        if tokens is _PARSE_FAIL or not tokens:
            continue
        if _command_word(tokens) != "git" or "push" not in tokens:
            continue
        has_force_flag = False
        hits_protected = False
        force_refspec = False
        for tok in tokens:
            if tok in ("--force", "--force-with-lease"):
                has_force_flag = True
            elif tok.startswith("-") and not tok.startswith("--") and "f" in tok[1:]:
                has_force_flag = True
            for b in PROTECTED_BRANCHES:
                # ref forms: `main`, `HEAD:main`, `local:main`
                if tok == b or tok.endswith(":" + b):
                    hits_protected = True
                # force-refspec: `+main`, `+HEAD:main`
                if tok == "+" + b or tok.endswith(":+" + b) or (
                    tok.startswith("+") and tok.endswith(":" + b)
                ):
                    force_refspec = True
        if (has_force_flag and hits_protected) or force_refspec:
            return True
    return False


def match_sql_drop(command):
    """R3: DROP/TRUNCATE TABLE|DATABASE executed THROUGH a SQL client. The client
    requirement removes the obvious false positive of grep/echo of the phrase."""
    if not _SQL_DROP_RE.search(command):
        return False
    for piece in _split_subcommands(command):
        tokens = _tokenize(piece)
        if tokens is _PARSE_FAIL or not tokens:
            continue
        if _command_word(tokens) in _SQL_CLIENTS:
            return True
    return False


def match_cred_file_print(command):
    """R4: a print-style command reading the raw PAT file ~/.git-credentials.
    The dashboard token (.dashboard-token) is explicitly NOT in scope -- it is
    read via `$(cat ...)` in every fleet-ops recipe."""
    for piece in _split_subcommands(command):
        tokens = _tokenize(piece)
        if tokens is _PARSE_FAIL or not tokens:
            continue
        if _command_word(tokens) not in _PRINT_VERBS:
            continue
        if any(_CRED_FILE_RE.match(tok) for tok in tokens):
            return True
    return False


def match_sensitive_file_print(command):
    """R4-enum (card 48d3c0f9): a print-style command reading any file in the
    closed sensitive-file set (_SENSITIVE_FILE_RES) -- SSH private keys, ~/.netrc,
    AWS credentials, the dashboard signing secrets, OAuth refresh-token files.
    Sibling of match_cred_file_print (which guards ~/.git-credentials)."""
    for piece in _split_subcommands(command):
        tokens = _tokenize(piece)
        if tokens is _PARSE_FAIL or not tokens:
            continue
        if _command_word(tokens) not in _PRINT_VERBS:
            continue
        if any(rx.match(tok) for tok in tokens for rx in _SENSITIVE_FILE_RES):
            return True
    return False


class Rule:
    __slots__ = ("name", "reason", "matcher")

    def __init__(self, name, reason, matcher):
        self.name = name
        self.reason = reason
        self.matcher = matcher


RULES = [
    Rule(
        "rm-rf-root",
        "recursive force-delete of a filesystem/home root (rm -rf / | ~ | $HOME "
        "| /home/<user>)",
        match_rm_rf_root,
    ),
    Rule(
        "force-push-protected",
        "force-push that rewrites the shared history of a protected branch "
        "(main/develop)",
        match_force_push_protected,
    ),
    Rule(
        "sql-drop",
        "DROP/TRUNCATE of a TABLE/DATABASE executed through a SQL client",
        match_sql_drop,
    ),
    Rule(
        "cred-file-print",
        "raw print of the credential file ~/.git-credentials (PAT exfiltration "
        "/ log-leak risk)",
        match_cred_file_print,
    ),
    Rule(
        "sensitive-file-print",
        "raw print of a sensitive credential file (SSH private key, .netrc, AWS "
        "credentials, dashboard signing secret, or OAuth token file) -- "
        "exfiltration / log-leak risk",
        match_sensitive_file_print,
    ),
]


def first_match(command):
    """First matching rule, or None. Pure."""
    for rule in RULES:
        try:
            if rule.matcher(command):
                return rule
        except Exception:
            # A misfiring matcher must never wedge: skip it (fail open per rule).
            continue
    return None


def classify(payload):
    """Pure. Returns (denied: bool, rule_name: str, reason: str). denied=True
    only for a Bash tool with a string command that positively matches a rule;
    everything else -> (False, "", "") = pass through (matched-Bash-only /
    fail-open)."""
    if not isinstance(payload, dict):
        return (False, "", "")
    if payload.get("tool_name") != "Bash":
        return (False, "", "")  # matched-Bash-only
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return (False, "", "")  # can't read -> fail open
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return (False, "", "")  # no command -> fail open
    rule = first_match(command)
    if rule is None:
        return (False, "", "")
    return (True, rule.name, rule.reason)


def _reason(rule_name, reason):
    return (
        "DESTRUCTIVE-COMMAND GUARD: this Bash command is hard-blocked because it "
        "matches the '{name}' rule -- {reason}. This action is irreversible / "
        "history-rewriting / secret-exfiltrating and has no agent-level approval "
        "path. Do NOT retry or work around it. If this is a genuine, intended "
        "operation, hand it to the operator (Dominik) to run manually, or ask "
        "marveen (Genesis) whether it is appropriate. See "
        "store/destructive-bash-guard-threat-model.md.".format(name=rule_name, reason=reason)
    )


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else None
    except Exception:
        sys.exit(0)  # unreadable/malformed input -> fail open

    try:
        denied, name, reason = classify(payload)
    except Exception as exc:
        # Any internal error -> fail open, but LOUDLY (a silently-degraded guard
        # is the danger we log against).
        sys.stderr.write(
            "DESTRUCTIVE-COMMAND GUARD: internal error, failing open: {}\n".format(exc)
        )
        sys.exit(0)

    if not denied:
        sys.exit(0)

    sys.stderr.write(_reason(name, reason) + "\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
