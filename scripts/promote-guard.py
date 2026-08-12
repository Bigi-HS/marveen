#!/usr/bin/env python3
"""Promote a PreToolUse guard from the checkout to the live guard path.

WHY THIS EXISTS (card 2cb1ed6e).  The fleet's PreToolUse hook used to be spelled
`$CLAUDE_PROJECT_DIR/scripts/hooks/...`, which had two consequences nobody chose:

  P1  an agent whose cwd is a worktree resolved that to the WORKTREE's stale copy,
      so 39 different vintages of the same guard were reachable, 31 of them from
      before 2026-07-01;
  P2  in the main checkout the live hook WAS the working copy, so editing the
      guard deployed it.  b85acbf carried a bypass for about an hour while it was
      still under review, because "deploy" and "save the file" were the same act.

Pinning settings.json to `<repo>/.guard/<name>` kills P1 structurally: every agent
in every cwd consults one canonical file.  This script is the only thing that
writes that file, and it refuses unless the source is committed and both gates
pass -- which kills P2, because a repo edit no longer reaches the fleet until
somebody promotes it deliberately.

Layout, by convention:
    source  scripts/hooks/<guard>.py
    suite   scripts/hooks/test_<guard_underscored>.py
    canary  scripts/hooks/canary_<guard_underscored>.py
    live    .guard/<guard>.py   +   .guard/<guard>.py.manifest.json

Usage:
    python3 scripts/promote-guard.py                    # promote the default set
    python3 scripts/promote-guard.py guardrail-x.py     # promote one guard
    python3 scripts/promote-guard.py --verify           # report live vs source

Fail-closed: any doubt, and the previously promoted file stays exactly as it is.
A guard that is half-written is worse than one that is a day old.
"""
import datetime
import hashlib
import json
import os
import subprocess
import sys
import tempfile

DEFAULT_GUARDS = ['guardrail-permission-rules.py']
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARD_DIRNAME = '.guard'


class PromotionRefused(Exception):
    """Raised for every rejection.  Nothing has been written when it is raised."""


def _stem(name):
    return name[:-3].replace('-', '_') if name.endswith('.py') else name.replace('-', '_')


def _paths(name, repo_root, guard_dir):
    hooks = os.path.join(repo_root, 'scripts', 'hooks')
    return {
        'source': os.path.join(hooks, name),
        'suite': os.path.join(hooks, 'test_%s.py' % _stem(name)),
        'canary': os.path.join(hooks, 'canary_%s.py' % _stem(name)),
        'live': os.path.join(guard_dir, name),
        'manifest': os.path.join(guard_dir, name + '.manifest.json'),
    }


