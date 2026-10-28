#!/usr/bin/env python3
"""Offline unit tests for the autopilot supervisor RESTART-THROTTLE core.

Covers the falsification required by spec section 2.1: a crash-loop (>= max within
the window) MUST halt (the dangerous direction), while a healthy slow-restart
trickle (spaced beyond the window) must NOT be falsely halted.

Run: python3 -m pytest scripts/autopilot/test_throttle.py   (or: python3 test_throttle.py)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from throttle import eval_restart  # noqa: E402


def test_crash_loop_within_window_halts():
    """5 restarts inside the 600s window -> HALTED (the pathological case is caught)."""
    state = {}
    t = 1_000_000
    for i in range(4):
        state = eval_restart(state, now=t + i * 60, window=600, max_restarts=5)
        assert not state["halted"], f"restart {i+1} must not halt yet"
    state = eval_restart(state, now=t + 4 * 60, window=600, max_restarts=5)
    assert state["halted"] is True
    assert state["just_tripped"] is True
    assert state["ping_boss"] is True
    assert "5 restarts" in state["halt_reason"]


def test_healthy_trickle_never_halts():
    """FALSIFICATION of over-throttling: restarts spaced > window apart never trip.

    If this failed, a legitimately long-running agent that restarts occasionally
    (context saturation / token reset) would be falsely stopped.
    """
    state = {}
    t = 2_000_000
    for i in range(20):  # 20 restarts, each 700s apart (> 600s window)
        state = eval_restart(state, now=t + i * 700, window=600, max_restarts=5)
        assert not state["halted"], f"trickle restart {i+1} falsely halted"
        assert state["restart_count_in_window"] == 1


def test_window_pruning_boundary():
    """Exactly-at-window entries are pruned; 5 spread over just-under-window still trip."""
    state = {}
    t = 3_000_000
    # 5 restarts within 500s (<600s window) -> trip.
    for i in range(5):
        state = eval_restart(state, now=t + i * 100, window=600, max_restarts=5)
    assert state["halted"] is True


def test_halt_is_sticky_after_window_passes():
    """Once halted, pruning old timestamps does NOT un-halt (fail-CLOSED, sticky)."""
    state = {}
    t = 4_000_000
    for i in range(5):
        state = eval_restart(state, now=t + i * 60, window=600, max_restarts=5)
    assert state["halted"] is True
    # A much later restart prunes all prior timestamps (count drops) but stays halted.
    state = eval_restart(state, now=t + 100_000, window=600, max_restarts=5)
    assert state["restart_count_in_window"] == 1
    assert state["halted"] is True, "halt must survive window pruning (sticky)"
    assert state["just_tripped"] is False


def test_halted_at_set_once():
    state = {}
    t = 5_000_000
    for i in range(5):
        state = eval_restart(state, now=t + i * 60, window=600, max_restarts=5)
    first_halt = state["halted_at"]
    state = eval_restart(state, now=t + 400, window=600, max_restarts=5)
    assert state["halted_at"] == first_halt, "halted_at must not move on re-halt"


# --- standalone runner (mirrors the stuck.py/tick.py test convention) -------

def _main():
    ok = True
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                ok = False
                print(f"FAIL {name}: {e}")
    print("\n" + ("ALL PASS" if ok else "SOME FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(_main())
