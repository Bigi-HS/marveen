#!/usr/bin/env python3
"""RUNTIME detector: no unsanctioned prefix collision among LIVE tmux sessions.

Companion to scripts/session-name-prefix-lint.py, deliberately a separate tool
with a different input. This one catches sessions created outside the
repository (an operator's ad-hoc `tmux new-session -s marveen-worker`), which
the source-derived lint cannot see. It belongs in the heartbeat, NOT in a
merge gate: its verdict depends on what happens to be running right now, so a
gate consuming it would be green in CI for a reason unrelated to the change.

Exit: 0 measured+clean, 1 violation, 2 could not measure.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from session_prefix_guard import (  # noqa: E402
    EXIT_OK, EXIT_UNMEASURABLE, EXIT_VIOLATION, Unmeasurable, find_pairs,
    glob_risky, known_pairs, main_agent_id, read_live_names, unsanctioned,
)


def main() -> int:
    try:
        names = read_live_names()
    except Unmeasurable as exc:
        # The original version returned 0 here: tmux failure -> empty stdout ->
        # no names -> no pairs -> "clean". The signal was even printed ("0 live
        # sessions") but the exit code did not carry it, so it collapsed into
        # the pass. Reproduced with a stub tmux on 2026-08-04.
        print(f'UNMEASURABLE: {exc}')
        print('  Not a pass. On a live fleet the session count is never zero,')
        print('  so an empty result means the measurement failed, not that the')
        print('  invariant holds.')
        return EXIT_UNMEASURABLE

    sanctioned = known_pairs(main_agent_id())
    pairs = find_pairs(names)
    bad = unsanctioned(pairs, sanctioned)

    print(f'{len(names)} live sessions, {len(pairs)} strict-prefix pair(s), '
          f'{len(pairs) - len(bad)} sanctioned, {len(bad)} unsanctioned')
    for pair in pairs:
        if pair in sanctioned:
            print(f'  sanctioned: "{pair[0]}" -> "{pair[1]}"')

    risky = glob_risky(names)
    if risky:
        print(f'  NOTE: glob characters in live session name(s): {risky}')

    if not bad:
        return EXIT_OK

    print()
    print(f'VIOLATION: {len(bad)} unsanctioned prefix pair(s) among LIVE sessions.')
    for shorter, longer in bad:
        print(f'  "{shorter}" is a prefix of "{longer}"  ->  '
              f'`-t {shorter}` can hit {longer}')
    print()
    print('This is live state, so the fix is operational: rename or stop the')
    print('colliding session. If the name is here to stay, it also needs a')
    print('known_pairs() entry and anchored call sites -- and it should have')
    print('been caught by scripts/session-name-prefix-lint.py first; if it was')
    print('not, that lint has a blind spot worth reporting.')
    return EXIT_VIOLATION


if __name__ == '__main__':
    raise SystemExit(main())
