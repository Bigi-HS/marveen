"""Shared logic for the two tmux session-name prefix guards.

Hazard: tmux resolves `-t <target>` as exact -> PREFIX -> fnmatch. So an
unanchored `tmux kill-session -t A` retargets session `AB` the moment `A` is  # tmux-anchor-lint: ignore
absent. Measured 2026-08-04: 28/28 supervisor dashboard relaunches on the
"marveen absent" branch killed `marveen-channels` in the same second (OPS-106).

Two guards consume this module, and they are deliberately SEPARATE tools with
different inputs:

  * scripts/session-name-prefix-lint.py    -- SOURCE-derived names. Review-time
    guard: fails when someone ADDS a colliding name, before it ever runs.
  * scripts/_hb-session-prefix-detector.py -- LIVE session names. Runtime
    detector: fails when a colliding session actually exists right now.

Mixing them is the bug this module exists to avoid: a review-time guard that
reads runtime state is green in CI for the wrong reason.

THREE outcomes, never two. `pairs == []` is only OK if the measurement itself
succeeded; "could not measure" is its own exit code (EXIT_UNMEASURABLE), because
a guard whose failure is indistinguishable from a pass is worse than no guard.
"""
from __future__ import annotations

import os
import re
import subprocess

EXIT_OK = 0
EXIT_VIOLATION = 1
EXIT_UNMEASURABLE = 2

# tmux's default main agent id, mirroring `${MAIN_AGENT_ID:-marveen}` in
# scripts/channels.sh:46. Overridable so the guards follow a renamed fleet.
DEFAULT_MAIN_AGENT_ID = 'marveen'


class Unmeasurable(Exception):
    """The guard could not obtain its input. NOT a pass."""


def main_agent_id() -> str:
    return os.environ.get('MAIN_AGENT_ID') or DEFAULT_MAIN_AGENT_ID


def known_pairs(main_id: str) -> dict[tuple[str, str], str]:
    """Intentional prefix pairs, as EXACT (shorter, longer) tuples -> reason.

    Exact tuples on purpose: a pattern-based exemption would swallow real
    violations that merely resemble the sanctioned one.

    The single entry is DERIVED from main_agent_id rather than hardcoded as
    ('marveen', 'marveen-channels'), because the collision is a property of the
    NAMING SCHEME, not of the word "marveen": `${id}` and `${id}-channels` are a
    prefix pair for every possible id. Hardcoding the literal would silently
    re-arm the hazard the day the main agent is renamed -- the exemption would
    stop matching, someone would paste in the new literal, and nobody would
    learn that the scheme itself is the producer.
    """
    return {
        (main_id, f'{main_id}-channels'):
            'Naming scheme: the main agent runs the dashboard in session '
            f'"{main_id}" and the channel bridge in "{main_id}-channels". '
            'Prefix pair BY CONSTRUCTION, not by accident. The channel session '
            'name is deliberately descriptive and will not be renamed, so the '
            'mitigation is the "=" exact-match anchor at every call site '
            '(OPS-106), not a rename. Owner: OPS-106 / dave.',
    }


def find_pairs(names: list[str]) -> list[tuple[str, str]]:
    """Every (shorter, longer) pair where the shorter is a strict prefix."""
    uniq = sorted(set(names))
    return [(a, b) for a in uniq for b in uniq if a != b and b.startswith(a)]


def unsanctioned(pairs, sanctioned) -> list[tuple[str, str]]:
    return [p for p in pairs if p not in sanctioned]


def glob_risky(names: list[str]) -> list[str]:
    """tmux falls through to fnmatch after prefix, so glob chars are targets too."""
    return sorted({n for n in names if any(c in n for c in '*?[')})


# --- input: live tmux ------------------------------------------------------

def read_live_names(tmux: str = 'tmux', socket: str | None = None) -> list[str]:
    argv = [tmux] + (['-L', socket] if socket else []) + \
        ['list-sessions', '-F', '#{session_name}']
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        raise Unmeasurable(f'could not run tmux: {exc}') from exc
    if out.returncode != 0:
        raise Unmeasurable(
            f'tmux exited {out.returncode}: {out.stderr.strip() or "(no stderr)"}')
    # splitlines(), NOT split(): tmux permits spaces in session names, and
    # whitespace-splitting both invents pairs that do not exist and hides real
    # ones ("my agent" + "my agent-channels" -> a bogus agent/agent-channels
    # pair, and the true pair vanishes). Measured 2026-08-04.
    names = [n for n in out.stdout.splitlines() if n.strip()]
    if not names:
        raise Unmeasurable('tmux reported zero sessions -- nothing was measured')
    return names


