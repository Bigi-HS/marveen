#!/usr/bin/env python3
"""K-2: Static audit of ~/.claude/skills/ SKILL.md files for injection patterns.

Periodically scans the global skills directory for suspicious content that
could indicate supply-chain injection (S1/E1/E2/I1 from the STRIDE threat
model, card 1b4a5b99).

Exit code: 0 = clean, 1 = findings present, 2 = usage error.
"""
import os
import re
import sys
from pathlib import Path

# Regex patterns that signal potential injection in a SKILL.md.
# Each entry: (compiled pattern, human-readable description).
# Rationale for each pattern is in the threat model
# (store/skills-supplychain-threat-model-0928.md).
SUSPICIOUS_PATTERNS = [
    # S1: fake operational directive in caps (e.g. "OPERATIONAL OVERRIDE:")
    (re.compile(r'\bOVERRIDE\b'), 'OVERRIDE directive'),
    # E2: direct merge instruction bypassing gate
    (re.compile(r'merge.?direct', re.IGNORECASE), 'direct merge instruction'),
    # E1/E2: guard bypass instruction
    (re.compile(r'bypass.?guard', re.IGNORECASE), 'guard bypass instruction'),
    # I1: credential read (readFile path to token)
    (re.compile(r'readFile.*token', re.IGNORECASE), 'credential read instruction'),
    # I1: shell credential exfiltration (cat .../credentials)
    (re.compile(r'cat.*credential', re.IGNORECASE), 'credential exfil instruction'),
]

# D2: context poisoning -- oversized SKILL.md floods context window
MAX_LINES = 500


def audit_skill_file(path: Path) -> list:
    """Return findings list for a single SKILL.md (or other skill content file)."""
    findings = []
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError as exc:
        return [{'path': str(path), 'line': 0, 'pattern': 'read-error', 'match': str(exc)}]

    if len(lines) > MAX_LINES:
        findings.append({
            'path': str(path),
            'line': len(lines),
            'pattern': 'size-limit',
            'match': f'{len(lines)} lines (max {MAX_LINES})',
        })

    for lineno, line in enumerate(lines, 1):
        for pattern, desc in SUSPICIOUS_PATTERNS:
            if pattern.search(line):
                findings.append({
                    'path': str(path),
                    'line': lineno,
                    'pattern': desc,
                    'match': line.strip()[:120],
                })

    return findings


def scan_skills_dir(skills_root: Path) -> list:
    """Walk skills_root and audit every SKILL.md."""
    all_findings = []
    for skill_md in sorted(skills_root.rglob('SKILL.md')):
        all_findings.extend(audit_skill_file(skill_md))
    return all_findings


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]

    skills_root = Path(os.path.expanduser(argv[0])) if argv else Path(
        os.path.expanduser('~/.claude/skills'))

    if not skills_root.exists():
        print(f'skill-audit: skills dir not found ({skills_root}), nothing to scan',
              file=sys.stderr)
        return 0

    findings = scan_skills_dir(skills_root)

    if not findings:
        print(f'skill-audit: CLEAN -- 0 findings in {skills_root}')
        return 0

    print(f'skill-audit: {len(findings)} finding(s) in {skills_root}', file=sys.stderr)
    for f in findings:
        print(f"  [{f['pattern']}] {f['path']}:{f['line']} -- {f['match']}", file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
