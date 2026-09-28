#!/usr/bin/env python3
"""K-2: Static audit of ~/.claude/skills/ SKILL.md files for injection patterns. v3.

Periodically scans the global skills directory for suspicious content that
could indicate supply-chain injection (S1/E1/E2/I1 from the STRIDE threat
model, card 1b4a5b99).

Usage:
  python3 skill-audit.py [SKILLS_DIR] [OPTIONS]

  SKILLS_DIR         defaults to ~/.claude/skills
  --alert-agent ID   POST inter-agent alert to ID when NEW findings are found
  --token-file PATH  dashboard token file (default: store/.dashboard-token)
  --baseline PATH    JSON file of previously accepted findings; alert fires
                     only on delta (new findings not in baseline)
  --save-baseline P  write current findings to P as the new baseline, then exit 0

Severity triage:
  size-limit         INFO -- logged, never triggers alert (existing large skills
                     are a known state; only new ones need human review)
  regex matches      WARN -- triggers alert when new/unbaselined

Exit code: 0 = clean or no new findings beyond baseline, 1 = new findings.
"""
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

# I1 co-occurrence helpers (v3, card 9ca7448d): exfil requires read+egress on same line.
# Left \b on all verbs closes subword FPs ('footprint'->'print', 'lookahead'->'head').
_EXFIL_READ_RE = re.compile(
    r'\b(?:cat|echo|print|head)\b.{0,30}(?:token|secret|credential|password)',
    re.IGNORECASE,
)
_EXFIL_EGRESS_RE = re.compile(
    r'(?:curl|wget|https?://|\bPOST\b|\bnc\b|/dev/tcp|base64\s*\|)',
    re.IGNORECASE,
)


def _exfil_cooccurrence(line: str) -> bool:
    """Return True only when a credential-read verb and an egress indicator co-occur."""
    return bool(_EXFIL_READ_RE.search(line) and _EXFIL_EGRESS_RE.search(line))


# Regex patterns that signal potential injection in a SKILL.md.
# Each entry: (check, human-readable description, severity) where check is either
# a compiled regex (supports .search(line)) or a callable(line) -> bool.
# Rationale: store/skills-supplychain-threat-model-0928.md (card 1b4a5b99).
SUSPICIOUS_PATTERNS = [
    # S1: fake operational directive in caps (e.g. "OPERATIONAL OVERRIDE:")
    # Intentionally case-sensitive: ALL-CAPS OVERRIDE is the injection marker;
    # lowercase 'override' is a valid JS/TS keyword and is NOT flagged.
    (re.compile(r'\bOVERRIDE\b'), 'OVERRIDE directive', 'WARN'),

    # S1 addendum: canonical prompt-injection instruction phrase (sprint-2, AC26)
    (re.compile(r'ignore.{0,20}(?:previous|above|prior).{0,5}instruction',
                re.IGNORECASE), 'prompt-injection instruction phrase', 'WARN'),

    # E2: direct merge instruction bypassing gate.
    # \bdirect(?:ly)?\b closes FPs ('merge directory', 'merge direction') while
    # still catching 'merge directly' and 'merge it directly'.
    # (sprint-2: was 'merge.?direct' which matched subwords AND missed multi-word gaps)
    (re.compile(r'merge.{0,20}\bdirect(?:ly)?\b', re.IGNORECASE), 'direct merge instruction', 'WARN'),

    # E1/E2: guard bypass instruction -- covers multi-word gaps and synonyms.
    # (sprint-2: was 'bypass.?guard' which missed 'bypass the guard' etc.)
    (re.compile(r'(?:bypass|circumvent|evade|skip|disable).{0,20}guard(?:rail)?',
                re.IGNORECASE), 'guard bypass instruction', 'WARN'),

    # I1: credential/token read -- covers readFile, read_file, open() idioms.
    # (sprint-2: was 'readFile.*token' only, missed Python open() and read_file)
    (re.compile(r'(?:readFile|read_file|open)\b.{0,50}(?:token|secret|credential)',
                re.IGNORECASE), 'credential read instruction', 'WARN'),

    # I1: shell/print credential exfiltration -- requires read+egress co-occurrence.
    # (v3, 9ca7448d: was '(?:\bcat\b|echo|print|head)\b...' which fired on
    #  security-doc mentions with no egress, causing ~64 FPs in live corpus.
    #  Left-\b added to all verbs for consistency; co-occurrence with egress required.)
    # Fires only when a credential-read verb AND an egress indicator appear on the
    # same line -- 'cat credentials' in a security doc is not an exfil attempt.
    (_exfil_cooccurrence, 'credential exfil instruction', 'WARN'),
]

