#!/usr/bin/env python3
"""Adversarial fixtures for the autopilot per-agent canary registry (canary.py).

The dangerous direction for a canary registry is fail-ON: a malformed / unreadable /
wrong-shaped registry must NEVER cause is_enabled() to return True, because that would
silently drive a live autopilot tick or silently arm a restart-throttle STOP-gate on an
agent the operator never canaried. Every test below asserts the SAFE (OFF) direction on
a hostile or ambiguous registry, plus the one true-positive so the gate is not vacuously
closed.

canary.py reads $AUTOPILOT_STORE_DIR/autopilot-canary.json, so each test points the
store dir at a tmp dir and writes the fixture there -- the live store is never touched.

Run: python3 -m pytest scripts/autopilot/test_canary.py   (or: python3 test_canary.py)
"""
import importlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _load_canary(tmp_path, registry):
    """Point AUTOPILOT_STORE_DIR at tmp_path, write `registry` (None=no file), import fresh."""
    os.environ["AUTOPILOT_STORE_DIR"] = str(tmp_path)
    if registry is not None:
        with open(os.path.join(str(tmp_path), "autopilot-canary.json"), "w", encoding="utf-8") as fh:
            if isinstance(registry, str):
                fh.write(registry)      # raw (lets us inject invalid JSON)
            else:
                json.dump(registry, fh)
    import canary
    importlib.reload(canary)            # re-read STORE_DIR from the patched env
    return canary


# --- TRUE POSITIVE: the gate actually opens for a listed agent (not vacuously closed) ---

def test_listed_agent_enabled(tmp_path):
    c = _load_canary(tmp_path, {"tick": ["buster", "dave"], "throttle": ["buster"]})
    assert c.is_enabled("tick", "buster") is True
    assert c.is_enabled("tick", "dave") is True
    assert c.is_enabled("throttle", "buster") is True


# --- SAFE DIRECTION: every ambiguity resolves to OFF ---

def test_absent_file_is_off(tmp_path):
    c = _load_canary(tmp_path, None)                       # no registry file at all
    assert c.is_enabled("tick", "buster") is False
    assert c.is_enabled("throttle", "buster") is False


def test_unlisted_agent_is_off(tmp_path):
    c = _load_canary(tmp_path, {"tick": ["buster"]})
    assert c.is_enabled("tick", "marveen") is False        # wired but not canaried
    assert c.is_enabled("throttle", "buster") is False     # key absent -> OFF


def test_invalid_json_is_off(tmp_path):
    c = _load_canary(tmp_path, "{this is not json")         # fail-closed, not crash
    assert c.is_enabled("tick", "buster") is False


def test_registry_not_a_dict_is_off(tmp_path):
    c = _load_canary(tmp_path, ["buster"])                  # top-level list, not dict
    assert c.is_enabled("tick", "buster") is False


def test_capability_value_not_a_list_is_off(tmp_path):
    c = _load_canary(tmp_path, {"tick": "buster"})          # string, not list
    assert c.is_enabled("tick", "buster") is False
    c = _load_canary(tmp_path, {"tick": {"buster": True}})  # dict, not list
    assert c.is_enabled("tick", "buster") is False


def test_non_string_entries_never_match(tmp_path):
    c = _load_canary(tmp_path, {"tick": [1, None, {"x": 1}, "buster"]})
    assert c.is_enabled("tick", "buster") is True           # the valid string still matches
    assert c.is_enabled("tick", "1") is False               # the int 1 does NOT match "1"


def test_unknown_capability_is_off(tmp_path):
    # A typo'd / attacker-suggested capability can never read an arbitrary key.
    c = _load_canary(tmp_path, {"deploy": ["buster"], "tick": ["buster"]})
    assert c.is_enabled("deploy", "buster") is False
    assert c.is_enabled("", "buster") is False


def test_empty_or_bad_agent_is_off(tmp_path):
    c = _load_canary(tmp_path, {"tick": ["buster"]})
    assert c.is_enabled("tick", "") is False
    assert c.is_enabled("tick", None) is False              # type: ignore[arg-type]


# --- CLI contract (the bash consumer relies on exit codes) ---

def test_cli_exit_codes(tmp_path):
    c = _load_canary(tmp_path, {"throttle": ["buster"]})
    assert c.main(["throttle", "--agent", "buster"]) == 0   # enabled
    assert c.main(["throttle", "--agent", "marveen"]) == 1  # not listed -> OFF
    assert c.main(["tick", "--agent", "buster"]) == 1       # key absent -> OFF
    assert c.main(["bogus", "--agent", "buster"]) == 2      # usage error (visible), still !=0


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-q"]))
