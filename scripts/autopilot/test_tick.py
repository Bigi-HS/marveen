#!/usr/bin/env python3
"""Integration tests for the tick.py STUCK-GATE fail-direction (Thor PR#882 FLAG-1)
and the ACTIVATION GATE freeze-carve-out (step5 item1, spec section 2.2).

The dangerous direction for the STUCK-GATE is fail-OPEN: a subprocess failure to
read the persistent stuck-state must NOT read as "not stuck" (that let a stuck
agent keep burning). The dangerous direction for the ACTIVATION GATE is fail-ON:
any value other than the exact "1" must leave the wrapper INERT (no subprocess
call), so a wired-but-not-yet-canaried agent does not start driving. These tests
monkeypatch tick._run_json to drive each case. Run:
  python3 scripts/autopilot/test_tick.py
"""
import io
import os
import sys
from contextlib import redirect_stdout

import tick


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    return cond


def run_with(responses, enabled="1", canary=None):
    """Drive tick.main() with monkeypatched subprocess responses.

    responses: dict keyed by the subcommand word in argv -> dict to return.
    enabled:   value for AUTOPILOT_TICK_ENABLED (default "1" so the gate is ON and
               the STUCK/IDLE/BUSY path under test is reached). Returns a third
               element `called`: True iff _run_json was invoked at least once --
               the inert-gate tests assert this is False when the gate is OFF.
    canary:    None  -> no registry file (hermetic: AUTOPILOT_STORE_DIR -> empty
                        tmp dir, so the live store/autopilot-canary.json can never
                        make an env-based test flaky);
               dict  -> written as the registry so the canary-path tests drive the
                        durable per-agent enable source directly.
    """
    import json
    import tempfile
    called = {"v": False}

    def fake_run_json(argv, fallback):
        called["v"] = True
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
    prev_env = os.environ.get("AUTOPILOT_TICK_ENABLED")
    prev_store = os.environ.get("AUTOPILOT_STORE_DIR")
    tmpdir = tempfile.mkdtemp(prefix="tick-canary-")
    os.environ["AUTOPILOT_STORE_DIR"] = tmpdir          # hermetic: isolate registry
    if canary is not None:
        with open(os.path.join(tmpdir, "autopilot-canary.json"), "w", encoding="utf-8") as fh:
            json.dump(canary, fh)
    if enabled is None:
        os.environ.pop("AUTOPILOT_TICK_ENABLED", None)
    else:
        os.environ["AUTOPILOT_TICK_ENABLED"] = enabled
    buf = io.StringIO()
    try:
        sys.argv = ["tick.py", "dave", "sessX"]
        with redirect_stdout(buf):
            rc = tick.main()
    finally:
        tick._run_json = orig
        if prev_env is None:
            os.environ.pop("AUTOPILOT_TICK_ENABLED", None)
        else:
            os.environ["AUTOPILOT_TICK_ENABLED"] = prev_env
        if prev_store is None:
            os.environ.pop("AUTOPILOT_STORE_DIR", None)
        else:
            os.environ["AUTOPILOT_STORE_DIR"] = prev_store
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
    return rc, buf.getvalue(), called["v"]


