#!/usr/bin/env python3
"""Slice 2 tests for gen-fleet-roster.py (card 484b550e, spec §4.2 / AC-H2 / AC-H5).

Covers:
  AC-H2: --strict flag exits non-zero when any config-agent has an incomplete
          or invalid team block (adversarial fixture REQUIRED by DoD).
  AC-H5: roster table shows escalatesTo and decisionScope columns.

Does NOT break existing tests in gen-fleet-roster.test.py.
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
SCRIPTS = HERE.parent
GEN_MOD = SCRIPTS / "gen-fleet-roster.py"


def _load_gen():
    spec = importlib.util.spec_from_file_location("gen_fleet_roster", str(GEN_MOD))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _write_config(root: Path, agent_id: str, cfg: dict) -> None:
    d = root / "agents" / agent_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "agent-config.json").write_text(json.dumps(cfg), encoding="utf-8")


def _complete_team(**overrides) -> dict:
    """Return a complete, valid team block; keyword overrides for adversarial tests."""
    base = {
        "role": "member",
        "reportsTo": "dave",
        "delegatesTo": [],
        "escalatesTo": "dave",
        "decisionScope": "none",
        "autoDelegation": False,
        "trustFrom": [],
    }
    base.update(overrides)
    return base


def _build_complete_tree(root: Path) -> None:
    """Minimal tree where ALL agents have complete team blocks (strict must pass)."""
    (root / "agent-config.json").write_text(
        json.dumps({
            "model": "claude-sonnet-4-6",
            "displayName": "NoA",
            "team": _complete_team(role="orchestrator", reportsTo=None,
                                   escalatesTo=None, decisionScope="orchestrate",
                                   delegatesTo=["dave"]),
        }),
        encoding="utf-8",
    )
    _write_config(root, "dave", {
        "model": "claude-sonnet-4-6",
        "displayName": "Dave",
        "team": _complete_team(role="leader", reportsTo=None,
                               escalatesTo="marveen", decisionScope="gate",
                               delegatesTo=["kidd"]),
    })
    _write_config(root, "kidd", {
        "model": "claude-sonnet-4-6",
        "displayName": "Kidd",
        "team": _complete_team(role="member", reportsTo="dave",
                               escalatesTo="dave", decisionScope="none"),
    })


# ---------------------------------------------------------------------------
# AC-H2: --strict flag
# ---------------------------------------------------------------------------

class TestStrictFlag(unittest.TestCase):

    # --- strict PASS (all agents have complete, valid team blocks) -----------

    def test_strict_returns_no_violations_on_complete_fleet(self):
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            agents = mod.load_agents(str(root))
            violations = mod.check_strict(agents)
            self.assertEqual(violations, [],
                             f"expected no violations, got: {violations}")

    def test_strict_exit_code_0_on_complete_fleet(self):
        """main() --strict exits 0 when all configs are complete."""
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            rc = mod.main(["--root", str(root), "--strict", "--stdout"])
            self.assertEqual(rc, 0)

    # --- strict FAIL: adversarial fixtures -----------------------------------

    def test_strict_fails_missing_team_block(self):
        """ADVERSARIAL: an agent with no team block triggers a strict violation."""
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            # Overwrite kidd with NO team block
            _write_config(root, "kidd", {
                "model": "claude-sonnet-4-6",
                "displayName": "Kidd",
            })
            agents = mod.load_agents(str(root))
            violations = mod.check_strict(agents)
            self.assertTrue(any("kidd" in v for v in violations),
                            f"expected kidd violation, got: {violations}")

    def test_strict_fails_missing_role(self):
        """ADVERSARIAL: team block present but role missing."""
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            _write_config(root, "kidd", {
                "model": "claude-sonnet-4-6",
                "team": {"reportsTo": "dave"},  # role absent
            })
            agents = mod.load_agents(str(root))
            violations = mod.check_strict(agents)
            self.assertTrue(any("kidd" in v for v in violations),
                            f"expected kidd violation, got: {violations}")

    def test_strict_fails_invalid_role_value(self):
        """ADVERSARIAL: role='worker' is not in the valid enum."""
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            _write_config(root, "kidd", {
                "model": "claude-sonnet-4-6",
                "team": _complete_team(role="worker"),  # invalid
            })
            agents = mod.load_agents(str(root))
            violations = mod.check_strict(agents)
            self.assertTrue(any("kidd" in v for v in violations),
                            f"expected kidd violation, got: {violations}")

    def test_strict_exit_code_nonzero_on_incomplete_fleet(self):
        """main() --strict returns non-zero when violations exist."""
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            _write_config(root, "kidd", {
                "model": "claude-sonnet-4-6",
                # NO team block
            })
            rc = mod.main(["--root", str(root), "--strict", "--stdout"])
            self.assertNotEqual(rc, 0,
                                "expected non-zero exit on incomplete fleet")

    def test_strict_missing_escalates_to_flagged(self):
        """ADVERSARIAL: escalatesTo absent -> violation."""
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            _write_config(root, "kidd", {
                "model": "claude-sonnet-4-6",
                "team": {"role": "member", "reportsTo": "dave", "decisionScope": "none"},
                # escalatesTo absent
            })
            agents = mod.load_agents(str(root))
            violations = mod.check_strict(agents)
            self.assertTrue(any("kidd" in v for v in violations),
                            f"expected kidd escalatesTo violation, got: {violations}")

    def test_strict_missing_decision_scope_flagged(self):
        """ADVERSARIAL: decisionScope absent -> violation."""
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            _write_config(root, "kidd", {
                "model": "claude-sonnet-4-6",
                "team": {"role": "member", "reportsTo": "dave", "escalatesTo": "dave"},
                # decisionScope absent
            })
            agents = mod.load_agents(str(root))
            violations = mod.check_strict(agents)
            self.assertTrue(any("kidd" in v for v in violations),
                            f"expected kidd decisionScope violation, got: {violations}")


# ---------------------------------------------------------------------------
# AC-H5: new roster columns (escalatesTo / decisionScope)
# ---------------------------------------------------------------------------

class TestNewRosterColumns(unittest.TestCase):

    def _render(self, mod, root: Path) -> str:
        agents = mod.load_agents(str(root))
        return mod.render_roster(agents, set())

    def test_load_agents_returns_escalates_to_field(self):
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            agents = mod.load_agents(str(root))
            dave = next(a for a in agents if a["id"] == "dave")
            self.assertIn("escalates_to", dave,
                          "load_agents must return escalates_to field")
            self.assertEqual(dave["escalates_to"], "marveen")

    def test_load_agents_returns_decision_scope_field(self):
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            agents = mod.load_agents(str(root))
            dave = next(a for a in agents if a["id"] == "dave")
            self.assertIn("decision_scope", dave,
                          "load_agents must return decision_scope field")
            self.assertEqual(dave["decision_scope"], "gate")

    def test_roster_table_header_contains_escalates_to(self):
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            out = self._render(mod, root)
            self.assertIn("escalatesTo", out,
                          "roster table must include escalatesTo column")

    def test_roster_table_header_contains_decision_scope(self):
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            out = self._render(mod, root)
            self.assertIn("decisionScope", out,
                          "roster table must include decisionScope column")

    def test_roster_dave_row_shows_marveen_in_escalates_to_col(self):
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            out = self._render(mod, root)
            dave_line = next(l for l in out.splitlines() if l.startswith("| dave "))
            self.assertIn("marveen", dave_line,
                          f"dave row must show escalatesTo=marveen: {dave_line}")

    def test_roster_dave_row_shows_gate_decision_scope(self):
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            out = self._render(mod, root)
            dave_line = next(l for l in out.splitlines() if l.startswith("| dave "))
            self.assertIn("gate", dave_line,
                          f"dave row must show decisionScope=gate: {dave_line}")

    def test_missing_escalates_to_renders_dash_not_crash(self):
        """Agent without escalatesTo in team block: render as '-', never raise."""
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _build_complete_tree(root)
            # kidd has no escalatesTo
            _write_config(root, "kidd", {
                "model": "claude-sonnet-4-6",
                "team": {"role": "member", "reportsTo": "dave"},
            })
            agents = mod.load_agents(str(root))
            # Must not raise
            out = mod.render_roster(agents, set())
            self.assertIn("kidd", out)


# ---------------------------------------------------------------------------
# Real fleet smoke test: --strict passes on the live fleet (S1 merged)
# ---------------------------------------------------------------------------

class TestRealFleetStrict(unittest.TestCase):
    def test_real_fleet_passes_strict(self):
        """After S1 landed all team blocks, --strict must exit 0 on the live fleet."""
        mod = _load_gen()
        repo_root = str(Path(__file__).parent.parent.parent)
        agents = mod.load_agents(repo_root)
        violations = mod.check_strict(agents)
        self.assertEqual(violations, [],
                         "real fleet should have no strict violations after S1:\n"
                         + "\n".join(violations))


if __name__ == "__main__":
    unittest.main()
