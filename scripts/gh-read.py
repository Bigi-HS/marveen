#!/usr/bin/env python3
"""gh-read.py -- READ-only gh CLI wrapper (card 24b12610 piece B).

Lets any fleet agent inspect PR / CI state via the gh CLI WITHOUT any ability to
write. The existing host PAT (~/.git-credentials) is repo-scoped and therefore
write-capable, so this wrapper is the behavioural guard that keeps gh read-only.

NoA's three mandatory conditions (all enforced here):
  (a) GH_TOKEN is injected ONLY into the per-call subprocess env via
      os.environ.copy() + key -- never `export`ed into the agent session, so it
      cannot leak to unrelated subprocesses. See build_env().
  (b) only READ subcommands run. Default-DENY allowlist (GH_READ_ALLOWLIST) is
      the gate; GH_WRITE_BLOCKLIST is belt-and-suspenders + documents intent.
      `gh api` is GET-only (any write method or request-body flag is rejected).
  (c) the fleet endpoint (/api/github/*) stays the ONLY write path, so
      MG-SEC7 author-recusal cannot be bypassed. This wrapper NEVER runs a write
      gh command, by construction.

Residual (NoA/Chad, non-blocking): the PAT is repo-scoped (write-capable); this
invariant is behavioural, not cryptographic. Fine-grained PAT hardening
(checks:read + pull_requests:read) is tracked on the EXISTING card bba8f1b3
(fine-grained PAT per role) -- not re-opened here.

Usage:
  scripts/gh-read.py pr view 997
  scripts/gh-read.py pr checks 997
  scripts/gh-read.py run list
  scripts/gh-read.py api repos/Bigi-HS/marveen/pulls/997

The gh binary is installed by scripts/install-gh.sh into scripts/bin/gh
(gitignored, pinned + SHA256-verified), mirroring scripts/bin/gitleaks.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

INSTALL_DIR = Path(__file__).resolve().parent.parent
GH_BIN = INSTALL_DIR / 'scripts' / 'bin' / 'gh'
CRED_FILE = os.environ.get('GH_CRED_FILE', '/home/domin/.git-credentials')

# Default-DENY allowlist: (command, subcommand) read pairs. Anything not listed
# here is refused, even if it is not an obvious write.
GH_READ_ALLOWLIST = {
    ('pr', 'view'),
    ('pr', 'diff'),
    ('pr', 'checks'),
    ('pr', 'list'),
    ('pr', 'status'),
    ('run', 'view'),
    ('run', 'list'),
    ('run', 'download'),
}

# Explicit write blocklist -- belt-and-suspenders + intent documentation. The
# allowlist already denies these; listing them yields a clearer "write" reason.
GH_WRITE_BLOCKLIST = {
    ('pr', 'create'), ('pr', 'merge'), ('pr', 'close'), ('pr', 'edit'),
    ('pr', 'comment'), ('pr', 'reopen'), ('pr', 'ready'), ('pr', 'review'),
    ('release', 'create'), ('release', 'delete'), ('release', 'edit'),
    ('release', 'upload'),
}
# Whole commands that are write/dangerous regardless of subcommand.
GH_WRITE_COMMANDS = {'repo', 'secret', 'auth', 'gist', 'workflow', 'cache',
                     'label', 'issue', 'variable', 'ssh-key', 'gpg-key'}

# gh api flags that imply a request body (=> not a plain GET).
_API_BODY_FLAGS = {'-f', '--field', '-F', '--raw-field', '--input'}
_API_METHOD_FLAGS = {'-X', '--method'}


def is_read_only(argv):
    """Return (ok, reason). ok=True only if argv is a permitted READ command.

    Pure: no subprocess, no env, no IO -- safe to unit-test exhaustively."""
    if not argv:
        return False, 'empty command'
    cmd = argv[0]

    if cmd == 'api':
        return _api_is_get(argv[1:])

    if cmd in GH_WRITE_COMMANDS:
        return False, f'write/dangerous command refused: gh {cmd} ...'

    sub = argv[1] if len(argv) > 1 else ''
    if (cmd, sub) in GH_WRITE_BLOCKLIST:
        return False, f'write command refused: gh {cmd} {sub}'
    if (cmd, sub) in GH_READ_ALLOWLIST:
        return True, ''
    return False, f'not on read allowlist (default-deny): gh {cmd} {sub}'.rstrip()


def _api_is_get(rest):
    """gh api defaults to GET; reject an explicit non-GET method or any
    request-body flag (which forces a POST)."""
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok in _API_METHOD_FLAGS:
            method = rest[i + 1] if i + 1 < len(rest) else ''
            if method.upper() != 'GET':
                return False, f'gh api non-GET method refused: {method or "(missing)"}'
            i += 2
            continue
        if tok.startswith('--method='):
            if tok.split('=', 1)[1].upper() != 'GET':
                return False, f'gh api non-GET method refused: {tok}'
            i += 1
            continue
        if tok in _API_BODY_FLAGS or tok.startswith('--field=') or \
                tok.startswith('--raw-field=') or tok.startswith('--input='):
            return False, 'gh api request-body flag refused (implies write)'
        i += 1
    return True, ''


def build_env(base_env, token):
    """Return a NEW env dict = copy(base_env) + GH_TOKEN. Never mutates base_env,
    so the token stays scoped to the single subprocess call (condition a)."""
    env = dict(base_env)
    env['GH_TOKEN'] = token
    return env


def extract_pat(cred_text):
    """Parse the PAT out of a git-credentials line (mirrors list-open-prs.py)."""
    m = re.search(r'https://[^:]+:([^@]+)@', cred_text)
    if not m:
        raise ValueError('no PAT found in credentials')
    return m.group(1)


def _read_pat():
    with open(CRED_FILE) as f:
        return extract_pat(f.read().strip())


def run(argv):
    """Validate argv as read-only, then invoke gh with a token-scoped env.
    Returns the gh process' return code. Never prints the token."""
    ok, reason = is_read_only(argv)
    if not ok:
        print(f'gh-read: REFUSED -- {reason}', file=sys.stderr)
        return 2
    if not GH_BIN.exists():
        print(f'gh-read: gh binary not found at {GH_BIN}; run '
              f'scripts/install-gh.sh', file=sys.stderr)
        return 3
    env = build_env(os.environ.copy(), _read_pat())
    result = subprocess.run([str(GH_BIN), *argv], env=env)
    return result.returncode


if __name__ == '__main__':
    sys.exit(run(sys.argv[1:]))