# D2: context poisoning -- oversized SKILL.md floods context window
MAX_LINES = 500

_FLEET_API = 'http://localhost:3420'


def audit_skill_file(path: Path) -> list:
    """Return findings list for a single SKILL.md."""
    findings = []
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError as exc:
        return [{'path': str(path), 'line': 0, 'pattern': 'read-error',
                 'match': str(exc), 'severity': 'WARN'}]

    if len(lines) > MAX_LINES:
        findings.append({
            'path': str(path),
            'line': len(lines),
            'pattern': 'size-limit',
            'match': f'{len(lines)} lines (max {MAX_LINES})',
            'severity': 'INFO',
        })

    for lineno, line in enumerate(lines, 1):
        for check, desc, severity in SUSPICIOUS_PATTERNS:
            matched = check(line) if callable(check) else bool(check.search(line))
            if matched:
                findings.append({
                    'path': str(path),
                    'line': lineno,
                    'pattern': desc,
                    'match': line.strip()[:120],
                    'severity': severity,
                })

    return findings


def scan_skills_dir(skills_root: Path) -> list:
    """Walk skills_root and audit every SKILL.md."""
    all_findings = []
    for skill_md in sorted(skills_root.rglob('SKILL.md')):
        all_findings.extend(audit_skill_file(skill_md))
    return all_findings


def _finding_key(f: dict, skills_root: Path = None) -> tuple:
    """Stable identity key for a finding (path-relative, pattern, match prefix).

    Line numbers can drift as skills are edited, so we key on the relative
    path inside the skills dir, the pattern name, and the first 60 chars of
    the matched text. This gives stable identity across minor edits.
    """
    path = f['path']
    if skills_root:
        try:
            path = str(Path(path).relative_to(skills_root))
        except ValueError:
            pass
    return (path, f['pattern'], f['match'][:60])


def _load_baseline(baseline_path: Path) -> set:
    """Return the set of finding keys recorded in the baseline file."""
    try:
        data = json.loads(baseline_path.read_text())
        root = Path(data.get('skills_root', ''))
        keys = set()
        for f in data.get('findings', []):
            keys.add(_finding_key(f, root if root != Path('') else None))
        return keys
    except (OSError, json.JSONDecodeError, KeyError):
        return set()


def _save_baseline(findings: list, skills_root: Path, baseline_path: Path) -> None:
    """Write current findings as the accepted baseline."""
    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    baseline_path.write_text(json.dumps({
        'skills_root': str(skills_root),
        'findings': findings,
    }, indent=2))
    print(f'skill-audit: baseline saved ({len(findings)} entries) -> {baseline_path}')


def _alertable(findings: list) -> list:
    """Return only WARN-severity findings (size-limit is INFO, never alert)."""
    return [f for f in findings if f.get('severity') != 'INFO']


