"""TDD tests for validate-fleet-hierarchy.py (card c3ba6b1e, spec §1.5).

Covers AC-H1 / AC-H3 / AC-H4 -- the binary checks implementable in Slice 1.
(AC-H2 gen-fleet-roster --strict and AC-H5 roster display are Slice 2.)

Each AC is tested with a minimal fixture so failures point to exactly one rule.
"""

import json
import os
import sys
import importlib.util
import tempfile
import pathlib
import pytest

# ---------------------------------------------------------------------------
# Load the validator as a module so we can call its functions directly.
# The script lives next to this test file.
# ---------------------------------------------------------------------------
_SCRIPT = pathlib.Path(__file__).parent / "validate-fleet-hierarchy.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("validate_fleet_hierarchy", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

VALID_ROLES = {"orchestrator", "leader", "member", "specialist"}

# Minimal valid fleet used as a baseline in tests that need a passing fleet.
MINIMAL_FLEET = {
    "marveen": {
        "team": {
            "role": "orchestrator",
            "reportsTo": None,
            "delegatesTo": ["dave"],
            "escalatesTo": None,
            "decisionScope": "orchestrate",
            "autoDelegation": False,
            "trustFrom": [],
        }
    },
    "dave": {
        "team": {
            "role": "leader",
            "reportsTo": None,
            "delegatesTo": ["kidd"],
            "escalatesTo": "marveen",
            "decisionScope": "gate",
            "autoDelegation": False,
            "trustFrom": [],
        }
    },
    "kidd": {
        "team": {
            "role": "member",
            "reportsTo": "dave",
            "delegatesTo": [],
            "escalatesTo": "dave",
            "decisionScope": "none",
            "autoDelegation": False,
            "trustFrom": [],
        }
    },
}


# ---------------------------------------------------------------------------
# AC-H1: every config-agent team.role is present and in the valid enum
# ---------------------------------------------------------------------------


class TestACH1:
    def test_valid_fleet_passes(self):
        v = load_validator()
        errors = v.check_ac_h1(MINIMAL_FLEET)
        assert errors == [], errors

    def test_missing_role_flagged(self):
        v = load_validator()
        fleet = {
            "agent_a": {"team": {"reportsTo": None, "escalatesTo": None, "decisionScope": "none"}},
        }
        errors = v.check_ac_h1(fleet)
        assert any("role" in e.lower() and "agent_a" in e for e in errors), errors

    def test_invalid_role_value_flagged(self):
        v = load_validator()
        fleet = {
            "agent_x": {
                "team": {
                    "role": "worker",  # not in enum
                    "reportsTo": None,
                    "escalatesTo": None,
                    "decisionScope": "none",
                }
            }
        }
        errors = v.check_ac_h1(fleet)
        assert any("agent_x" in e for e in errors), errors

    def test_missing_team_block_flagged(self):
        v = load_validator()
        fleet = {"agent_no_team": {}}
        errors = v.check_ac_h1(fleet)
        assert any("agent_no_team" in e for e in errors), errors

    @pytest.mark.parametrize("role", ["orchestrator", "leader", "member", "specialist"])
    def test_all_valid_role_values_accepted(self, role):
        v = load_validator()
        fleet = {
            "a": {
                "team": {
                    "role": role,
                    "reportsTo": None,
                    "escalatesTo": None,
                    "decisionScope": "none",
                }
            }
        }
        errors = v.check_ac_h1(fleet)
        assert errors == [], f"role={role!r} should be valid, got: {errors}"


# ---------------------------------------------------------------------------
# AC-H3: every reportsTo / escalatesTo points to a known agent_id or null
# ---------------------------------------------------------------------------


