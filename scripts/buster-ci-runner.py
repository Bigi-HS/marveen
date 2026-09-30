#!/usr/bin/env python3
"""
Buster CI runner (card 585da3ce): detect open PRs without a CI run,
run pre-gate-bundle.sh in a git worktree, post results to /api/gate/ci.

Design:
  - Idempotent: skips PRs whose current head_sha already has a CI run.
  - Fail-safe: errors on individual PRs are logged but do not abort the sweep.
  - Worktree cleanup: always removes the temporary worktree even on failure.
  - Token identity: /api/gate/ci is identity-bound to 'buster'. Operator/admin
    tokens also pass (GATE_CI_IDENTITY_OVERRIDE env var for testing).

Usage:
  python3 scripts/buster-ci-runner.py [--dry-run] [--pr N]

  --dry-run  Log what would run but don't execute pre-gate-bundle or POST.
  --pr N     Only process PR number N (skip the open-PR sweep).

Exit 0 always (errors are logged; the heartbeat caller handles alerting).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

INSTALL_DIR = Path('/home/domin/marveen')
GITHUB_REPO = 'Bigi-HS/marveen'
GITHUB_API = 'https://api.github.com'
BUNDLE_SCRIPT = INSTALL_DIR / 'scripts' / 'pre-gate-bundle.sh'
DASH_API = 'http://localhost:3420'
# Token file: try the Buster per-agent token first; operator token as fallback.
TOKEN_CANDIDATES = [
    INSTALL_DIR / 'agents' / 'buster' / 'store' / '.dashboard-token',
    INSTALL_DIR / 'store' / '.dashboard-token',
]
MAX_CONCURRENT_PRS = 1   # run one at a time (worktrees are expensive)
PR_TIMEOUT_S = 600       # 10 minutes per PR (tsc+vitest can be slow)


def _token():
    override = os.environ.get('BUSTER_CI_TOKEN')
    if override:
        return override
    for p in TOKEN_CANDIDATES:
        if p.exists():
            return p.read_text().strip()
    raise RuntimeError('No Buster CI token file found. Set BUSTER_CI_TOKEN or ensure '
                       'agents/buster/store/.dashboard-token or store/.dashboard-token exists.')


def _github_token() -> str:
    creds_path = os.path.expanduser('~/.git-credentials')
    with open(creds_path) as fh:
        creds = fh.read()
    m = re.search(r'https://[^:]+:([^@]+)@github\.com', creds)
    if not m:
        raise RuntimeError('GitHub PAT not found in ~/.git-credentials')
    return m.group(1)


def _github_get(path: str, gh_token: str) -> dict | list:
    req = urllib.request.Request(
        f'{GITHUB_API}{path}',
        headers={'Authorization': f'token {gh_token}',
                 'Accept': 'application/vnd.github+json',
                 'User-Agent': 'buster-ci-runner'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def _api(method: str, path: str, body=None, token: str = '') -> dict:
    url = f'{DASH_API}{path}'
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method,
        headers={'Authorization': f'Bearer {token}',
                 'Content-Type': 'application/json'})
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'HTTP {e.code}: {e.read().decode()[:200]}')


def _get_open_prs() -> list:
    """Return list of open PRs via GitHub REST API: [{number, headRefOid, baseRefName}]."""
    prs = _github_get(f'/repos/{GITHUB_REPO}/pulls?state=open&per_page=30', _github_token())
    return [
        {'number': pr['number'],
         'headRefOid': pr['head']['sha'],
         'baseRefName': pr['base']['ref']}
        for pr in prs
    ]


def _ci_already_done(pr_number: int, head_sha: str, token: str) -> bool:
    """Return True if /api/gate/check shows ci_status pass/fail for this head."""
    try:
        gate = _api('GET', f'/api/gate/check?pr={pr_number}', token=token)
        ci_status = gate.get('ci_status', 'none')
        # head_sha from the gate check
        gate_sha = (gate.get('pr') or {}).get('head', {}).get('sha', '')
        if ci_status in ('pass', 'fail') and gate_sha and gate_sha == head_sha:
            return True
    except Exception:
        pass
    return False


def _fetch_pr_head(pr_number: int, head_sha: str) -> None:
    """Fetch the PR's head into the local repo via pull/<N>/head ref."""
    subprocess.run(
        ['git', 'fetch', '--depth=1', 'origin', f'pull/{pr_number}/head'],
        cwd=str(INSTALL_DIR), capture_output=True, check=True, timeout=60
    )


