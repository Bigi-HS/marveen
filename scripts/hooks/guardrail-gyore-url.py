#!/usr/bin/env python3
"""PreToolUse guardrail hook: FAIL-CLOSED URL egress allowlist for gyore
(v2 §C enforcement item #2; card 6c494f3b).

gyore (the world/research agent) ships with `WebFetch(*)` + `WebSearch(*)` and
only `Bash(curl -X POST:*)` denied, so a plain GET exfil (curl/wget a URL, or a
WebFetch to any host) passes untouched. Every OTHER fleet guardrail is
DEFAULT-ALLOW / fail-OPEN (destructive-bash, ask-first). This hook deliberately
INVERTS that convention: it is a positive allowlist over outbound fetches, and
every ambiguity resolves to DENY.

Fail-policy (NON-NEGOTIABLE, the inversion vs guardrail-destructive-bash):
  - SCOPE: only `WebFetch` and `Bash` are inspected. `WebSearch` and every
    other tool pass through (exit 0) -- a search engine is not arbitrary egress.
  - DEFAULT-DENY for fetches: a fetch to a host that is NOT on the allowlist is
    blocked (exit 2). The single safe exit-0 for an inspected tool is: a Bash
    command with NO fetch verb that tokenizes cleanly, or a WebFetch/fetch whose
    host resolves to an allowlisted registrable domain.
  - _PARSE_FAIL => DENY (THE load-bearing inversion). The sibling
    guardrail-destructive-bash._split_subcommands marks an unparseable piece
    (e.g. an unbalanced quote) as _PARSE_FAIL and its callers SKIP it -- correct
    for a default-ALLOW guard (skip = allow-per-piece). For a fail-CLOSED egress
    guard a piece we cannot tokenize might BE an obfuscated `curl`, so it must
    DENY, not skip. We reuse the hardened tokenizer and invert at the call site.
  - Any shell substitution in a URL (`$(...)`, backticks, `${...}`, bare `$`) =>
    DENY: we cannot statically verify the host of a computed URL.
  - FAIL-CLOSED on internal error: a crash or malformed stdin => exit 2 + loud
    stderr. This is the OPPOSITE of destructive-bash (which fails open to avoid a
    fleet-wide outage). Rationale: this hook is wired to ONE agent (gyore), so a
    guard bug degrades gyore's fetches (recoverable, visible) rather than
    bricking the fleet -- and a silent exfil is not recoverable. The reason
    string is tagged [guard-error] so forge/Boss can intervene fast.

Allowlist seed: registrable domains in ALLOWED_HOSTS below, overridable WITHOUT
a code change via store/gyore-url-allowlist.txt (one host per line, '#'
comments). The seed is CONSERVATIVE and PENDING Boss/Claudia sign-off (the
spec's open item); the mechanism is independent of the seed's contents.

Block mechanism: exit 2 with a reason on stderr (fleet convention). Exit 0 = allow.
"""
import sys
import os
import json
import importlib.util
from urllib.parse import urlparse

# --- reuse the hardened sibling tokenizer (hyphenated filename -> importlib) ---
_SIBLING = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "guardrail-destructive-bash.py")


def _load_tokenizer():
    spec = importlib.util.spec_from_file_location("_gyore_db", _SIBLING)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Fetch verbs whose arguments carry a URL we must verify against the allowlist.
_URL_FETCH_VERBS = frozenset({
    "curl", "wget", "aria2c", "lynx", "w3m", "links", "elinks",
    "http", "https", "httpie", "lwp-request", "lwp-download",
})
# Egress verbs with no legitimate gyore use and no simple URL arg to verify;
# always DENY (never parsed for an allowlisted host).
_EGRESS_DENY_VERBS = frozenset({
    "nc", "ncat", "netcat", "telnet", "scp", "sftp", "ftp", "socat", "ssh",
})

# Conservative seed -- registrable domains (host == entry OR host endswith
# "." + entry). PENDING Boss/Claudia sign-off; edit store/gyore-url-allowlist.txt
# to change without touching code.
ALLOWED_HOSTS = frozenset({
    "wikipedia.org",
    "wikimedia.org",
    "github.com",
})

_ALLOWLIST_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "store", "gyore-url-allowlist.txt",
)

_SUBST_MARKERS = ("$(", "`", "${", "$")


def _effective_allowlist():
    """ALLOWED_HOSTS plus any hosts in the optional override file."""
    hosts = set(ALLOWED_HOSTS)
    try:
        with open(_ALLOWLIST_FILE, encoding="utf-8") as fh:
            for line in fh:
                line = line.split("#", 1)[0].strip().lower()
                if line:
                    hosts.add(line)
    except FileNotFoundError:
        pass
    except Exception:
        # A corrupt override file must not silently widen access: fail CLOSED by
        # ignoring it and keeping only the hardcoded seed.
        pass
    return frozenset(hosts)


