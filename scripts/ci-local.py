#!/usr/bin/env python3
"""ci-local.py -- generalized local CI-parity runner (card 24b12610).

Lets any fleet agent reproduce, LOCALLY, the EXACT verdict that Buster-CI will
post for a PR -- with the full per-check evidence sheet -- before the merge
gate. It does this by REUSING the canonical `scripts/pre-gate-bundle.sh` (the CI
brain); it does NOT re-encode any check logic, and it NEVER POSTs to
`/api/gate/ci`. The authoritative CI record stays Buster-identity-bound.

Why this exists (card 24b12610, verified in code):
  - Agents only see the final `ci_status` badge, never the PGB evidence sheet
    that decides their own PRs.
  - Reproducing a CI verdict in a bare worktree false-BLOCKs because the worktree
    has no node_modules -> npx downloads a mismatched tsc/vitest (card ebe474ee).
    This runner symlinks the repo's pinned node_modules, killing that false-BLOCK
    at the source -- the same fix buster-ci-runner.py applies.

Generalized (NoA Q2): `--agent <id>` labels the run; the mechanic is identical
for Thor (structured CI output) and Armorer (dist-integrity) -- one shared
runner, not a Dave-only tool.

READ-only vs the fleet (NoA Q1 invariant): this runner only READS live state
(`--compare-live` GETs the posted ci_status). All WRITE PR-ops (open/merge/close)
stay on the fleet endpoint so `recorded_author` + MG-SEC7 author-recusal cannot
be bypassed. gh (if wired) is likewise read-only.

Usage:
  scripts/ci-local.py [--base BRANCH] [--head SHA] [--pr N] [--agent ID]
                      [--compare-live] [--json] [--dry-run]

  Local mode (default): check the current branch HEAD against `develop`.
  PR-parity mode (--pr N): fetch GitHub's pull/N/merge ref and check THAT (byte
  parity with what Buster-CI evaluates).

Exit code mirrors PGB: BLOCK -> 1, PASS/WARN -> 0.

NOTE: the worktree + node_modules-symlink + gitleaks-symlink + run-the-worktree's-
own-PGB plumbing below deliberately mirrors buster-ci-runner.py's inline copy.
It is git plumbing, not CI logic (the CI logic is 100% in pre-gate-bundle.sh,
reused verbatim). A follow-up card can extract this plumbing into a shared
`scripts/lib/pgb_worktree.py` that BOTH runners import; that touches Buster's
identity-bound live CI component, so it is intentionally out of scope here.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

INSTALL_DIR = Path(__file__).resolve().parent.parent
BUNDLE_SCRIPT = INSTALL_DIR / 'scripts' / 'pre-gate-bundle.sh'
API_BASE = 'http://localhost:3420'
PR_TIMEOUT_S = 900


# --------------------------------------------------------------------------- #
# Pure helpers (sourced + unit-tested without running git or the checks)       #
# --------------------------------------------------------------------------- #

def parse_args(argv):
    """Parse argv into a plain dict (testable without argparse's SystemExit)."""
    p = argparse.ArgumentParser(prog='ci-local.py', add_help=True)
    p.add_argument('--base', default='develop')
    p.add_argument('--head', default='HEAD')
    p.add_argument('--pr', type=int, default=None)
    p.add_argument('--agent', default='dave')
    p.add_argument('--compare-live', dest='compare_live', action='store_true')
    p.add_argument('--json', dest='json_out', action='store_true')
    p.add_argument('--dry-run', dest='dry_run', action='store_true')
    ns = p.parse_args(argv)
    return {
        'base': ns.base,
        'head': ns.head,
        'pr': ns.pr,
        'agent': ns.agent,
        'compare_live': ns.compare_live,
        'json_out': ns.json_out,
        'dry_run': ns.dry_run,
    }


def verdict_to_ci_status(verdict):
    """Map a PGB verdict to the fleet ci_status. Parity with buster-ci-runner:
    PASS/WARN -> 'pass' (warnings don't block merge), anything else -> 'fail'
    (fail-closed: an unknown/unparseable verdict never reads as green)."""
    return 'pass' if verdict in ('PASS', 'WARN') else 'fail'


def verdict_to_exit(verdict):
    """Exit-code parity with pre-gate-bundle.sh: BLOCK -> 1, else 0."""
    return 1 if verdict not in ('PASS', 'WARN') else 0


def compute_drift(local_verdict, posted_ci_status):
    """Compare the local verdict against the posted live ci_status (read-only).

    posted_ci_status is the /api/gate/check `ci_status` field: 'pass' | 'fail' |
    'none'. 'none' means Buster-CI hasn't posted yet -> not a drift. Otherwise a
    mismatch between the local mapping and the live status is a drift alarm
    (e.g. local PASS but live BLOCK = stale/ahead; local BLOCK but live pass =
    the board is stale relative to the current head)."""
    local_ci = verdict_to_ci_status(local_verdict)
    if posted_ci_status in (None, 'none', ''):
        return {'drift': False,
                'message': f'no live CI posted yet (ci_status=none); local={local_ci}'}
    if local_ci == posted_ci_status:
        return {'drift': False, 'message': f'local {local_ci} == live {posted_ci_status}'}
    return {'drift': True,
            'message': f'DRIFT: local {local_ci} vs live {posted_ci_status}'}


def format_evidence(bundle, agent, head_sha=None):
    """Render a PGB bundle dict into a human evidence sheet. Tolerant of a
    missing/empty bundle (a failed/unparseable run must not crash the sheet).
    head_sha, when given, is recorded for provenance (which commit was checked)."""
    verdict = (bundle or {}).get('verdict', 'UNKNOWN')
    lines = [
        f'CI-local evidence sheet (agent: {agent})',
    ]
    if head_sha:
        lines.append(f'checked: {head_sha}')
    lines.append(f'verdict: {verdict}')
    adds = (bundle or {}).get('diff_additions')
    files = (bundle or {}).get('diff_files')
    if adds is not None or files is not None:
        lines.append(f'diff: +{adds if adds is not None else "?"} lines, '
                     f'{files if files is not None else "?"} files')
    checks = (bundle or {}).get('checks', [])
    if checks:
        lines.append('checks:')
        for ch in checks:
            lines.append(f"  {ch.get('name', '?')}: {ch.get('status', '?')} "
                         f"-- {ch.get('detail', '')}")
    return '\n'.join(lines)


# --------------------------------------------------------------------------- #
# IO layer (git plumbing + read-only API) -- never runs at import              #
# --------------------------------------------------------------------------- #

def _token():
    tok_file = os.environ.get('GENESIS_TOKEN_FILE')
    if tok_file:
        with open(tok_file) as f:
            return f.readline().strip()
    env = os.environ.get('GENESIS_AGENT_TOKEN')
    if env:
        return env.strip()
    with open(INSTALL_DIR / 'store' / '.dashboard-token') as f:
        return f.read().strip()


def _resolve_head(args):
    """Resolve the head SHA to check. PR mode fetches GitHub's merge-ref (byte
    parity with Buster-CI); local mode resolves --head (default HEAD)."""
    if args['pr'] is not None:
        subprocess.run(
            ['git', 'fetch', '--depth=1', 'origin', f"pull/{args['pr']}/merge"],
            cwd=str(INSTALL_DIR), capture_output=True, check=True, timeout=60)
        out = subprocess.run(['git', 'rev-parse', 'FETCH_HEAD'],
                             cwd=str(INSTALL_DIR), capture_output=True,
                             text=True, check=True, timeout=15)
        return 'FETCH_HEAD', out.stdout.strip()
    out = subprocess.run(['git', 'rev-parse', args['head']],
                         cwd=str(INSTALL_DIR), capture_output=True,
                         text=True, check=True, timeout=15)
    return args['head'], out.stdout.strip()


def _run_bundle(checkout_ref, base_branch, dry_run):
    """Create a detached worktree at checkout_ref, symlink the repo's pinned
    node_modules + gitleaks, run the worktree's own pre-gate-bundle.sh --json,
    and return the parsed bundle dict. Mirrors buster-ci-runner.py's plumbing;
    does NOT POST."""
    wt_dir = Path(tempfile.mkdtemp(prefix='ci-local-'))
    if dry_run:
        shutil.rmtree(str(wt_dir), ignore_errors=True)
        return {'verdict': 'PASS', 'checks': [], 'note': 'dry-run'}

    wt_created = False
    try:
        subprocess.run(
            ['git', 'worktree', 'add', '--detach', str(wt_dir), checkout_ref],
            cwd=str(INSTALL_DIR), capture_output=True, check=True, timeout=30)
        wt_created = True

        nm_link = wt_dir / 'node_modules'
        if not nm_link.exists():
            os.symlink(str(INSTALL_DIR / 'node_modules'), str(nm_link))

        gl_src = INSTALL_DIR / 'scripts' / 'bin' / 'gitleaks'
        if gl_src.exists():
            wt_gl = wt_dir / 'scripts' / 'bin' / 'gitleaks'
            if wt_gl.parent.is_dir() and not wt_gl.exists():
                os.symlink(str(gl_src), str(wt_gl))

        wt_bundle = wt_dir / 'scripts' / 'pre-gate-bundle.sh'
        bundle_script = wt_bundle if wt_bundle.exists() else BUNDLE_SCRIPT
        head_sha = subprocess.run(['git', 'rev-parse', 'HEAD'],
                                  cwd=str(wt_dir), capture_output=True,
                                  text=True, check=True, timeout=15).stdout.strip()
        result = subprocess.run(
            ['bash', str(bundle_script), base_branch, head_sha, '--json'],
            capture_output=True, text=True, cwd=str(wt_dir), timeout=PR_TIMEOUT_S)
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return {'verdict': 'BLOCK', 'checks': [],
                    'note': f'bundle emitted no JSON (exit {result.returncode}); '
                            f'stderr: {result.stderr[:200]}'}
    finally:
        if wt_created:
            subprocess.run(
                ['git', 'worktree', 'remove', '--force', str(wt_dir)],
                cwd=str(INSTALL_DIR), capture_output=True, timeout=30)
        else:
            shutil.rmtree(str(wt_dir), ignore_errors=True)


def _fetch_live_ci_status(pr_number):
    """Read-only GET of the posted ci_status for a PR. Returns 'pass'|'fail'|
    'none'. Never writes."""
    req = urllib.request.Request(
        f'{API_BASE}/api/gate/check?pr={pr_number}',
        headers={'Authorization': f'Bearer {_token()}'}, method='GET')
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read().decode())
    return data.get('ci_status', 'none')


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    checkout_ref, head_sha = _resolve_head(args)
    bundle = _run_bundle(checkout_ref, args['base'], args['dry_run'])
    verdict = bundle.get('verdict', 'BLOCK')

    if args['json_out']:
        print(json.dumps(bundle, indent=2))
    else:
        print(format_evidence(bundle, args['agent'], head_sha))

    if args['compare_live'] and args['pr'] is not None:
        posted = _fetch_live_ci_status(args['pr'])
        drift = compute_drift(verdict, posted)
        print(drift['message'])

    return verdict_to_exit(verdict)


if __name__ == '__main__':
    sys.exit(main())
