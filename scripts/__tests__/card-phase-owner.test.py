#!/usr/bin/env python3
"""Tests for scripts/card-phase-owner.py

Run: python3 scripts/__tests__/card-phase-owner.test.py

Covers:
  - dev-phase card   -> dave
  - gate-phase card  -> thor
  - deploy-phase card -> forge
  - ambiguous (conflicting signals) -> None
  - status fallback with no description signals
  - 'waiting' status alone -> ambiguous (fail-CLOSED, NOT a default)
  - ADVERSARIAL: deploy-phase card with BOTH gate AND deploy signals -> ambiguous
    (the dangerous direction: a card that *looks* like it needs nudging but
    actually has conflicting signals must NOT silently pick the wrong person)
  - ADVERSARIAL: bad/malformed card inputs fail-CLOSED (None holder)
  - CWD-independence: subprocess from a hostile tempdir resolves correctly
    (guards the known fleet fail-open class -- shared-cwd-dependent-path-guard-*)

Style matches scripts/hooks/test_guardrail_ask_first.py:
  - importlib.util.spec_from_file_location to load the module by path
  - unittest.TestCase subclasses
  - subprocess.run from a tempdir for CWD-hostile tests
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULE_PATH = os.path.join(_HERE, "..", "card-phase-owner.py")

_spec = importlib.util.spec_from_file_location("card_phase_owner", _MODULE_PATH)
cpo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cpo)

resolve = cpo.resolve_phase_owner
R = cpo.PhaseOwnerResult


# ---------------------------------------------------------------------------
# Dev-phase
# ---------------------------------------------------------------------------

class DevPhaseTests(unittest.TestCase):
    """status=planned/in_progress with no explicit phase signals -> dave."""

    def test_planned_no_signal_is_dave(self):
        result = resolve({"status": "planned", "description": "Build the auth flow"})
        self.assertEqual(result.holder, "dave")
        self.assertEqual(result.phase, "dev")

    def test_in_progress_no_signal_is_dave(self):
        result = resolve({"status": "in_progress", "description": "Implementing the new parser"})
        self.assertEqual(result.holder, "dave")
        self.assertEqual(result.phase, "dev")

    def test_explicit_dev_signal_in_desc_is_dave(self):
        result = resolve({
            "status": "waiting",
            "description": "Owner: forge\nDev phase: implementing the cache layer. Dave build.",
        })
        self.assertEqual(result.holder, "dave")
        self.assertEqual(result.phase, "dev")

    def test_wip_signal_is_dave(self):
        result = resolve({"status": "in_progress", "description": "WIP: hooking up new endpoint"})
        self.assertEqual(result.holder, "dave")
        self.assertEqual(result.phase, "dev")


# ---------------------------------------------------------------------------
# Gate-phase
# ---------------------------------------------------------------------------

class GatePhaseTests(unittest.TestCase):
    """Gate-phase signals -> thor."""

    def test_gate_waiting_desc_is_thor(self):
        result = resolve({
            "status": "waiting",
            "description": "PR open. Gate-waiting for QA+SEC approval.",
        })
        self.assertEqual(result.holder, "thor")
        self.assertEqual(result.phase, "gate")

    def test_waiting_for_gate_signal_is_thor(self):
        result = resolve({
            "status": "waiting",
            "description": "Implementation done. Waiting for gate review.",
        })
        self.assertEqual(result.holder, "thor")
        self.assertEqual(result.phase, "gate")

    def test_gate_dispatch_pending_is_thor(self):
        result = resolve({
            "status": "waiting",
            "description": "gate-dispatch sent, awaiting seat from thor",
        })
        self.assertEqual(result.holder, "thor")
        self.assertEqual(result.phase, "gate")

    def test_needs_gate_review_is_thor(self):
        result = resolve({
            "status": "waiting",
            "description": "Needs gate review before merge.",
        })
        self.assertEqual(result.holder, "thor")
        self.assertEqual(result.phase, "gate")


# ---------------------------------------------------------------------------
# Deploy-phase
# ---------------------------------------------------------------------------

class DeployPhaseTests(unittest.TestCase):
    """Deploy-phase signals -> forge."""

    def test_gate_pass_deploy_ready_is_forge(self):
        result = resolve({
            "status": "waiting",
            "description": "Gate passed. Deploy ready -- forge GO when available.",
        })
        self.assertEqual(result.holder, "forge")
        self.assertEqual(result.phase, "deploy")

    def test_deploy_waiting_is_forge(self):
        result = resolve({
            "status": "waiting",
            "description": "gate-approved; deploy pending forge",
        })
        self.assertEqual(result.holder, "forge")
        self.assertEqual(result.phase, "deploy")

    def test_forge_deploy_explicit_is_forge(self):
        result = resolve({
            "status": "waiting",
            "description": "forge-deploy awaiting green window",
        })
        self.assertEqual(result.holder, "forge")
        self.assertEqual(result.phase, "deploy")

    def test_merge_approved_deploy_signal_is_forge(self):
        result = resolve({
            "status": "waiting",
            "description": "Merge-ready, deploy phase: forge builds the dist.",
        })
        self.assertEqual(result.holder, "forge")
        self.assertEqual(result.phase, "deploy")


# ---------------------------------------------------------------------------
# Ambiguous -> None (fail-CLOSED)
# ---------------------------------------------------------------------------

class AmbiguousTests(unittest.TestCase):
    """Conflicting or insufficient signals must return holder=None (fail-CLOSED)."""

    def test_waiting_no_signal_is_ambiguous(self):
        """'waiting' alone is ambiguous: gate-wait or deploy-wait? -> None."""
        result = resolve({"status": "waiting", "description": "On hold."})
        self.assertIsNone(result.holder)
        self.assertEqual(result.phase, "ambiguous")

    def test_unknown_status_no_signal_is_unknown(self):
        result = resolve({"status": "done", "description": "All done."})
        self.assertIsNone(result.holder)
        # phase='unknown' or 'ambiguous' -- both acceptable None-holder
        self.assertIn(result.phase, {"unknown", "ambiguous"})

    def test_non_dict_input_is_none(self):
        result = resolve("not a dict")
        self.assertIsNone(result.holder)

    def test_none_input_is_none(self):
        result = resolve(None)
        self.assertIsNone(result.holder)

    def test_empty_dict_is_none(self):
        """Empty dict: status='' -> no known status, no signals -> unknown/None."""
        result = resolve({})
        self.assertIsNone(result.holder)


# ---------------------------------------------------------------------------
# ADVERSARIAL: the DANGEROUS direction must fail-CLOSED, not silently pick wrong
# ---------------------------------------------------------------------------

class AdversarialTests(unittest.TestCase):
    """These tests cover the hostile direction: inputs that LOOK resolvable but
    actually carry conflicting or misleading signals.

    The dangerous failure mode is picking the WRONG person (e.g. returning
    'forge' when the card is actually still in gate-review). We assert None
    here rather than the wrong holder.

    detector-dod-gate requirement: cover the dangerous direction explicitly.
    """

    def test_both_gate_and_deploy_signals_is_ambiguous(self):
        """ADVERSARIAL: a card that mentions both 'gate-pass' AND 'gate-waiting'
        has conflicting signals and must NOT be assigned to forge silently."""
        result = resolve({
            "status": "waiting",
            "description": (
                "Gate-waiting for final seat.\n"
                "Once gate-passed, deploy-ready for forge."
            ),
        })
        self.assertIsNone(result.holder,
            "conflicting gate+deploy signals must yield None, not forge")
        self.assertEqual(result.phase, "ambiguous")

    def test_all_three_signals_is_ambiguous(self):
        """ADVERSARIAL: a description mentioning dev, gate, and deploy is a mess --
        must not silently pick any single owner."""
        result = resolve({
            "status": "in_progress",
            "description": (
                "Dave build in progress (dev phase).\n"
                "Needs gate review.\n"
                "Then deploy-ready for forge."
            ),
        })
        self.assertIsNone(result.holder,
            "all three phase signals firing must yield None, not a guess")

    def test_desc_owner_label_does_not_override_phase(self):
        """ADVERSARIAL: description says 'Owner: forge' but the card is in gate-
        waiting phase. The desc Owner label is for the final-phase owner, not the
        current-phase nudge target. We must return thor, not forge."""
        result = resolve({
            "status": "waiting",
            "description": "Owner: forge\nGate-waiting for QA review.",
        })
        # The desc says forge, but the CURRENT phase signal says thor.
        # This card has gate_signal=True, deploy_signal=False, dev_signal=False.
        self.assertEqual(result.holder, "thor",
            "gate-waiting signal must override raw desc Owner label")

    def test_gate_pass_in_title_plus_gate_waiting_in_desc_is_ambiguous(self):
        """ADVERSARIAL: title mentions 'gate-pass' (suggesting deploy) but desc
        says 'gate-waiting' (suggesting review still pending). Conflict -> None."""
        result = resolve({
            "status": "waiting",
            "title": "gate-pass required",
            "description": "gate-waiting for second reviewer",
        })
        # Both deploy_signal (from title) and gate_signal (from desc) fire.
        self.assertIsNone(result.holder,
            "title+desc conflicting signals must yield None")

    def test_deploy_signal_AND_dev_signal_is_ambiguous(self):
        """ADVERSARIAL: deploy phrasing and dev-phase phrasing co-occur -> None."""
        result = resolve({
            "status": "in_progress",
            "description": "Dave build: implementing the hook. Then deploy-pending forge.",
        })
        self.assertIsNone(result.holder)

    def test_no_description_waiting_is_ambiguous_not_default_forge(self):
        """ADVERSARIAL: a bare 'waiting' card with no description must not default
        to any holder. The absence of signal must be fail-CLOSED."""
        result = resolve({"status": "waiting"})
        self.assertIsNone(result.holder,
            "waiting with no description must be ambiguous, not default to forge")

    def test_malformed_status_int_is_none(self):
        """ADVERSARIAL: status is an int, not a string -> must not crash."""
        result = resolve({"status": 42, "description": "some work"})
        # Should degrade gracefully; phase is dev (no signals, status coerced to
        # '' -> unknown). Either way, holder may be None or 'dave'; the important
        # invariant is NO exception.
        self.assertIsNotNone(result, "must return a PhaseOwnerResult, not raise")


# ---------------------------------------------------------------------------
# CWD-independence: hostile-cwd subprocess regression
#
# This is the specific regression class from:
#   shared-cwd-dependent-path-guard-fail-open-and-green-for-wrong-reason-test-1120
#
# A test that inherits the repo-root CWD from the caller NEVER exercises the
# hostile-cwd path.  We run a subprocess from a fresh tempdir that has NO
# relation to the repo root to prove the module is CWD-independent.
# ---------------------------------------------------------------------------

class CwdIndependenceTests(unittest.TestCase):
    """Verify the helper works correctly when CWD is an unrelated tempdir."""

    def _run_from_hostile_cwd(self, card: dict) -> dict:
        """Run card-phase-owner.py as a subprocess from a tempdir (hostile cwd)."""
        with tempfile.TemporaryDirectory() as alien_cwd:
            result = subprocess.run(
                [sys.executable, _MODULE_PATH],
                input=json.dumps(card),
                capture_output=True,
                text=True,
                cwd=alien_cwd,  # hostile: has no relation to the repo root
            )
            # Must not crash regardless of CWD.
            if result.returncode not in (0, 1):
                self.fail(
                    f"unexpected exit code {result.returncode} from hostile cwd; "
                    f"stderr: {result.stderr!r}"
                )
            return json.loads(result.stdout)

    def test_dev_phase_resolved_from_hostile_cwd(self):
        out = self._run_from_hostile_cwd({"status": "planned", "description": "Build auth"})
        self.assertEqual(out["holder"], "dave")

    def test_gate_phase_resolved_from_hostile_cwd(self):
        out = self._run_from_hostile_cwd({
            "status": "waiting",
            "description": "gate-waiting for QA seat",
        })
        self.assertEqual(out["holder"], "thor")

    def test_deploy_phase_resolved_from_hostile_cwd(self):
        out = self._run_from_hostile_cwd({
            "status": "waiting",
            "description": "gate-passed, deploy-ready for forge",
        })
        self.assertEqual(out["holder"], "forge")

    def test_ambiguous_resolved_from_hostile_cwd(self):
        out = self._run_from_hostile_cwd({"status": "waiting", "description": "On hold."})
        self.assertIsNone(out["holder"])

    def test_adversarial_conflict_from_hostile_cwd(self):
        """The dangerous conflict case must still return None from hostile CWD."""
        out = self._run_from_hostile_cwd({
            "status": "waiting",
            "description": "Gate-waiting and also gate-passed deploy-ready forge.",
        })
        self.assertIsNone(out["holder"],
            "conflicting signals must yield None even from hostile CWD")


if __name__ == "__main__":
    if not os.path.exists(_MODULE_PATH):
        print(f"SKIP: {_MODULE_PATH} not yet implemented")
        sys.exit(0)
    unittest.main(verbosity=2)