def main():
    ok = True

    # A. FLAG-1 fix: unreadable stuck-state (genuine subprocess failure) -> fail CLOSED (EXIT 1).
    rc, out, _ = run_with({"stuck": {"_unreadable": True}})
    ok &= check("unreadable stuck-state -> EXIT 1 (fail-closed)", rc == 1 and "fail-CLOSED" in out)

    # B. Absent state file (valid empty dict) is NOT a failure -> proceed to idle-gate.
    rc, out, _ = run_with({"stuck": {}, "classify": {"idle_ok": True}})
    ok &= check("absent stuck-state + idle -> EXIT 0, not stuck", rc == 0 and "STUCK-GATE" not in out)

    # C. Genuinely stuck -> EXIT 1.
    rc, out, _ = run_with({"stuck": {"stuck": True, "stuck_reason": "3x"}})
    ok &= check("stuck=true -> EXIT 1", rc == 1 and "STUCK-GATE TRIPPED" in out)

    # D. Not stuck + busy classify -> EXIT 0 with actionable preamble.
    rc, out, _ = run_with({"stuck": {}, "classify": {
        "idle_ok": False, "counts": {"mine": 1, "nudgeable": 0, "parked": 0},
        "mine": [{"id": "abc", "priority": "high", "title": "t", "age_d": 1.0}], "nudgeable": []}})
    ok &= check("not stuck + busy -> EXIT 0 actionable", rc == 0 and "drive ONE card" in out)

    # --- ACTIVATION GATE (freeze-carve-out, step5 item1, spec section 2.2) ---
    # The responses below would drive a BUSY actionable preamble IF the gate let
    # the wrapper run -- proving the DISABLED cases are inert by content, not by
    # luck. `called` must be False (no classify/stuck subprocess attempted).
    busy = {"stuck": {}, "classify": {
        "idle_ok": False, "counts": {"mine": 1, "nudgeable": 0, "parked": 0},
        "mine": [{"id": "abc", "priority": "high", "title": "t", "age_d": 1.0}], "nudgeable": []}}

    def inert(out, called):
        # DISABLED line present, EXIT 0, no subprocess, and nothing actionable leaked.
        return ("DISABLED (AUTOPILOT_TICK_ENABLED!=1" in out
                and "not in canary registry" in out
                and not called
                and "drive ONE card" not in out
                and "MINE" not in out and "STUCK-GATE" not in out)

    # E. Gate OFF (env unset) -> inert DISABLED line, EXIT 0, no subprocess.
    rc, out, called = run_with(busy, enabled=None)
    ok &= check("gate unset -> DISABLED EXIT 0, inert (no subprocess)", rc == 0 and inert(out, called))

    # F. Gate "0" -> same inert behaviour.
    rc, out, called = run_with(busy, enabled="0")
    ok &= check('gate "0" -> DISABLED EXIT 0, inert', rc == 0 and inert(out, called))

    # G. FAIL-DIRECTION (dangerous side): a garbage value must NOT enable. Only the
    #    exact string "1" turns the wrapper on; "true" (a plausible mis-set) = OFF.
    rc, out, called = run_with(busy, enabled="true")
    ok &= check('garbage value "true" -> OFF (not enabled), inert', rc == 0 and inert(out, called))

    # H. Gate "1" -> normal path reached (busy actionable preamble, subprocess ran).
    rc, out, called = run_with(busy, enabled="1")
    ok &= check('gate "1" -> enabled, busy actionable preamble',
                rc == 0 and "drive ONE card" in out and called and "DISABLED" not in out)

    # --- DURABLE CANARY REGISTRY (the respawn-surviving enable source) ---
    # The gate must also open from store/autopilot-canary.json membership with the
    # env flag UNSET -- that is what survives a watchdog respawn/reboot.
    # I. env UNSET + registry lists the agent ("dave") under "tick" -> ENABLED.
    rc, out, called = run_with(busy, enabled=None, canary={"tick": ["dave"]})
    ok &= check("env unset + agent in canary registry -> enabled (normal path)",
                rc == 0 and "drive ONE card" in out and called and "DISABLED" not in out)

    # J. FAIL-DIRECTION (dangerous side): a registry that does NOT list the agent
    #    must stay inert even with env unset -- a wired-but-not-canaried agent.
    rc, out, called = run_with(busy, enabled=None, canary={"tick": ["someone-else"]})
    ok &= check("env unset + agent NOT in registry -> inert (not silently enabled)",
                rc == 0 and inert(out, called))

    # K. FAIL-DIRECTION: throttle-only membership must NOT enable the TICK gate
    #    (capability isolation -- the throttle canary is a different switch).
    rc, out, called = run_with(busy, enabled=None, canary={"throttle": ["dave"]})
    ok &= check("env unset + agent only under 'throttle' -> tick inert (capability isolation)",
                rc == 0 and inert(out, called))

    print("\n" + ("ALL PASS" if ok else "SOME FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.path.insert(0, ".")
    raise SystemExit(main())
