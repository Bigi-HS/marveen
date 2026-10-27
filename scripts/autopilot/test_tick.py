#!/usr/bin/env python3
"""Integration tests for the tick.py STUCK-GATE fail-direction (Thor PR#882 FLAG-1).

The dangerous direction is fail-OPEN: a subprocess failure to read the persistent
stuck-state must NOT read as "not stuck" (that let a stuck agent keep burning).
These tests monkeypatch tick._run_json to drive each case. Run:
  python3 scripts/autopilot/test_tick.py
"""
import io
import sys
from contextlib import redirect_stdout

import tick


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    return cond


def run_with(responses):
    """responses: dict keyed by the subcommand word in argv -> dict to return."""
    def fake_run_json(argv, fallback):
        joined = " ".join(argv)
        if "stuck.py" in joined and "status" in joined:
            return responses.get("stuck", fallback)
        if "classify.py" in joined:
            return responses.get("classify", fallback)
        if "stuck.py" in joined and "rotation" in joined:
            return responses.get("rotation", {})
        return fallback

    orig = tick._run_json
    tick._run_json = fake_run_json
    buf = io.StringIO()
    try:
        sys.argv = ["tick.py", "dave", "sessX"]
        with redirect_stdout(buf):
            rc = tick.main()
    finally:
        tick._run_json = orig
    return rc, buf.getvalue()


def main():
    ok = True

    # A. FLAG-1 fix: unreadable stuck-state (genuine subprocess failure) -> fail CLOSED (EXIT 1).
    rc, out = run_with({"stuck": {"_unreadable": True}})
    ok &= check("unreadable stuck-state -> EXIT 1 (fail-closed)", rc == 1 and "fail-CLOSED" in out)

    # B. Absent state file (valid empty dict) is NOT a failure -> proceed to idle-gate.
    rc, out = run_with({"stuck": {}, "classify": {"idle_ok": True}})
    ok &= check("absent stuck-state + idle -> EXIT 0, not stuck", rc == 0 and "STUCK-GATE" not in out)

    # C. Genuinely stuck -> EXIT 1.
    rc, out = run_with({"stuck": {"stuck": True, "stuck_reason": "3x"}})
    ok &= check("stuck=true -> EXIT 1", rc == 1 and "STUCK-GATE TRIPPED" in out)

    # D. Not stuck + busy classify -> EXIT 0 with actionable preamble.
    rc, out = run_with({"stuck": {}, "classify": {
        "idle_ok": False, "counts": {"mine": 1, "nudgeable": 0, "parked": 0},
        "mine": [{"id": "abc", "priority": "high", "title": "t", "age_d": 1.0}], "nudgeable": []}})
    ok &= check("not stuck + busy -> EXIT 0 actionable", rc == 0 and "drive ONE card" in out)

    print("\n" + ("ALL PASS" if ok else "SOME FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.path.insert(0, ".")
    raise SystemExit(main())