def _send_alert(agent_id: str, findings: list, token_file: Path) -> None:
    """POST an inter-agent alert to agent_id via the fleet API."""
    try:
        token = token_file.read_text().splitlines()[0].strip()
    except OSError as exc:
        print(f'skill-audit: alert skipped -- cannot read token: {exc}', file=sys.stderr)
        return

    summary_lines = [
        f"  [{f['pattern']}] {Path(f['path']).name}:{f['line']}"
        for f in findings[:10]
    ]
    if len(findings) > 10:
        summary_lines.append(f'  ... and {len(findings) - 10} more')
    body = (
        f'skill-audit K-2: {len(findings)} NEW suspicious pattern(s) in ~/.claude/skills/\n'
        + '\n'.join(summary_lines)
        + '\nFull details: python3 scripts/skill-audit.py'
    )

    payload = json.dumps({'from': 'rackham', 'to': agent_id, 'content': body}).encode()
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
    """Return (skills_root, alert_agent, token_file, baseline, save_baseline)."""
    skills_root = None
    alert_agent = None
    token_file = _default_token_file()
    baseline = None
    save_baseline = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == '--alert-agent':
            i += 1
            alert_agent = argv[i] if i < len(argv) else None
        elif arg == '--token-file':
            i += 1
            token_file = Path(argv[i]) if i < len(argv) else token_file
        elif arg == '--baseline':
            i += 1
            baseline = Path(argv[i]) if i < len(argv) else None
        elif arg == '--save-baseline':
            i += 1
            save_baseline = Path(argv[i]) if i < len(argv) else None
        elif not arg.startswith('-'):
            skills_root = Path(os.path.expanduser(arg))
        i += 1
    if skills_root is None:
        skills_root = Path(os.path.expanduser('~/.claude/skills'))
    return skills_root, alert_agent, token_file, baseline, save_baseline


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]

    skills_root, alert_agent, token_file, baseline_path, save_baseline_path = _parse_args(argv)

    if not skills_root.exists():
        print(f'skill-audit: skills dir not found ({skills_root}), nothing to scan',
              file=sys.stderr)
        return 0

    findings = scan_skills_dir(skills_root)

    # --save-baseline: snapshot current state as accepted, exit 0
    if save_baseline_path is not None:
        _save_baseline(findings, skills_root, save_baseline_path)
        return 0

    # Partition: size-limit=INFO (always log, never alert), regex=WARN
    info_findings = [f for f in findings if f.get('severity') == 'INFO']
    warn_findings = [f for f in findings if f.get('severity') != 'INFO']

    # Baseline-delta: suppress known accepted findings
    known_keys: set = set()
    if baseline_path:
        known_keys = _load_baseline(baseline_path)

    new_warn = [f for f in warn_findings
                if _finding_key(f, skills_root) not in known_keys]
    known_warn = [f for f in warn_findings
                  if _finding_key(f, skills_root) in known_keys]

    # Always log everything found (INFO + WARN + baseline-suppressed)
    if info_findings:
        print(f'skill-audit: {len(info_findings)} INFO (size-limit, suppressed from alert):',
              file=sys.stderr)
        for f in info_findings:
            print(f"  [INFO/{f['pattern']}] {f['path']}:{f['line']} -- {f['match']}",
                  file=sys.stderr)

    if known_warn:
        print(f'skill-audit: {len(known_warn)} WARN baseline-known (suppressed):',
              file=sys.stderr)
        for f in known_warn:
            print(f"  [KNOWN/{f['pattern']}] {f['path']}:{f['line']} -- {f['match']}",
                  file=sys.stderr)

    if not new_warn:
        total = len(info_findings) + len(known_warn)
        if total:
            print(f'skill-audit: 0 new findings ({total} suppressed by INFO/baseline)')
        else:
            print(f'skill-audit: CLEAN -- 0 findings in {skills_root}')
        return 0

    print(f'skill-audit: {len(new_warn)} NEW finding(s) in {skills_root}', file=sys.stderr)
    for f in new_warn:
        print(f"  [NEW/{f['pattern']}] {f['path']}:{f['line']} -- {f['match']}",
              file=sys.stderr)

    if alert_agent:
        _send_alert(alert_agent, new_warn, token_file)

    return 1


if __name__ == '__main__':
    sys.exit(main())
