#!/usr/bin/env python3
"""Guard-file watchdog: detects missing or drifted .guard/ live copies (card 3ceab75a).

The fleet's PreToolUse hooks point at .guard/<name>.py via absolute paths.  That
directory is gitignored, so git stash --all (or any operation that touches
untracked/gitignored files) can silently wipe it -- taking down every agent's
Bash/Write/Edit hooks fleet-wide (fail-closed, ~50min incident 2026-09-29 00:57).

Two states this watchdog handles:
  missing  -- .guard/<name> does not exist; emergency-copy from scripts/hooks/ + alert
  drifted  -- .guard/<name> exists but differs from scripts/hooks/ source; alert only
              (no silent overwrite of a live copy; use promote-guard.py to upgrade)

Run on a schedule (cron / noa scheduled-task) or ad hoc:
    python3 scripts/guard_watchdog.py
    python3 scripts/guard_watchdog.py --dry-run
"""
import hashlib
import json
import os
import sys
import tempfile
import urllib.request

DEFAULT_GUARDS = ['guardrail-permission-rules.py']
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALERT_RECIPIENTS = ['marveen', 'dave']


class GuardSourceMissing(Exception):
    """Source file in scripts/hooks/ is absent -- watchdog cannot recover."""


def _sha256_path(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _atomic_copy(src, dst):
    """Copy src -> dst atomically via tempfile+replace."""
    dst_dir = os.path.dirname(dst)
    os.makedirs(dst_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dst_dir, prefix='.gwatchdog-')
    try:
        with open(src, 'rb') as sfh, os.fdopen(fd, 'wb') as dfh:
            dfh.write(sfh.read())
        os.chmod(tmp, 0o644)
        os.replace(tmp, dst)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def check_guard_file(name, *, repo_root=REPO_ROOT, guard_dir=None, source_dir=None):
    """Check one guard file.  Returns a status dict.  Never raises (except GuardSourceMissing)."""
    guard_dir = guard_dir or os.path.join(repo_root, '.guard')
    source_dir = source_dir or os.path.join(repo_root, 'scripts', 'hooks')

    src = os.path.join(source_dir, name)
    live = os.path.join(guard_dir, name)

    if not os.path.isfile(src):
        raise GuardSourceMissing(f'source not found: {src}')

    src_sha = _sha256_path(src)

    if not os.path.isfile(live):
        _atomic_copy(src, live)
        return {
            'name': name,
            'status': 'recovered',
            'recovered': True,
            'drifted': False,
            'src_sha': src_sha,
            'message': f'RECOVERED: {name} was missing from .guard/ -- emergency-copied from scripts/hooks/.',
        }

    live_sha = _sha256_path(live)
    if live_sha == src_sha:
        return {
            'name': name,
            'status': 'ok',
            'recovered': False,
            'drifted': False,
            'src_sha': src_sha,
        }

    return {
        'name': name,
        'status': 'drifted',
        'recovered': False,
        'drifted': True,
        'src_sha': src_sha,
        'live_sha': live_sha,
        'message': (
            f'DRIFT: {name} live copy differs from scripts/hooks/ source. '
            'Run "python3 scripts/promote-guard.py" to upgrade the live copy.'
        ),
    }


def _send_alert(result, *, api_url, token, dry_run=False):
    """POST an inter-agent alert message for a non-ok guard status."""
    content = (
        f'GUARD-WATCHDOG ALERT [{result["status"].upper()}]: {result["name"]}. '
        f'{result.get("message", "")} '
        f'Run: python3 scripts/guard_watchdog.py to re-check.'
    )
    if dry_run:
        sys.stderr.write(f'[DRY-RUN] would alert: {content}\n')
        return

    payload = json.dumps({
        'from': 'marveen',
        'to': 'marveen',
        'content': content,
        'priority': 'urgent',
    }).encode()

    # alert all recipients
    for recipient in ALERT_RECIPIENTS:
        body = json.dumps({
            'from': 'marveen',
            'to': recipient,
            'content': content,
            'priority': 'urgent',
        }).encode()
        req = urllib.request.Request(
            f'{api_url}/api/messages',
            data=body,
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {token}',
            },
            method='POST',
        )
        try:
            urllib.request.urlopen(req, timeout=5)
        except Exception as exc:
            sys.stderr.write(f'guard-watchdog: alert to {recipient} failed: {exc}\n')


def run_watchdog(guards, *, repo_root=REPO_ROOT, guard_dir=None, source_dir=None,
                 api_url='http://localhost:3420', token, dry_run=False):
    """Check all guards.  Returns list of result dicts."""
    results = []
    for name in guards:
        try:
            result = check_guard_file(name, repo_root=repo_root,
                                      guard_dir=guard_dir, source_dir=source_dir)
        except GuardSourceMissing as exc:
            result = {
                'name': name,
                'status': 'error',
                'recovered': False,
                'drifted': False,
                'message': str(exc),
            }
        except Exception as exc:
            result = {
                'name': name,
                'status': 'error',
                'recovered': False,
                'drifted': False,
                'message': f'unexpected error: {exc}',
            }

        results.append(result)

        if result['status'] != 'ok':
            try:
                _send_alert(result, api_url=api_url, token=token, dry_run=dry_run)
            except Exception as exc:
                sys.stderr.write(f'guard-watchdog: _send_alert raised: {exc}\n')

    return results


def _read_token(repo_root=REPO_ROOT):
    token_path = os.path.join(repo_root, 'store', '.dashboard-token')
    try:
        with open(token_path) as fh:
            return fh.read().strip()
    except OSError:
        return os.environ.get('GENESIS_AGENT_TOKEN', '')


def main(argv=None):
    argv = argv or sys.argv[1:]
    dry_run = '--dry-run' in argv
    guards = [a for a in argv if not a.startswith('--')] or DEFAULT_GUARDS

    token = _read_token()
    results = run_watchdog(
        guards,
        dry_run=dry_run,
        token=token,
    )

    any_issue = False
    for r in results:
        if r['status'] == 'ok':
            print(f'OK      {r["name"]}')
        elif r['status'] == 'recovered':
            print(f'RECOVER {r["name"]}  -- {r["message"]}', file=sys.stderr)
            any_issue = True
        elif r['status'] == 'drifted':
            print(f'DRIFT   {r["name"]}  -- {r["message"]}', file=sys.stderr)
            any_issue = True
        else:
            print(f'ERROR   {r["name"]}  -- {r.get("message", "unknown")}', file=sys.stderr)
            any_issue = True

    sys.exit(1 if any_issue else 0)


if __name__ == '__main__':
    main()