def _host_allowed(host, allowlist):
    if not host:
        return False
    host = host.lower().rstrip(".")
    return any(host == a or host.endswith("." + a) for a in allowlist)


def _extract_host(url):
    """Registrable host from a URL token, or None if unverifiable.

    urlparse correctly handles userinfo obfuscation (http://ok.com@evil.com ->
    hostname 'evil.com'). A bare host without scheme is reparsed with a '//'
    prefix so it lands in netloc rather than path.
    """
    if any(m in url for m in _SUBST_MARKERS):
        return None  # computed URL -> cannot verify statically
    try:
        p = urlparse(url)
        if not p.scheme and not p.netloc:
            p = urlparse("//" + url)
        return p.hostname
    except Exception:
        return None


def _is_url_token(tok):
    return (
        "://" in tok
        or tok.startswith("//")
        or "." in tok.split("/", 1)[0]  # bare host.tld[/path]
    )


def _bash_decision(command, tok_mod, allowlist):
    """Return (block: bool, reason: str) for a Bash command. DENY on any
    _PARSE_FAIL piece (inversion), on any egress-deny verb, and on any fetch verb
    whose URL is missing / computed / off-allowlist."""
    for piece in tok_mod._split_subcommands(command):
        tokens = tok_mod._tokenize(piece)
        if tokens is tok_mod._PARSE_FAIL:
            # The load-bearing inversion: unparseable => might be an obfuscated
            # fetch => DENY (the sibling guard would SKIP here).
            return True, "unparseable command piece (fail-closed egress guard)"
        if not tokens:
            continue
        word = tok_mod._command_word(tokens)
        if word is None:
            continue
        base = os.path.basename(word).lower()
        if base in _EGRESS_DENY_VERBS:
            return True, f"egress command '{base}' is not allowed for gyore"
        if base not in _URL_FETCH_VERBS:
            continue
        # A fetch verb: every URL-looking argument must resolve to an allowed host.
        url_tokens = [t for t in tokens[1:]
                      if not t.startswith("-") and _is_url_token(t)]
        if not url_tokens:
            return True, (f"fetch '{base}' with no statically-verifiable URL "
                          f"argument")
        for ut in url_tokens:
            host = _extract_host(ut)
            if host is None:
                return True, (f"fetch '{base}' URL is computed/unverifiable: "
                              f"{ut!r}")
            if not _host_allowed(host, allowlist):
                return True, f"fetch to non-allowlisted host '{host}'"
    return False, ""


def _webfetch_decision(tool_input, allowlist):
    url = (tool_input or {}).get("url")
    if not url or not isinstance(url, str):
        return True, "WebFetch with missing/invalid url"
    host = _extract_host(url)
    if host is None:
        return True, f"WebFetch URL is computed/unverifiable: {url!r}"
    if not _host_allowed(host, allowlist):
        return True, f"WebFetch to non-allowlisted host '{host}'"
    return False, ""


def decide(tool_name, tool_input, tok_mod, allowlist):
    """Core policy. Returns (block: bool, reason: str)."""
    if tool_name == "WebFetch":
        return _webfetch_decision(tool_input, allowlist)
    if tool_name == "Bash":
        command = (tool_input or {}).get("command", "")
        if not isinstance(command, str) or not command.strip():
            return False, ""  # nothing to fetch
        return _bash_decision(command, tok_mod, allowlist)
    # WebSearch and every other tool: not an arbitrary-egress surface -> allow.
    return False, ""


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        # FAIL-CLOSED: cannot read the request -> cannot verify -> deny.
        sys.stderr.write(f"[guard-error] gyore-url: unreadable stdin -> DENY: {exc}\n")
        sys.exit(2)

    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {})

    try:
        tok_mod = _load_tokenizer()
        allowlist = _effective_allowlist()
        block, reason = decide(tool_name, tool_input, tok_mod, allowlist)
    except Exception as exc:
        # FAIL-CLOSED on any internal error (the deliberate inversion vs
        # destructive-bash). gyore-only scope makes a degraded-fetch failure
        # mode recoverable; a silent exfil is not.
        sys.stderr.write(f"[guard-error] gyore-url: compute crash -> DENY: {exc}\n")
        sys.exit(2)

    if block:
        sys.stderr.write(
            f"BLOCKED by gyore-url egress guard: {reason}. "
            f"Allowed hosts are a positive allowlist (store/gyore-url-allowlist.txt); "
            f"add the host there with Boss/Claudia sign-off if legitimate.\n"
        )
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