def _run_bundle_in_worktree(pr_number: int, head_sha: str, base_branch: str,
                             dry_run: bool) -> tuple[str, dict]:
    """Create a detached worktree, run pre-gate-bundle.sh, return (status, payload)."""
    if dry_run:
        wt_dir = Path(tempfile.mkdtemp(prefix=f'buster-ci-pr{pr_number}-'))
        print(f'  [dry-run] would create worktree at {wt_dir} for {head_sha[:8]}')
        shutil.rmtree(str(wt_dir), ignore_errors=True)
        return 'pass', {'status': 'pass', 'tsc_ok': None, 'note': 'dry-run'}

    wt_dir = Path(tempfile.mkdtemp(prefix=f'buster-ci-pr{pr_number}-'))
    wt_created = False
    try:
        # Worktree at the fetched PR head
        subprocess.run(
            ['git', 'worktree', 'add', '--detach', str(wt_dir), 'FETCH_HEAD'],
            cwd=str(INSTALL_DIR), capture_output=True, check=True, timeout=30
        )
        wt_created = True

        # Run pre-gate-bundle.sh with --json
        result = subprocess.run(
            ['bash', str(BUNDLE_SCRIPT), base_branch, head_sha, '--json'],
            capture_output=True, text=True, cwd=str(wt_dir), timeout=PR_TIMEOUT_S
        )

        bundle = None
        try:
            bundle = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass

        verdict = (bundle or {}).get('verdict', 'BLOCK')
        # WARN is not a hard failure (type / size warnings don't block merge)
        ci_status = 'pass' if verdict in ('PASS', 'WARN') else 'fail'

        payload = {
            'pr_number': pr_number,
            'head_sha': head_sha,
            'status': ci_status,
            'note': f'bundle verdict: {verdict}; exit {result.returncode}',
        }

        # Extract tsc / vitest counts from checks
        checks = {c['name']: c for c in (bundle or {}).get('checks', [])}
        tc = checks.get('typecheck', {})
        payload['tsc_ok'] = 1 if tc.get('status') == 'PASS' else 0

        tests_detail = checks.get('tests', {}).get('detail', '')
        m = re.search(r'(\d+)\s+pass', tests_detail, re.IGNORECASE)
        if m:
            payload['tests_pass'] = int(m.group(1))
        m = re.search(r'(\d+)\s+fail', tests_detail, re.IGNORECASE)
        if m:
            payload['tests_fail'] = int(m.group(1))

        diff_files = (bundle or {}).get('diff_files')
        if diff_files is not None:
            payload['diff_files'] = diff_files
        additions = (bundle or {}).get('diff_additions')
        if additions is not None:
            payload['insertions'] = additions

        return ci_status, payload

    finally:
        # Only clean up if the worktree was actually created
        if wt_created:
            try:
                subprocess.run(
                    ['git', 'worktree', 'remove', '--force', str(wt_dir)],
                    cwd=str(INSTALL_DIR), capture_output=True, timeout=30
                )
            except Exception:
                shutil.rmtree(str(wt_dir), ignore_errors=True)
        else:
            shutil.rmtree(str(wt_dir), ignore_errors=True)


def run_pr(pr_number: int, head_sha: str, base_branch: str,
           token: str, dry_run: bool) -> bool:
    """Run CI for one PR. Returns True on success, False on error."""
    print(f'PR#{pr_number}: CI start (head {head_sha[:8]}, base {base_branch})')
    try:
        _fetch_pr_head(pr_number, head_sha)
        ci_status, payload = _run_bundle_in_worktree(
            pr_number, head_sha, base_branch, dry_run)

        if not dry_run:
            _api('POST', '/api/gate/ci', body=payload, token=token)

        print(f'PR#{pr_number}: CI {ci_status} -- {payload.get("note", "")}')
        return True
    except Exception as e:
        print(f'PR#{pr_number}: CI ERROR: {e}', file=sys.stderr)
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dry-run', action='store_true',
                    help='Log actions without running bundle or posting results')
    ap.add_argument('--pr', type=int, default=None,
                    help='Only process this PR number')
    args = ap.parse_args()

    try:
        token = _token()
    except RuntimeError as e:
        print(f'TOKEN ERROR: {e}', file=sys.stderr)
        return 0  # fail-open: don't crash the heartbeat

    if args.pr:
        # Single-PR mode: get head/base from GitHub REST API
        try:
            gh_token = _github_token()
            pr_data = _github_get(f'/repos/{GITHUB_REPO}/pulls/{args.pr}', gh_token)
            run_pr(pr_data['number'], pr_data['head']['sha'],
                   pr_data['base'].get('ref', 'develop'), token, args.dry_run)
        except Exception as e:
            print(f'Single-PR mode failed: {e}', file=sys.stderr)
        return 0

    # Sweep all open PRs
    try:
        prs = _get_open_prs()
    except Exception as e:
        print(f'PR sweep failed: {e}', file=sys.stderr)
        return 0

    ran = 0
    skipped = 0
    errors = 0
    for pr in prs:
        pr_number = pr['number']
        head_sha = pr['headRefOid']
        base_branch = pr.get('baseRefName', 'develop')

        if _ci_already_done(pr_number, head_sha, token):
            print(f'PR#{pr_number}: CI already done for {head_sha[:8]}, skip')
            skipped += 1
            continue

        ok = run_pr(pr_number, head_sha, base_branch, token, args.dry_run)
        if ok:
            ran += 1
        else:
            errors += 1

    print(f'Buster CI sweep: ran={ran} skipped={skipped} errors={errors}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
