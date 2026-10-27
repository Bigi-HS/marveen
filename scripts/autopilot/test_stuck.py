#!/usr/bin/env python3
"""Offline unit tests for the autopilot STUCK-GATE + rotation state core.

Run: python3 scripts/autopilot/test_stuck.py
"""
import sys

from stuck import (normalize_hash, eval_action, eval_tick, check_rotation,
                   _apply_stuck)


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    return cond


def main():
    ok = True

    # 1. Normalized hash ignores arg VALUES, keeps the shape (F-7).
    h1 = normalize_hash("WebSearch", {"query": "cats"})
    h2 = normalize_hash("WebSearch", {"query": "dogs"})
    h3 = normalize_hash("WebSearch", {"url": "x"})
    ok &= check("same shape diff values -> same hash", h1 == h2)
    ok &= check("different arg keys -> different hash", h1 != h3)

    # 2. 3x-identical action -> stuck; 2x not yet.
    s = {}
    s = eval_action(s, h1, "sessA")
    ok &= check("1 action -> not stuck", not s["stuck_now"])
    s = eval_action(s, h1, "sessA")
    ok &= check("2 actions -> not stuck", not s["stuck_now"])
    s = eval_action(s, h1, "sessA")
    ok &= check("3x identical -> stuck", s["stuck_now"] is True)

    # 3. First stuck (one session) does NOT ping Boss; a 2nd distinct session does (F-6).
    ok &= check("single-session stuck -> no boss ping", s["ping_boss"] is False)
    s = _apply_stuck(s, True, "sessB", "x")
    ok &= check("second session stuck -> boss ping", s["ping_boss"] is True)

    # 4. A differing action breaks the 3x run.
    s2 = {}
    s2 = eval_action(s2, h1, "s")
    s2 = eval_action(s2, h3, "s")
    s2 = eval_action(s2, h1, "s")
    ok &= check("mixed actions -> not stuck", not s2["stuck_now"])

    # 5. N-tick no-card-movement slow divergence.
    s3 = {}
    for _ in range(9):
        s3 = eval_tick(s3, card_moved=False, session="s", n=10)
    ok &= check("9 idle ticks -> not stuck", not s3["stuck_now"])
    s3 = eval_tick(s3, card_moved=False, session="s", n=10)
    ok &= check("10th no-move tick -> stuck", s3["stuck_now"] is True)

    # 6. A real card move resets the slow-divergence counter.
    s4 = {}
    for _ in range(9):
        s4 = eval_tick(s4, card_moved=False, session="s", n=10)
    s4 = eval_tick(s4, card_moved=True, session="s", n=10)
    ok &= check("card move resets counter", s4["ticks_since_card_move"] == 0 and not s4["stuck_now"])

    # 7. Rotation: must_rotate only AFTER maxn ticks on the same card (SL-01).
    r = {}
    for i in range(5):
        r = check_rotation(r, "cardX", maxn=5)
    ok &= check("5 ticks same card -> not yet rotate", r["must_rotate"] is False)
    r = check_rotation(r, "cardX", maxn=5)
    ok &= check("6th tick same card -> must rotate", r["must_rotate"] is True)
    r = check_rotation(r, "cardY", maxn=5)
    ok &= check("switching card resets rotation", r["must_rotate"] is False and r["same_card_ticks"] == 1)

    print("\n" + ("ALL PASS" if ok else "SOME FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.path.insert(0, ".")
    raise SystemExit(main())