# --- input: repository source ----------------------------------------------

_LITERAL_SESSION = re.compile(r'new-session\b[^\n]*?-s\s+["\x27]?([A-Za-z0-9_.-]+)["\x27]?')
_ISOLATED_SOCKET = re.compile(r'\B-L\s+\S+')
_SKIP_DIRS = {'node_modules', '.git', 'dist', 'coverage', 'store', '__pycache__',
              'graphify-out', '.claude-config'}


def agent_ids(root: str) -> list[str]:
    agents_dir = os.path.join(root, 'agents')
    if not os.path.isdir(agents_dir):
        raise Unmeasurable(f'no agents/ directory under {root}')
    ids = [d for d in os.listdir(agents_dir)
           if os.path.isfile(os.path.join(agents_dir, d, 'agent-config.json'))]
    if not ids:
        raise Unmeasurable('agents/ contains no agent-config.json -- nothing was measured')
    return sorted(ids)


def _strip_python_prose(source: str) -> str:
    """Blank out Python comments and docstrings, preserving line numbering.

    Without this the scanner reads its own documentation: the first run of this
    guard reported a "marveen-worker" collision that existed only in the prose
    of _hb-session-prefix-detector.py, which describes exactly that name as the
    example hazard. A measurement that ingests its own explanation reports the
    example as evidence.

    The fix is deliberately NOT "skip the guard's own files" -- excluding paths
    is how a guard goes blind. Strip the non-code, keep every file.
    """
    import io
    import tokenize

    kept: list[str] = source.splitlines()
    blanked = list(kept)
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return source  # unparseable: scan it raw rather than silently skip it
    prev_end = (1, 0)
    prev_type = tokenize.INDENT
    for tok in tokens:
        is_docstring = tok.type == tokenize.STRING and prev_type in (
            tokenize.INDENT, tokenize.DEDENT, tokenize.NEWLINE, tokenize.NL)
        if tok.type == tokenize.COMMENT or is_docstring:
            for ln in range(tok.start[0], tok.end[0] + 1):
                if 1 <= ln <= len(blanked):
                    blanked[ln - 1] = ''
        if tok.type not in (tokenize.NL, tokenize.COMMENT):
            prev_type = tok.type
        prev_end = tok.end
    del prev_end
    return '\n'.join(blanked)


def literal_session_names(root: str) -> dict[str, str]:
    """Fixed `new-session -s <literal>` names, mapped to where they came from.

    Invocations carrying `-L <socket>` are skipped: an isolated tmux server
    cannot collide with the fleet's default server, so counting its throwaway
    names (`s`, `zzprobe`) would be noise. This is a behavioural filter, not a
    path-based one -- excluding directories is how a guard goes blind.
    """
    found: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for fn in filenames:
            if not fn.endswith(('.sh', '.ts', '.js', '.py')):
                continue
            path = os.path.join(dirpath, fn)
            try:
                text = open(path, errors='replace').read()
            except OSError:
                continue
            if fn.endswith('.py'):
                text = _strip_python_prose(text)
            for lineno, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith('#') or stripped.startswith('//') \
                        or stripped.startswith('*'):
                    continue
                if _ISOLATED_SOCKET.search(line):
                    continue
                m = _LITERAL_SESSION.search(line)
                if m:
                    found.setdefault(
                        m.group(1),
                        f'{os.path.relpath(path, root)}:{lineno}')
    return found


def derive_source_names(root: str) -> dict[str, str]:
    """Session names the SOURCE can produce, mapped to their origin."""
    main = main_agent_id()
    names = {
        main: 'scripts/fleet-supervisor.sh:172 (DASH_SESSION="$MAIN_AGENT_ID")',
        f'{main}-channels': 'src/web/main-agent.ts:9 (MAIN_CHANNELS_SESSION)',
    }
    for aid in agent_ids(root):
        names[f'agent-{aid}'] = f'src/web/agent-process.ts:102 (agentSessionName "{aid}")'
    for literal, origin in literal_session_names(root).items():
        names.setdefault(literal, origin)
    return names
