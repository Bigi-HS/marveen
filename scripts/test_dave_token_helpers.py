#!/usr/bin/env python3
"""Tests for the token() precedence in dave's rotation-robust helpers
(gate-approve-helper.py + ia-send-dave.py).

Both helpers resolve their bearer token in this order:
    GENESIS_TOKEN_FILE (path, first line only) -> GENESIS_AGENT_TOKEN env
    -> shared dashboard token file.

The GENESIS_TOKEN_FILE path takes precedence so a genuine per-agent seat/send
survives a mid-session token rotation without a relaunch: the running process
keeps the OLD env token (401s), but the on-disk agents/<id>/.genesis-token is
fresh. That file is two lines ("<token>\\n<expiry_epoch>"), so token() must read
the FIRST line only (a naive .read().strip() would smuggle the expiry into the
Authorization header -> ValueError: Invalid header value).

No network: token() is a pure function of the environment and files.
"""
import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(module_name, filename):
    spec = importlib.util.spec_from_file_location(module_name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gate = _load("gate_approve_helper", "gate-approve-helper.py")
iasend = _load("ia_send_dave", "ia-send-dave.py")

MODULES = [("gate-approve-helper", gate), ("ia-send-dave", iasend)]


class _Env:
    """Context manager: set exactly the given env vars, restore on exit."""

    def __init__(self, **kv):
        self.kv = kv
        self.saved = {}

    def __enter__(self):
        for k in ("GENESIS_TOKEN_FILE", "GENESIS_AGENT_TOKEN"):
            self.saved[k] = os.environ.get(k)
            os.environ.pop(k, None)
        for k, v in self.kv.items():
            if v is not None:
                os.environ[k] = v
        return self

    def __exit__(self, *a):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _two_line_token_file(token_value):
    fd, path = tempfile.mkstemp(prefix="genesis-token-")
    with os.fdopen(fd, "w") as f:
        f.write(token_value + "\n1794610894\n")  # token + expiry epoch line
    return path


def test_token_file_takes_precedence_and_reads_first_line_only():
    path = _two_line_token_file("FRESH_FILE_TOKEN")
    try:
        for name, mod in MODULES:
            with _Env(GENESIS_TOKEN_FILE=path, GENESIS_AGENT_TOKEN="STALE_ENV_TOKEN"):
                got = mod.token()
            assert got == "FRESH_FILE_TOKEN", f"{name}: expected first-line file token, got {got!r}"
            assert "1794610894" not in got, f"{name}: expiry line leaked into token: {got!r}"
    finally:
        os.remove(path)


def test_env_token_used_when_no_file():
    for name, mod in MODULES:
        with _Env(GENESIS_AGENT_TOKEN="  ENV_ONLY_TOKEN  "):
            got = mod.token()
        assert got == "ENV_ONLY_TOKEN", f"{name}: expected stripped env token, got {got!r}"


def test_file_wins_even_when_env_present():
    path = _two_line_token_file("FILE_WINS")
    try:
        for name, mod in MODULES:
            with _Env(GENESIS_TOKEN_FILE=path, GENESIS_AGENT_TOKEN="ENV_LOSES"):
                got = mod.token()
            assert got == "FILE_WINS", f"{name}: file must beat env, got {got!r}"
    finally:
        os.remove(path)


def test_single_line_token_file_also_works():
    fd, path = tempfile.mkstemp(prefix="genesis-token-1l-")
    with os.fdopen(fd, "w") as f:
        f.write("ONLY_TOKEN_NO_EXPIRY\n")
    try:
        for name, mod in MODULES:
            with _Env(GENESIS_TOKEN_FILE=path):
                got = mod.token()
            assert got == "ONLY_TOKEN_NO_EXPIRY", f"{name}: got {got!r}"
    finally:
        os.remove(path)


def run_all_tests(verbose=False):
    tests = [
        test_token_file_takes_precedence_and_reads_first_line_only,
        test_env_token_used_when_no_file,
        test_file_wins_even_when_env_present,
        test_single_line_token_file_also_works,
    ]
    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            if verbose:
                print(f"✓ {test.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"✗ {test.__name__} FAIL: {e}")
            failed += 1
        except Exception as e:
            print(f"✗ {test.__name__} ERROR: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    return failed == 0


if __name__ == "__main__":
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    success = run_all_tests(verbose=verbose)
    sys.exit(0 if success else 1)