def _sha256(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _git(args, repo_root):
    return subprocess.run(['git'] + args, cwd=repo_root, capture_output=True, text=True)


def _require_committed(source, repo_root):
    """The source must be tracked AND clean.  This is the gate that puts review
    before activation: an unreviewed edit sitting in the working tree cannot be
    promoted, so it cannot reach any agent."""
    rel = os.path.relpath(source, repo_root)
    if _git(['ls-files', '--error-unmatch', rel], repo_root).returncode != 0:
        raise PromotionRefused('%s is not tracked by git -- refusing to promote '
                               'a file with no reviewable history' % rel)
    status = _git(['status', '--porcelain', '--', rel], repo_root)
    if status.stdout.strip():
        raise PromotionRefused('%s has uncommitted changes -- commit and review '
                               'first, then promote' % rel)


def _run_gate(kind, script, target, repo_root, pass_target=True):
    """Run one gate script.  `pass_target` is False for the unit suite, because
    unittest.main() parses sys.argv and would read the target path as a test
    name -- the suite already imports the source by convention."""
    if not os.path.isfile(script):
        raise PromotionRefused('no %s found at %s -- a guard without a %s is not '
                               'promotable' % (kind, os.path.relpath(script, repo_root), kind))
    argv = [sys.executable, script] + ([target] if pass_target else [])
    proc = subprocess.run(argv, cwd=repo_root, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or '').strip().split('\n')[-12:]
        raise PromotionRefused('%s failed (exit %d) for %s:\n%s'
                               % (kind, proc.returncode, os.path.basename(target),
                                  '\n'.join(tail)))
    return os.path.relpath(script, repo_root)


def promote(name, repo_root=REPO_ROOT, guard_dir=None):
    """Run both gates against the SOURCE, then publish it atomically.

    The gates deliberately run on the source rather than on the live copy: a
    canary pointed at what is already deployed certifies the old code and waves
    the new one through without ever looking at it."""
    guard_dir = guard_dir or os.path.join(repo_root, GUARD_DIRNAME)
    p = _paths(name, repo_root, guard_dir)

    if not os.path.isfile(p['source']):
        raise PromotionRefused('%s not found in scripts/hooks' % name)
    _require_committed(p['source'], repo_root)
    suite = _run_gate('suite', p['suite'], p['source'], repo_root, pass_target=False)
    canary = _run_gate('canary', p['canary'], p['source'], repo_root)

    with open(p['source'], 'rb') as fh:
        payload = fh.read()
    os.makedirs(guard_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=guard_dir, prefix='.promote-')
    try:
        with os.fdopen(fd, 'wb') as fh:
            fh.write(payload)
        os.chmod(tmp, 0o644)
        os.replace(tmp, p['live'])          # atomic: no agent ever sees a partial guard
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise

    head = _git(['rev-parse', 'HEAD'], repo_root).stdout.strip()
    manifest = {
        'name': name,
        'source': os.path.relpath(p['source'], repo_root),
        'sha256': _sha256(p['live']),
        'git_head': head,
        'promoted_at': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
        'suite': suite,
        'canary': canary,
    }
    with open(p['manifest'], 'w') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')
    return manifest


def verify(name, repo_root=REPO_ROOT, guard_dir=None):
    """Report drift without changing anything.

    Two separate questions, deliberately not collapsed into one boolean:
      manifest_matches_live -- has the live file been edited behind the gate?
      live_matches_source   -- is the repo ahead of what the fleet is running?
    The second being False is the NORMAL state after any guard commit; only the
    first being False is an alarm."""
    guard_dir = guard_dir or os.path.join(repo_root, GUARD_DIRNAME)
    p = _paths(name, repo_root, guard_dir)
    report = {'name': name, 'live': p['live'], 'promoted': os.path.isfile(p['live'])}
    if not report['promoted']:
        report.update(manifest_matches_live=False, live_matches_source=False,
                      note='not promoted yet')
        return report
    live_sha = _sha256(p['live'])
    man = {}
    if os.path.isfile(p['manifest']):
        with open(p['manifest']) as fh:
            man = json.load(fh)
    report['sha256'] = live_sha
    report['git_head'] = man.get('git_head')
    report['promoted_at'] = man.get('promoted_at')
    report['manifest_matches_live'] = man.get('sha256') == live_sha
    report['live_matches_source'] = (os.path.isfile(p['source'])
                                     and _sha256(p['source']) == live_sha)
    return report


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    names = args or DEFAULT_GUARDS
    if '--verify' in argv:
        bad = 0
        for name in names:
            r = verify(name)
            bad += not r['manifest_matches_live']
            print('%-34s promoted=%s  manifest_ok=%s  matches_source=%s  head=%s'
                  % (name, r['promoted'], r['manifest_matches_live'],
                     r['live_matches_source'], (r.get('git_head') or '')[:8]))
            if not r['live_matches_source'] and r['promoted']:
                print('   note: the repo has moved on; the fleet runs the promoted copy '
                      'until you promote again')
        return 1 if bad else 0

    failed = 0
    for name in names:
        try:
            man = promote(name)
        except PromotionRefused as exc:
            failed += 1
            print('REFUSED %s\n  %s' % (name, exc))
            continue
        print('promoted %s\n  sha256 %s\n  head   %s\n  at     %s'
              % (name, man['sha256'][:16], man['git_head'][:8], man['promoted_at']))
    if failed:
        print('\n%d promotion(s) refused -- the live guard is unchanged' % failed)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
