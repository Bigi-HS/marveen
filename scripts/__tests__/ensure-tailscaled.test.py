#!/usr/bin/env python3
"""Acceptance tests for scripts/ensure-tailscaled.sh (card c2de413f).

The boot-hook keeps tailscaled up (userspace networking -- WSL has no systemd) and
the dashboard's tailnet-only serve config applied, so remote access survives a
reboot. Contract:

  0. Gated by store/tailscale-serve.enabled (path overridable) -- INERT until the
     operator/Genesis flips the flag (deploy switch, like ollama-hybrid.enabled).
  1. If the tailscale binary is absent -> graceful skip (never error the supervisor).
  2. Daemon up + authenticated  -> (re)apply serve config idempotently, NO daemon start.
  3. Daemon down                -> start tailscaled (userspace), then apply serve.
  4. Daemon up but NOT logged in -> do NOT serve, and NEVER run interactive `tailscale up`
     (the one-time login is the operator's; tailscaled reconnects from saved state).

Design: tailscale / tailscaled / sudo and the serve script are PATH/-env stubs that
append a tagged line to a CALLS log. Daemon liveness is simulated by a marker file
($TS_UP): `tailscale status` exits 0 iff the marker exists; the tailscaled stub
creates it (simulating the daemon coming up). Hermetic -- never touches the real
tailnet, real store/, or the real daemon.

Run: python3 scripts/__tests__/ensure-tailscaled.test.py
"""
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(REPO, "scripts", "ensure-tailscaled.sh")


def _write(path, content, executable=False):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    if executable:
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP)


def _make_stubs(d, backend_state="Running"):
    """Create tailscale / tailscaled / sudo / serve stubs in dir d.

    Returns (calls_path, up_marker_path, flag_path, serve_path, log_path).
    """
    calls = os.path.join(d, "calls.log")
    up_marker = os.path.join(d, "ts_up")
    flag = os.path.join(d, "flag")
    serve = os.path.join(d, "serve-stub.sh")
    log = os.path.join(d, "tailscaled.log")

    # tailscale: `status` exits 0 iff the up-marker exists; `status --json` prints a
    # BackendState; `up` (interactive login) must never be invoked -- we record it.
    _write(os.path.join(d, "tailscale"), f"""#!/usr/bin/env bash
echo "TS $*" >> "{calls}"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  [ -f "{up_marker}" ] || exit 1
  printf '{{"BackendState":"%s"}}\\n' "{backend_state}"
  exit 0
fi
if [ "$1" = "status" ]; then
  [ -f "{up_marker}" ] && exit 0 || exit 1
fi
exit 0
""", executable=True)

    # tailscaled: starting the daemon -> create the up-marker (daemon now responsive).
    _write(os.path.join(d, "tailscaled"), f"""#!/usr/bin/env bash
echo "TSD $*" >> "{calls}"
touch "{up_marker}"
exit 0
""", executable=True)

    # sudo: drop the privilege wrapper, exec the rest (record it).
    _write(os.path.join(d, "sudo"), f"""#!/usr/bin/env bash
echo "SUDO $*" >> "{calls}"
exec "$@"
""", executable=True)

    # serve script stub: record the subcommand (we assert on `up`).
    _write(serve, f"""#!/usr/bin/env bash
echo "SERVE $*" >> "{calls}"
exit 0
""", executable=True)

    return calls, up_marker, flag, serve, log


def _run(d, flag, serve, log, extra_env=None):
    env = dict(os.environ)
    env["PATH"] = d + ":" + env.get("PATH", "")
    env["ENSURE_TS_FLAG"] = flag
    env["ENSURE_TS_SERVE_SCRIPT"] = serve
    env["ENSURE_TS_LOG"] = log
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["bash", SCRIPT], capture_output=True, text=True, env=env, timeout=60
    )


def _calls(calls_path):
    if not os.path.exists(calls_path):
        return ""
    with open(calls_path, encoding="utf-8") as f:
        return f.read()


class FlagGateTests(unittest.TestCase):
    def test_flag_absent_is_inert(self):
        """No flag -> exit 0 and zero side effects (no daemon, no serve)."""
        with tempfile.TemporaryDirectory() as d:
            calls, _up, flag, serve, log = _make_stubs(d)
            # flag deliberately NOT created
            r = _run(d, flag, serve, log)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(_calls(calls), "", "must not touch tailscale/serve when disabled")


class BinaryMissingTests(unittest.TestCase):
    def test_missing_tailscale_skips(self):
        with tempfile.TemporaryDirectory() as d:
            calls, _up, flag, serve, log = _make_stubs(d)
            _write(flag, "")
            r = _run(d, flag, serve, log, extra_env={"TAILSCALE_BIN": "tailscale-nonexistent-xyz"})
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn("SERVE up", _calls(calls))


class DaemonUpTests(unittest.TestCase):
    def test_up_and_authenticated_applies_serve_without_starting(self):
        with tempfile.TemporaryDirectory() as d:
            calls, up, flag, serve, log = _make_stubs(d, backend_state="Running")
            _write(flag, "")
            _write(up, "")  # daemon already up
            r = _run(d, flag, serve, log)
            self.assertEqual(r.returncode, 0, r.stderr)
            c = _calls(calls)
            self.assertIn("SERVE up", c, "must (re)apply serve when up+authenticated")
            self.assertNotIn("TSD", c, "must NOT start tailscaled when already up")

    def test_up_but_logged_out_does_not_serve_or_login(self):
        with tempfile.TemporaryDirectory() as d:
            calls, up, flag, serve, log = _make_stubs(d, backend_state="NeedsLogin")
            _write(flag, "")
            _write(up, "")  # daemon up...
            r = _run(d, flag, serve, log)
            self.assertEqual(r.returncode, 0, r.stderr)
            c = _calls(calls)
            self.assertNotIn("SERVE up", c, "must NOT serve when not authenticated")
            self.assertNotIn("TS up", c, "must NEVER run interactive `tailscale up`")


class DaemonDownTests(unittest.TestCase):
    def test_down_starts_daemon_then_serves(self):
        with tempfile.TemporaryDirectory() as d:
            calls, _up, flag, serve, log = _make_stubs(d, backend_state="Running")
            _write(flag, "")
            # up-marker absent -> daemon down; the tailscaled stub creates it on start.
            r = _run(d, flag, serve, log)
            self.assertEqual(r.returncode, 0, r.stderr)
            c = _calls(calls)
            self.assertIn("TSD", c, "must start tailscaled when down")
            self.assertIn("SERVE up", c, "must apply serve after the daemon comes up")


if __name__ == "__main__":
    if not os.path.exists(SCRIPT):
        print(f"EXPECTED-FAIL (TDD red): {SCRIPT} not found")
        sys.exit(1)
    unittest.main(verbosity=2)
