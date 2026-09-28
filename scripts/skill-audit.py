#!/usr/bin/env python3
"""K-2: Static audit of ~/.claude/skills/ SKILL.md files for injection patterns.

Periodically scans the global skills directory for suspicious content that
could indicate supply-chain injection (S1/E1/E2/I1 from the STRIDE threat
model, card 1b4a5b99).

Usage:
  python3 skill-audit.py [SKILLS_DIR] [--alert-agent AGENT_ID] [--token-file PATH]

  SKILLS_DIR       defaults to ~/.claude/skills
  --alert-agent    if set and findings exist, POST an inter-agent message to
                   this agent via the fleet API (requires server + token file)
  --token-file     path to the dashboard token file; defaults to store/.dashboard-token
                   relative to the script's parent directory

Exit code: 0 = clean, 1 = findings present.
"""
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

# Regex patterns that signal potential injection in a SKILL.md.
# Each entry: (compiled pattern, human-readable description).
# Rationale: store/skills-supplychain-threat-model-0928.md (card 1b4a5b99).
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

_FLEET_API = 'http://localhost:3420'


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


def _send_alert(agent_id: str, findings: list, token_file: Path) -> None:
    """POST an inter-agent alert to agent_id via the fleet API."""
    try:
        token = token_file.read_text().splitlines()[0].strip()
    except OSError as exc:
        print(f'skill-audit: alert skipped -- cannot read token: {exc}', file=sys.stderr)
        return

    summary_lines = [f"  [{f['pattern']}] {f['path']}:{f['line']}" for f in findings[:10]]
    if len(findings) > 10:
        summary_lines.append(f'  ... and {len(findings) - 10} more')
    body = (
        f'skill-audit K-2: {len(findings)} suspicious pattern(s) in ~/.claude/skills/\n'
        + '\n'.join(summary_lines)
        + '\nFull details: run python3 scripts/skill-audit.py'
    )

    payload = json.dumps({
        'from': 'rackham',
        'to': agent_id,
        'content': body,
    }).encode()
    req = urllib.request.Request(
        f'{_FLEET_API}/api/messages',
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 300:
                print(f'skill-audit: alert POST returned {resp.status}', file=sys.stderr)
    except Exception as exc:
        print(f'skill-audit: alert failed: {exc}', file=sys.stderr)


def _default_token_file() -> Path:
    script_dir = Path(__file__).resolve().parent
    return script_dir.parent / 'store' / '.dashboard-token'


def _parse_args(argv: list) -> tuple:
    """Return (skills_root, alert_agent, token_file) from argv."""
    skills_root = None
    alert_agent = None
    token_file = _default_token_file()
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == '--alert-agent':
            i += 1
            alert_agent = argv[i] if i < len(argv) else None
        elif arg == '--token-file':
            i += 1
            token_file = Path(argv[i]) if i < len(argv) else token_file
        elif not arg.startswith('-'):
            skills_root = Path(os.path.expanduser(arg))
        i += 1
    if skills_root is None:
        skills_root = Path(os.path.expanduser('~/.claude/skills'))
    return skills_root, alert_agent, token_file


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]

    skills_root, alert_agent, token_file = _parse_args(argv)

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

    if alert_agent:
        _send_alert(alert_agent, findings, token_file)

    return 1


if __name__ == '__main__':
    sys.exit(main())
