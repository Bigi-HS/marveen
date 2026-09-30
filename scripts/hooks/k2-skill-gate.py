#!/usr/bin/env python3
"""K-2 static skill-audit gate (OPS/1b4a5b99).

PostToolUse hook: fires after Write/Edit on ~/.claude/skills/*/SKILL.md.
Checks for prompt-injection patterns and enforces the 500-line size cap.
Outputs findings to stderr; exit 0 always (log-only, not blocking).
Blocking mode planned post K-0 Boss-GO.

Hook invocation: called with tool result JSON on stdin.
Env: TOOL_NAME, TOOL_INPUT_PATH (set by Claude Code hook runtime).
"""
import json
import os
import re
import sys

# ---------------------------------------------------------------------------
# Patterns: (name, severity, compiled_regex)
# ---------------------------------------------------------------------------
_PATTERNS = [
    ('override-instruction',  'HIGH',   re.compile(
        r'ignore\s+(previous|above|prior)|disregard\s+(previous|above|prior)|'
        r'forget\s+(previous|above|all)\s+(instructions|rules)|'
        r'new\s+instructions?\s*:',
        re.IGNORECASE)),
    ('role-spoof',            'HIGH',   re.compile(
        r'^(system|assistant|user)\s*:', re.IGNORECASE | re.MULTILINE)),
    ('guard-bypass',          'HIGH',   re.compile(
        r'bypass.{0,10}guard|disable.{0,10}hook|--no.verify', re.IGNORECASE)),
    ('direct-merge-bypass',   'HIGH',   re.compile(
        r'merge.{0,5}direct|push.{0,5}--force|git\s+push.*main', re.IGNORECASE)),
    ('token-read',            'HIGH',   re.compile(
        r'dashboard.token|\.genesis.token|readFile.*token|cat.*cred|'
        r'store/\.dashboard|\.env\b', re.IGNORECASE)),
    ('exfiltration',          'HIGH',   re.compile(
        r'exfiltrat|send.*token|upload.*cred|curl.{0,30}http(?!://127|://localhost)',
        re.IGNORECASE)),
    ('permission-grab',       'MEDIUM', re.compile(
        r'GUARDED_TOOLS|allowlist.*Bash|add.*permission|widen.*scope', re.IGNORECASE)),
    ('arg-injection',         'MEDIUM', re.compile(
        r'\$ARGUMENTS|\$\{ARGUMENTS\}', re.IGNORECASE)),
]

# Zero-width / bidi smuggling (Unicode ranges)
_ZERO_WIDTH_RE = re.compile(
    r'[​-‏‪-‮﻿]')

SIZE_LIMIT = 500  # lines


def _is_skill_file(path: str) -> bool:
    home = os.path.expanduser('~')
    normalized = os.path.normpath(path)
    skill_base = os.path.normpath(os.path.join(home, '.claude', 'skills'))
    return (normalized.startswith(skill_base) and
            os.path.basename(normalized).upper() == 'SKILL.MD')


def audit(path: str) -> list[tuple[str, str, int]]:
    """Return list of (severity, name, line_no) findings."""
    findings = []
    try:
        lines = open(path, encoding='utf-8', errors='replace').readlines()
    except OSError:
        return []

    # Size check
    if len(lines) > SIZE_LIMIT:
        findings.append(('MEDIUM', 'size-limit-exceeded',
                          f'{len(lines)} lines (max {SIZE_LIMIT})'))

    for i, line in enumerate(lines, 1):
        # Zero-width characters
        if _ZERO_WIDTH_RE.search(line):
            findings.append(('HIGH', 'zero-width-char', i))

        # Pattern checks
        for name, severity, pattern in _PATTERNS:
            if pattern.search(line):
                findings.append((severity, name, i))
                break  # one finding per line per scan

    return findings


def main() -> int:
    # Read tool info from stdin (Claude Code PostToolUse hook format)
    tool_input = {}
    try:
        data = json.loads(sys.stdin.read())
        tool_input = data.get('tool_input', {})
    except Exception:
        pass

    path = tool_input.get('file_path', '') or os.environ.get('TOOL_INPUT_PATH', '')
    if not path or not _is_skill_file(path):
        return 0

    findings = audit(path)
    if not findings:
        return 0

    skill_name = os.path.basename(os.path.dirname(path))
    print(f'K2-SKILL-GATE: {len(findings)} finding(s) in {skill_name}/SKILL.md',
          file=sys.stderr)
    for sev, name, loc in findings:
        print(f'  [{sev}] {name} @ {loc}', file=sys.stderr)

    highs = [f for f in findings if f[0] == 'HIGH']
    if highs:
        print(f'K2-SKILL-GATE: {len(highs)} HIGH finding(s) -- '
              'manual review required before this skill activates.',
              file=sys.stderr)

    return 0  # log-only; blocking pending K-0 Boss-GO


if __name__ == '__main__':
    sys.exit(main())
