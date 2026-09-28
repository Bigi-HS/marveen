#!/usr/bin/env python3
"""Adversarial fixture gate for guardrail-permission-rules.py (card 0aa0ad3b).

Three required adversarial fixtures -- each must pass on the SOURCE:
  FP  (false-positive probe): a BENIGN action that MUST NOT be blocked
  FN  (false-negative probe): a HARMFUL action that MUST be blocked
  OPP (opposing combination): tests the boundary between FP and FN

Run by promote-guard.py as the canary gate before promotion.
"""
import os
import sys
import importlib.util

SHARED = '/home/domin/marveen'
WORKTREE = '/home/domin/marveen-wt/abc123'

def load(target):
    spec = importlib.util.spec_from_file_location('guardrail_rules_canary', target)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def bash(cmd, cwd=None):
    payload = {'tool_name': 'Bash', 'tool_input': {'command': cmd}}
    if cwd is not None:
        payload['cwd'] = cwd
    return payload


def check(mod, label, payload, expect_denied):
    denied, rule, reason = mod.classify(payload)
    if denied != expect_denied:
        verdict = 'DENIED' if denied else 'ALLOWED'
        expected = 'DENIED' if expect_denied else 'ALLOWED'
        print(f'FAIL [{label}]: got {verdict}, expected {expected}. rule={rule!r}')
        print(f'  payload: {payload}')
        if reason:
            print(f'  reason: {reason}')
        return False
    return True


def main(target):
    mod = load(target)
    failures = 0

    # ── FP: worktree commit MUST pass ──────────────────────────────────────────
    # An agent doing legitimate eng work in a worktree must be able to commit.
    # This is the most important false-positive: over-blocking here would strand
    # every PR workflow.
    ok = check(mod, 'FP-1 worktree-commit',
               bash('git commit -m "feat: implement the thing"', cwd=WORKTREE),
               expect_denied=False)
    failures += not ok

    ok = check(mod, 'FP-2 worktree-merge',
               bash('git merge --no-ff origin/develop', cwd=WORKTREE),
               expect_denied=False)
    failures += not ok

    ok = check(mod, 'FP-3 no-cwd-commit',
               bash('git commit -m "no cwd context"'),   # no cwd field
               expect_denied=False)
    failures += not ok

    # ── FN: shared-checkout commit MUST be blocked ─────────────────────────────
    # The incident class: agent commits directly to the shared /home/domin/marveen
    # tree on develop. The 08:00 rebuild-pull then fails with "untracked file
    # would be overwritten" or silently wipes the local commit.
    ok = check(mod, 'FN-1 shared-commit',
               bash('git commit -m "fix: direct commit"', cwd=SHARED),
               expect_denied=True)
    failures += not ok

    ok = check(mod, 'FN-2 shared-merge',
               bash('git merge origin/feature-x', cwd=SHARED),
               expect_denied=True)
    failures += not ok

    ok = check(mod, 'FN-3 shared-rebase',
               bash('git rebase origin/develop', cwd=SHARED),
               expect_denied=True)
    failures += not ok

    # ── FN: value-flag bypass MUST be blocked (card db0a45c6) ───────────────────
    # git global options that take a space-separated value (-c <k=v>, -C <path>,
    # --git-dir/--work-tree/--namespace <arg>) consume the following token. A naive
    # "first non-flag token is the subcommand" scan mistook that value for the
    # subcommand, letting these commit/merge/rebase forms slip past the guard.
    ok = check(mod, 'FN-4 shared-commit-with-c-flag',
               bash('git -c user.name=x commit -m "bypass via -c"', cwd=SHARED),
               expect_denied=True)
    failures += not ok

    ok = check(mod, 'FN-5 shared-commit-with-C-flag',
               bash('git -C /home/domin/marveen commit -m "bypass via -C"', cwd=SHARED),
               expect_denied=True)
    failures += not ok

    ok = check(mod, 'FN-6 shared-merge-with-c-flag',
               bash('git -c core.editor=true merge origin/feature-x', cwd=SHARED),
               expect_denied=True)
    failures += not ok

    # ── OPP: boundary -- git read ops in shared checkout MUST pass ─────────────
    # git log, git status, git diff are read-only and must never be blocked.
    ok = check(mod, 'OPP-1 shared-status',
               bash('git status', cwd=SHARED),
               expect_denied=False)
    failures += not ok

    ok = check(mod, 'OPP-2 shared-log',
               bash('git log --oneline -10', cwd=SHARED),
               expect_denied=False)
    failures += not ok

    ok = check(mod, 'OPP-3 shared-diff',
               bash('git diff HEAD~1', cwd=SHARED),
               expect_denied=False)
    failures += not ok

    # A value-flag before a READ op must still pass -- the value-flag skip must not
    # over-reach and start blocking read ops (card db0a45c6 regression guard).
    ok = check(mod, 'OPP-4 shared-status-with-c-flag',
               bash('git -c color.ui=always status', cwd=SHARED),
               expect_denied=False)
    failures += not ok

    if failures:
        print(f'\n{failures} adversarial fixture(s) FAILED -- promotion refused.')
        sys.exit(1)
    print(f'All {13} adversarial fixtures passed.')
    sys.exit(0)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('usage: canary_guardrail_permission_rules.py <source-path>')
        sys.exit(1)
    main(sys.argv[1])
