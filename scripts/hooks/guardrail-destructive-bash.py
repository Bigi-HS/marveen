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


# Command-substitution delimiters ($(  )  `) are neutralized to separators so an
# inner command (e.g. the `cat` in `echo $(cat ~/.git-credentials)`) becomes its
# own piece with its own command word, instead of being hidden as an argument.
_CMD_SUBST_RE = re.compile(r"\$\(|\)|`")


def _split_subcommands(command):
    """Split a command line into the pieces that each start with their own
    command word, on the shell operators that sequence commands (and on
    command-substitution boundaries). Lets us catch `echo x && rm -rf ~` and the
    inner command of `$( ... )` while keeping per-subcommand command-word context."""
    normalized = _CMD_SUBST_RE.sub(";", command)
    return re.split(r"(?:&&|\|\||[;|\n])", normalized)


def _tokenize(piece):
    """shlex tokens for a sub-command. shlex does NOT expand ~ or $HOME, so they
    stay literal and matchable. Returns None on a malformed (unbalanced-quote)
    piece so callers can fail open for that piece."""
    try:
        return shlex.split(piece, comments=False, posix=True)
    except ValueError:
        return None


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
        cmd = os.path.basename(tok.lstrip("("))
        if not cmd:
            continue
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
        if not tokens:
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
        if not tokens:
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
        if not tokens:
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
        if not tokens:
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
        if not tokens:
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
