#!/usr/bin/env python3
"""Acceptance tests for scripts/windows-bridge.sh (Big Ben content-pipeline bridges).

Generalizes the proven Meld bridge (netsh portproxy from the WSL gateway IP -> Windows
127.0.0.1) into a reusable WSL<->Windows bridge tool. The script NEVER activates a
portproxy live -- adding it needs Admin on the Windows host (Dominik / deploy step). It
only: detects the WSL->Windows gateway IP, EMITS the exact Admin-PowerShell to set up a
port's portproxy + firewall rule, and VERIFIES reachability with graceful degradation
when the app-side server is not enabled yet.

Contract:
  gateway        -> print the detected WSL->Windows gateway IP (WIN_BRIDGE_GATEWAY override)
  plan <port>    -> print the netsh portproxy add + New-NetFirewallRule lines for <port>;
                    MUST NOT execute netsh (no live activation).
  verify <port>  -> probe http://<gw>:<port>; reachable -> "OK" exit 0; connection
                    refused / reset / empty-reply (app not enabled yet) -> graceful
                    "waiting: <app> not enabled yet" exit 0; timeout/other -> non-zero.

Design: curl and netsh.exe are PATH stubs whose exit code is set via env ($CURL_EXIT),
and that append a tagged line to a CALLS log so we can assert netsh is never invoked by
`plan`. Hermetic -- never touches the real Windows host.

Run: python3 scripts/__tests__/windows-bridge.test.py
"""
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(REPO, "scripts", "windows-bridge.sh")

GW = "192.168.128.1"


def _write(path, content, executable=False):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    if executable:
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP)


def _stubs(d, curl_exit=0):
    calls = os.path.join(d, "calls.log")
    _write(os.path.join(d, "curl"), f"""#!/usr/bin/env bash
echo "CURL $*" >> "{calls}"
# emit a minimal body so a "reachable" run has something on stdout
[ "{curl_exit}" = "0" ] && echo "HTTP/1.1 200 OK"
exit {curl_exit}
""", executable=True)
    # netsh.exe stub: if ever called, record it (plan must NOT call it).
    _write(os.path.join(d, "netsh.exe"), f"""#!/usr/bin/env bash
echo "NETSH $*" >> "{calls}"
exit 0
""", executable=True)
    return calls


def _run(d, *args, curl_exit=0, env_extra=None):
    env = dict(os.environ)
    env["PATH"] = d + ":" + env.get("PATH", "")
    env["WIN_BRIDGE_GATEWAY"] = GW
    env["CURL_EXIT"] = str(curl_exit)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        ["bash", SCRIPT, *args], capture_output=True, text=True, env=env, timeout=60
    )


def _calls(path):
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as f:
        return f.read()


class GatewayTests(unittest.TestCase):
    def test_gateway_prints_detected_ip(self):
        with tempfile.TemporaryDirectory() as d:
            _stubs(d)
            r = _run(d, "gateway")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(GW, r.stdout)


class PlanTests(unittest.TestCase):
    def test_plan_emits_portproxy_and_firewall_for_port(self):
        with tempfile.TemporaryDirectory() as d:
            _stubs(d)
            r = _run(d, "plan", "8080", "--app", "REAPER")
            self.assertEqual(r.returncode, 0, r.stderr)
            out = r.stdout
            self.assertIn("portproxy", out)
            self.assertIn("listenport=8080", out)
            self.assertIn("connectport=8080", out)
            self.assertIn(GW, out, "must pin the listenaddress to the gateway IP")
            self.assertIn("New-NetFirewallRule", out)
            self.assertRegex(out, r"(?i)admin", "must tell the operator to run it as Admin")

    def test_plan_does_not_execute_netsh(self):
        with tempfile.TemporaryDirectory() as d:
            calls = _stubs(d)
            _run(d, "plan", "8080")
            self.assertNotIn("NETSH", _calls(calls),
                             "plan must only EMIT commands, never run netsh live")


class VerifyTests(unittest.TestCase):
    def test_verify_reachable(self):
        with tempfile.TemporaryDirectory() as d:
            _stubs(d, curl_exit=0)
            r = _run(d, "verify", "8080", "--app", "REAPER", curl_exit=0)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertRegex(r.stdout, r"(?i)ok|reachable")

    def test_verify_refused_is_graceful_waiting(self):
        with tempfile.TemporaryDirectory() as d:
            _stubs(d, curl_exit=7)  # 7 = connection refused
            r = _run(d, "verify", "8080", "--app", "REAPER", curl_exit=7)
            self.assertEqual(r.returncode, 0, "app-not-enabled must NOT be an error")
            self.assertRegex(r.stdout, r"(?i)waiting")
            self.assertRegex(r.stdout, r"(?i)reaper")

    def test_verify_empty_reply_is_graceful_waiting(self):
        with tempfile.TemporaryDirectory() as d:
            _stubs(d, curl_exit=52)  # 52 = empty reply (portproxy up, app refused)
            r = _run(d, "verify", "8080", "--app", "REAPER", curl_exit=52)
            self.assertEqual(r.returncode, 0)
            self.assertRegex(r.stdout, r"(?i)waiting")

    def test_verify_timeout_is_error(self):
        with tempfile.TemporaryDirectory() as d:
            _stubs(d, curl_exit=28)  # 28 = timeout (host/portproxy unreachable)
            r = _run(d, "verify", "8080", curl_exit=28)
            self.assertNotEqual(r.returncode, 0, "a real unreachable host must be non-zero")
            self.assertRegex(r.stdout + r.stderr, r"(?i)unreachable|timeout")


class UsageTests(unittest.TestCase):
    def test_no_command_shows_usage_nonzero(self):
        with tempfile.TemporaryDirectory() as d:
            _stubs(d)
            r = _run(d)
            self.assertNotEqual(r.returncode, 0)
            self.assertRegex(r.stdout + r.stderr, r"(?i)usage")


if __name__ == "__main__":
    if not os.path.exists(SCRIPT):
        print(f"EXPECTED-FAIL (TDD red): {SCRIPT} not found")
        sys.exit(1)
    unittest.main(verbosity=2)