class TestACH3:
    def test_valid_fleet_passes(self):
        v = load_validator()
        errors = v.check_ac_h3(MINIMAL_FLEET)
        assert errors == [], errors

    def test_dangling_reports_to_flagged(self):
        v = load_validator()
        fleet = {
            "orphan": {
                "team": {
                    "role": "member",
                    "reportsTo": "ghost",  # not in fleet
                    "escalatesTo": None,
                    "decisionScope": "none",
                }
            }
        }
        errors = v.check_ac_h3(fleet)
        assert any("orphan" in e and "ghost" in e for e in errors), errors

    def test_dangling_escalates_to_flagged(self):
        v = load_validator()
        fleet = {
            "agent_e": {
                "team": {
                    "role": "member",
                    "reportsTo": None,
                    "escalatesTo": "nobody",  # not in fleet
                    "decisionScope": "none",
                }
            }
        }
        errors = v.check_ac_h3(fleet)
        assert any("agent_e" in e and "nobody" in e for e in errors), errors

    def test_null_reports_and_escalates_accepted(self):
        v = load_validator()
        fleet = {
            "top": {
                "team": {
                    "role": "orchestrator",
                    "reportsTo": None,
                    "escalatesTo": None,
                    "decisionScope": "orchestrate",
                }
            }
        }
        errors = v.check_ac_h3(fleet)
        assert errors == [], errors

    def test_self_reference_dangling(self):
        """An agent referencing itself in reportsTo is a structural error (also caught by H4)."""
        v = load_validator()
        fleet = {
            "loop_agent": {
                "team": {
                    "role": "member",
                    "reportsTo": "loop_agent",
                    "escalatesTo": "loop_agent",
                    "decisionScope": "none",
                }
            }
        }
        # H3 passes (self is a known id); H4 catches the cycle
        errors_h3 = v.check_ac_h3(fleet)
        # self-reference is a valid agent_id reference -- H3 may pass
        errors_h4 = v.check_ac_h4(fleet)
        assert any("loop_agent" in e for e in errors_h4), errors_h4


# ---------------------------------------------------------------------------
# AC-H4: escalatesTo / reportsTo chain <= 4 hops to marveen or null; no cycles
# ---------------------------------------------------------------------------


class TestACH4:
    def test_valid_fleet_passes(self):
        v = load_validator()
        errors = v.check_ac_h4(MINIMAL_FLEET)
        assert errors == [], errors

    def test_cycle_detected(self):
        v = load_validator()
        fleet = {
            "a": {"team": {"role": "member", "reportsTo": "b", "escalatesTo": "b", "decisionScope": "none"}},
            "b": {"team": {"role": "member", "reportsTo": "a", "escalatesTo": "a", "decisionScope": "none"}},
        }
        errors = v.check_ac_h4(fleet)
        assert len(errors) > 0, "cycle must be detected"

    def test_chain_too_long_detected(self):
        """5-hop chain: e->d->c->b->a->null must be flagged (> 4)."""
        v = load_validator()
        fleet = {
            "a": {"team": {"role": "orchestrator", "reportsTo": None,  "escalatesTo": None,  "decisionScope": "orchestrate"}},
            "b": {"team": {"role": "leader",       "reportsTo": "a",   "escalatesTo": "a",   "decisionScope": "gate"}},
            "c": {"team": {"role": "member",        "reportsTo": "b",   "escalatesTo": "b",   "decisionScope": "none"}},
            "d": {"team": {"role": "member",        "reportsTo": "c",   "escalatesTo": "c",   "decisionScope": "none"}},
            "e": {"team": {"role": "member",        "reportsTo": "d",   "escalatesTo": "d",   "decisionScope": "none"}},
            "f": {"team": {"role": "member",        "reportsTo": "e",   "escalatesTo": "e",   "decisionScope": "none"}},
        }
        errors = v.check_ac_h4(fleet)
        assert any("f" in e for e in errors), f"f is 5 hops deep, expected error. got: {errors}"

    def test_exactly_4_hops_accepted(self):
        """4-hop chain: d->c->b->a->null is exactly at limit, must pass."""
        v = load_validator()
        fleet = {
            "a": {"team": {"role": "orchestrator", "reportsTo": None, "escalatesTo": None,  "decisionScope": "orchestrate"}},
            "b": {"team": {"role": "leader",       "reportsTo": "a",  "escalatesTo": "a",   "decisionScope": "gate"}},
            "c": {"team": {"role": "member",        "reportsTo": "b",  "escalatesTo": "b",   "decisionScope": "none"}},
            "d": {"team": {"role": "member",        "reportsTo": "c",  "escalatesTo": "c",   "decisionScope": "none"}},
        }
        errors = v.check_ac_h4(fleet)
        assert errors == [], f"4-hop chain should pass. got: {errors}"


# ---------------------------------------------------------------------------
# Integration: load real fleet and run all checks
# ---------------------------------------------------------------------------


class TestRealFleet:
    """Smoke test: the real fleet under agents/ passes all Slice-1 ACs after the data update."""

    def test_real_fleet_loads_without_json_error(self):
        v = load_validator()
        fleet = v.load_fleet(pathlib.Path(__file__).parent.parent)
        assert len(fleet) > 0

    def test_real_fleet_passes_all_slice1_checks(self):
        v = load_validator()
        root = pathlib.Path(__file__).parent.parent
        fleet = v.load_fleet(root)
        errors = v.run_slice1_checks(fleet)
        assert errors == [], "\n".join(errors)
