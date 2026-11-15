#!/usr/bin/env python3
"""Unit tests for tick_reason() in heartbeat-preflight.py (card 13f45c58).

Sourceable / importable: exercises the pure helper over fixtures for AC1-AC4
WITHOUT running the live heartbeat (no API, no subprocess to tick.py).

Usage:
  python3 scripts/__tests__/heartbeat-preflight-tickdrive.test.py
Exit code: 0 = all PASS, non-zero = at least one FAIL.
"""
import importlib.util
import os
import sys

# Load heartbeat-preflight.py by file path (module name has a dash, not importable normally).
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
_MOD_PATH = os.path.join(_ROOT, "scripts", "heartbeat-preflight.py")

_spec = importlib.util.spec_from_file_location("heartbeat_preflight", _MOD_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

tick_reason = _mod.tick_reason


def _run_cases():
    failures = []

    def check(label, got, expected):
        if got != expected:
            failures.append(f"FAIL [{label}]: got={got!r}, expected={expected!r}")
        else:
            print(f"PASS [{label}]")

    # AC1: idle=false with mine>0 nudgeable=0 and nudge_hi=0 -> [] (no TICK_DRIVE)
    check(
        "AC1 mine-only backlog, nudgeable=0, nudge_hi=0",
        tick_reason(
            "=== AUTOPILOT TICK [marveen] :: idle=false -- drive ONE card forward now ===\n"
            "counts: mine=65 nudgeable=0 parked=94",
            nudge_hi=0,
        ),
        [],
    )

    # AC2a: idle=false with nudgeable>0 -> ["TICK_DRIVE"]
    check(
        "AC2a nudgeable>0, nudge_hi=0",
        tick_reason(
            "=== AUTOPILOT TICK [marveen] :: idle=false -- drive ONE card forward now ===\n"
            "counts: mine=65 nudgeable=3 parked=94",
            nudge_hi=0,
        ),
        ["TICK_DRIVE"],
    )

    # AC2b: idle=false with nudgeable=0 but nudge_hi>0 -> ["TICK_DRIVE"]
    check(
        "AC2b nudgeable=0, nudge_hi=2",
        tick_reason(
            "=== AUTOPILOT TICK [marveen] :: idle=false -- drive ONE card forward now ===\n"
            "counts: mine=65 nudgeable=0 parked=94",
            nudge_hi=2,
        ),
        ["TICK_DRIVE"],
    )

    # AC3: STUCK-GATE TRIPPED present -> ["TICK_STUCK"] regardless of nudge_hi
    check(
        "AC3 STUCK-GATE TRIPPED",
        tick_reason(
            "=== AUTOPILOT TICK [marveen] :: STUCK-GATE TRIPPED (EXIT 1) ===",
            nudge_hi=0,
        ),
        ["TICK_STUCK"],
    )

    # AC4: idle=false but no parseable counts line -> ["TICK_DRIVE"] (fail-safe)
    check(
        "AC4 missing counts line (parse failure -> fail toward ACT)",
        tick_reason(
            "idle=false -- drive ONE card forward now\n(no counts line)",
            nudge_hi=0,
        ),
        ["TICK_DRIVE"],
    )

    # idle=true -> []
    check(
        "idle=true -> QUIET",
        tick_reason(
            "=== AUTOPILOT TICK [marveen] :: idle=true (EXIT 0) ===",
            nudge_hi=0,
        ),
        [],
    )

    # nudgeable>0 AND nudge_hi>0 -> ["TICK_DRIVE"] (both sources drivable)
    check(
        "nudgeable>0 and nudge_hi>0",
        tick_reason(
            "=== AUTOPILOT TICK [marveen] :: idle=false -- drive ONE card forward now ===\n"
            "counts: mine=10 nudgeable=5 parked=20",
            nudge_hi=3,
        ),
        ["TICK_DRIVE"],
    )

    # STUCK-GATE with nudge_hi>0 -> still TICK_STUCK (not TICK_DRIVE)
    check(
        "STUCK-GATE with nudge_hi>0 -> TICK_STUCK only",
        tick_reason(
            "=== STUCK-GATE TRIPPED (EXIT 1) ===",
            nudge_hi=5,
        ),
        ["TICK_STUCK"],
    )

    # mine=0 nudgeable=0 nudge_hi=0 (empty board) -> []
    check(
        "empty board mine=0 nudgeable=0 nudge_hi=0",
        tick_reason(
            "=== AUTOPILOT TICK [marveen] :: idle=false -- drive ONE card forward now ===\n"
            "counts: mine=0 nudgeable=0 parked=0",
            nudge_hi=0,
        ),
        [],
    )

    return failures


if __name__ == "__main__":
    failures = _run_cases()
    if failures:
        print()
        for f in failures:
            print(f)
        print(f"\n{len(failures)} test(s) FAILED")
        sys.exit(1)
    else:
        print("\nAll tests PASSED")
        sys.exit(0)
