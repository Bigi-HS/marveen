#!/usr/bin/env python3
"""REVIEW-TIME guard: no NEW tmux session-name prefix collision in SOURCE.

Reads names the repository can PRODUCE (agent ids -> `agent-<id>`, the main
agent's dashboard/channels pair, and fixed `new-session -s <literal>` names).
It never looks at the running fleet: this guard must fail when someone ADDS a
colliding name, which is months before that session first starts.

Exit: 0 measured+clean, 1 violation, 2 could not measure.
Run: python3 scripts/session-name-prefix-lint.py [repo-root]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from session_prefix_guard import (  # noqa: E402
    EXIT_OK, EXIT_UNMEASURABLE, EXIT_VIOLATION, Unmeasurable, derive_source_names,
    find_pairs, glob_risky, known_pairs, main_agent_id, unsanctioned,
)


def main(argv: list[str]) -> int:
    root = argv[1] if len(argv) > 1 else os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))
    try:
        origins = derive_source_names(root)
    except Unmeasurable as exc:
        print(f'UNMEASURABLE: {exc}')
        print('  Not a pass. The guard produced no input, so it asserted nothing.')
        return EXIT_UNMEASURABLE

    names = sorted(origins)
    sanctioned = known_pairs(main_agent_id())
    pairs = find_pairs(names)
    bad = unsanctioned(pairs, sanctioned)

    print(f'{len(names)} source-derived session names, '
          f'{len(pairs)} strict-prefix pair(s), '
          f'{len(pairs) - len(bad)} sanctioned, {len(bad)} unsanctioned')

    for pair in pairs:
        if pair in sanctioned:
            print(f'  sanctioned: "{pair[0]}" -> "{pair[1]}"')

    risky = glob_risky(names)
    if risky:
        # Not fatal on its own: tmux resolution is exact -> prefix -> fnmatch,
        # so a glob character is a third way to hit the wrong target. Surfaced
        # rather than asserted, because we have never had such a name.
        print(f'  NOTE: glob characters in session name(s): {risky}')

    if not bad:
        return EXIT_OK

    print()
    print(f'VIOLATION: {len(bad)} unsanctioned prefix pair(s).')
    for shorter, longer in bad:
        print(f'  "{shorter}" is a prefix of "{longer}"')
        print(f'      shorter from: {origins.get(shorter, "?")}')
        print(f'      longer  from: {origins.get(longer, "?")}')
        print(f'      -> any unanchored `tmux -t {shorter}` retargets '
              f'{longer} once {shorter} is absent.')
    print()
    print('Fix, in preference order:')
    print('  1. Rename so neither name is a prefix of the other. Cheapest: it')
    print('     removes the possibility instead of guarding the symptom.')
    print('  2. If the pair is intentional and the name must stay descriptive,')
    print('     add it to known_pairs() in scripts/session_prefix_guard.py WITH')
    print('     a reason and an owner, and anchor every call site: `-t "=name"`.')
    print('     Verify the anchor on the SPECIFIC command -- `=` is correct for')
    print('     kill-session/has-session and destructive for display-message,')
    print('     which is a pane target and silently resolves nothing.')
    return EXIT_VIOLATION


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
