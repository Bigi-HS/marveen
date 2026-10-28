#!/usr/bin/env python3
"""End-to-end tests for the halt Boss-ping marker (throttle.py) + consumer (notify-halt.py).

These are CLI/integration tests (the marker is an I/O side-effect, not pure core),
run against a throwaway AUTOPILOT_STORE_DIR so they never touch the real store/.
They assert the SAFETY contract the live canary-flip depends on:

  - a crash-loop halt PRODUCES a durable marker (so the halt cannot be silently lost);
  - a healthy trickle produces NO marker (no false Boss-ping);
  - the consumer pings ONCE per episode (ack is idempotent, survives re-halt);
  - reset (Boss-GO recovery) clears the marker so a later halt is a fresh episode;
  - ack-after-send order: `pending`/`message` are read-only, only `ack` mutates.

Run: python3 scripts/autopilot/test_notify_halt.py
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
THROTTLE = os.path.join(HERE, "throttle.py")
NOTIFY = os.path.join(HERE, "notify-halt.py")
PY = sys.executable or "python3"


def _env(store):
    e = dict(os.environ)
    e["AUTOPILOT_STORE_DIR"] = store
    return e


def _run(script, args, store):
    return subprocess.run([PY, script, *args], capture_output=True, text=True, env=_env(store))


def _burst(store, agent, n=5, t0=1_000_000):
    """Fire n restarts inside the default 600s window -> trips halt at the n-th."""
    last = None
    for i in range(n):
        last = _run(THROTTLE, ["record-restart", "--agent", agent, "--now", str(t0 + i * 60)], store)
    return last


def _marker(store, agent):
    p = os.path.join(store, f"autopilot-halt-{agent}.json")
    if not os.path.exists(p):
        return None
    with open(p) as fh:
        return json.load(fh)


def test_halt_writes_durable_marker():
    with tempfile.TemporaryDirectory() as store:
        _burst(store, "buster")
        m = _marker(store, "buster")
        assert m is not None, "halt must produce a marker"
        assert m["agent"] == "buster"
        assert m["notified"] is False
        assert "restarts" in (m.get("halt_reason") or "")
        assert m.get("restart_count_in_window", 0) >= 5


def test_healthy_trickle_no_marker():
    with tempfile.TemporaryDirectory() as store:
        for i in range(6):  # 700s apart -> window prunes, never trips
            _run(THROTTLE, ["record-restart", "--agent", "dave", "--now", str(2_000_000 + i * 700)], store)
        assert _marker(store, "dave") is None, "a healthy trickle must NOT create a Boss-ping marker"


def test_reset_clears_marker():
    with tempfile.TemporaryDirectory() as store:
        _burst(store, "buster")
        assert _marker(store, "buster") is not None
        _run(THROTTLE, ["reset", "--agent", "buster"], store)
        assert _marker(store, "buster") is None, "reset (Boss-GO) must clear the marker"


def test_check_backfills_lost_marker():
    with tempfile.TemporaryDirectory() as store:
        _burst(store, "buster")
        os.unlink(os.path.join(store, "autopilot-halt-buster.json"))  # simulate lost marker
        r = _run(THROTTLE, ["check", "--agent", "buster"], store)
        assert r.returncode == 1, "halted agent must fail check (STOP enforced)"
        assert _marker(store, "buster") is not None, "check must defensively re-create the marker"


def test_consumer_pending_and_message():
    with tempfile.TemporaryDirectory() as store:
        _burst(store, "buster")
        pend = json.loads(_run(NOTIFY, ["pending"], store).stdout)
        assert len(pend) == 1 and pend[0]["agent"] == "buster"
        msg = _run(NOTIFY, ["message"], store).stdout
        assert "buster" in msg and "STOP" in msg and "reset" in msg
        cnt = _run(NOTIFY, ["count"], store)
        assert cnt.stdout.strip() == "1" and cnt.returncode == 1, "count exits 1 when a ping is pending"


def test_consumer_ack_pings_once():
    with tempfile.TemporaryDirectory() as store:
        _burst(store, "buster")
        _run(NOTIFY, ["ack", "--all"], store)
        pend = json.loads(_run(NOTIFY, ["pending"], store).stdout)
        assert pend == [], "after ack the halt must not ping again (once per episode)"
        assert _run(NOTIFY, ["message"], store).stdout.strip() == ""
        assert _marker(store, "buster")["notified"] is True
        cnt = _run(NOTIFY, ["count"], store)
        assert cnt.stdout.strip() == "0" and cnt.returncode == 0


def test_ack_survives_rehalt_no_reclobber():
    """After ack, a further record-restart on the still-halted agent must NOT reset
    notified->false (else the same halt episode would re-ping forever)."""
    with tempfile.TemporaryDirectory() as store:
        _burst(store, "buster")
        _run(NOTIFY, ["ack", "--all"], store)
        _run(THROTTLE, ["record-restart", "--agent", "buster", "--now", str(1_000_500)], store)
        assert _marker(store, "buster")["notified"] is True, "re-halt must not clobber notified"
        assert json.loads(_run(NOTIFY, ["pending"], store).stdout) == []


def test_reset_then_rehalt_is_fresh_episode():
    """After reset+recovery, a NEW crash-loop is a fresh episode and pings again."""
    with tempfile.TemporaryDirectory() as store:
        _burst(store, "buster")
        _run(NOTIFY, ["ack", "--all"], store)
        _run(THROTTLE, ["reset", "--agent", "buster"], store)
        _burst(store, "buster", t0=9_000_000)
        pend = json.loads(_run(NOTIFY, ["pending"], store).stdout)
        assert len(pend) == 1, "a post-reset halt must be a new, pingable episode"
        assert _marker(store, "buster")["notified"] is False


# --- standalone runner (mirrors the throttle.py/tick.py convention) ---------

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
            except Exception as e:  # noqa: BLE001
                ok = False
                print(f"ERROR {name}: {e!r}")
    print("\n" + ("ALL PASS" if ok else "SOME FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(_main())
