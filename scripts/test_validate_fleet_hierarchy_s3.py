"""TDD tests for validate-fleet-hierarchy.py Slice 3 additions (card f31b28a6).

Covers §2.4 ACs:
  AC-S1: scope.charter present, non-empty, <= 240 chars
  AC-S2: owns ∩ excludes = ∅ (disjoint)
  AC-S3: every excludes label has redirectTo OR agent has escalation path
  AC-S4: every redirectTo value is a known agent_id
  AC-S5: all owns/excludes labels are in the closed vocabulary

Also tests:
  - load_vocabulary() reads fleet-scope-vocabulary.md
  - run_slice3_checks() combines S3 ACs
  - real fleet passes all S3 checks with draft scope blocks
"""

import json
import pathlib
import pytest

_SCRIPT = pathlib.Path(__file__).parent / "validate-fleet-hierarchy.py"


def load_validator():
    import importlib.util
    spec = importlib.util.spec_from_file_location("validate_fleet_hierarchy", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


VOCAB_PATH = pathlib.Path(__file__).parent.parent / "docs" / "fleet-scope-vocabulary.md"

# A minimal in-memory vocabulary for unit tests
SAMPLE_VOCAB = {"core-eng", "qa-testing", "security-audit", "deploy-sre",
                "research", "orchestration", "monitoring", "channel-comms"}


def _agent(agent_id, *, role="member", reportsTo="marveen", escalatesTo="marveen",
           decisionScope="none", charter=None, owns=None, excludes=None, redirectTo=None):
    """Build a minimal valid fleet entry for use in unit tests."""
    team = {
        "role": role, "reportsTo": reportsTo, "delegatesTo": [],
        "escalatesTo": escalatesTo, "decisionScope": decisionScope,
        "autoDelegation": False, "trustFrom": [],
    }
    scope = {
        "charter": "DRAFT: placeholder -- awaiting Boss charter approval (BD-2)." if charter is None else charter,
        "owns": owns if owns is not None else ["core-eng"],
        "excludes": excludes if excludes is not None else [],
        "redirectTo": redirectTo if redirectTo is not None else {},
    }
    return {"team": team, "scope": scope}


def _fleet(*pairs):
    """Build a fleet dict from (id, cfg) pairs."""
    return dict(pairs)


# ---------------------------------------------------------------------------
# AC-S1: scope.charter present, non-empty, <= 240 chars
# ---------------------------------------------------------------------------

class TestACS1:
    def test_valid_charter_passes(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a")))
        errors = v.check_ac_s1(fleet)
        assert errors == []

    def test_missing_scope_block_flagged(self):
        v = load_validator()
        fleet = {"a": {"team": {"role": "member", "reportsTo": None, "escalatesTo": None,
                                "decisionScope": "none"}}}
        errors = v.check_ac_s1(fleet)
        assert any("a" in e and "scope" in e.lower() for e in errors), errors

    def test_empty_charter_flagged(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", charter="")))
        errors = v.check_ac_s1(fleet)
        assert any("a" in e for e in errors), errors

    def test_charter_too_long_flagged(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", charter="x" * 241)))
        errors = v.check_ac_s1(fleet)
        assert any("a" in e for e in errors), errors

    def test_charter_exactly_240_chars_passes(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", charter="x" * 240)))
        errors = v.check_ac_s1(fleet)
        assert errors == []

    def test_missing_charter_key_flagged(self):
        v = load_validator()
        fleet = {"a": {"team": {"role": "member", "escalatesTo": "marveen",
                                "decisionScope": "none"},
                       "scope": {"owns": [], "excludes": [], "redirectTo": {}}}}
        errors = v.check_ac_s1(fleet)
        assert any("a" in e for e in errors), errors


# ---------------------------------------------------------------------------
# AC-S2: owns ∩ excludes = ∅
# ---------------------------------------------------------------------------

class TestACS2:
    def test_disjoint_passes(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", owns=["core-eng"], excludes=["qa-testing"])))
        errors = v.check_ac_s2(fleet)
        assert errors == []

    def test_empty_excludes_passes(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", owns=["core-eng"], excludes=[])))
        errors = v.check_ac_s2(fleet)
        assert errors == []

    def test_overlap_flagged(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", owns=["core-eng", "qa-testing"],
                                    excludes=["core-eng"])))
        errors = v.check_ac_s2(fleet)
        assert any("a" in e and "core-eng" in e for e in errors), errors

    def test_full_overlap_flagged(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", owns=["x", "y"], excludes=["x", "y"])))
        errors = v.check_ac_s2(fleet)
        assert len(errors) > 0


# ---------------------------------------------------------------------------
# AC-S3: every excludes label covered (redirectTo OR escalation path)
# ---------------------------------------------------------------------------

class TestACS3:
    def test_exclude_with_redirect_passes(self):
        v = load_validator()
        fleet = _fleet(
            ("a", _agent("a", excludes=["security-audit"],
                         redirectTo={"security-audit": "b"})),
            ("b", _agent("b")),
            ("marveen", _agent("marveen", role="orchestrator", escalatesTo=None,
                               decisionScope="orchestrate")),
        )
        errors = v.check_ac_s3(fleet)
        assert errors == []

    def test_exclude_without_redirect_but_has_escalation_passes(self):
        """Exclude label with no redirectTo entry -> default marveen escalation acceptable."""
        v = load_validator()
        fleet = _fleet(
            ("a", _agent("a", escalatesTo="marveen", excludes=["security-audit"],
                         redirectTo={})),
            ("marveen", _agent("marveen", role="orchestrator", escalatesTo=None,
                               decisionScope="orchestrate")),
        )
        errors = v.check_ac_s3(fleet)
        assert errors == []

    def test_exclude_without_redirect_and_no_escalation_flagged(self):
        """ADVERSARIAL: escalatesTo=null AND no redirectTo for exclude label -> flagged."""
        v = load_validator()
        fleet = _fleet(
            ("a", _agent("a", escalatesTo=None, excludes=["security-audit"],
                         redirectTo={})),
        )
        errors = v.check_ac_s3(fleet)
        assert any("a" in e for e in errors), errors

    def test_empty_excludes_passes(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", excludes=[], redirectTo={})))
        errors = v.check_ac_s3(fleet)
        assert errors == []


# ---------------------------------------------------------------------------
# AC-S4: redirectTo values are known agent_ids
# ---------------------------------------------------------------------------

class TestACS4:
    def test_valid_redirect_passes(self):
        v = load_validator()
        fleet = _fleet(
            ("a", _agent("a", excludes=["security-audit"],
                         redirectTo={"security-audit": "b"})),
            ("b", _agent("b")),
        )
        errors = v.check_ac_s4(fleet)
        assert errors == []

    def test_dangling_redirect_target_flagged(self):
        v = load_validator()
        fleet = _fleet(
            ("a", _agent("a", excludes=["security-audit"],
                         redirectTo={"security-audit": "ghost"})),
        )
        errors = v.check_ac_s4(fleet)
        assert any("a" in e and "ghost" in e for e in errors), errors

    def test_empty_redirect_map_passes(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", redirectTo={})))
        errors = v.check_ac_s4(fleet)
        assert errors == []


# ---------------------------------------------------------------------------
# AC-S5: owns labels in closed vocabulary
# ---------------------------------------------------------------------------

class TestACS5:
    def test_known_labels_pass(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", owns=["core-eng"])))
        errors = v.check_ac_s5(fleet, SAMPLE_VOCAB)
        assert errors == []

    def test_unknown_owns_label_flagged(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", owns=["my-custom-domain"])))
        errors = v.check_ac_s5(fleet, SAMPLE_VOCAB)
        assert any("a" in e and "my-custom-domain" in e for e in errors), errors

    def test_unknown_excludes_label_flagged(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", owns=["core-eng"],
                                    excludes=["mystery-domain"])))
        errors = v.check_ac_s5(fleet, SAMPLE_VOCAB)
        assert any("a" in e and "mystery-domain" in e for e in errors), errors

    def test_empty_owns_passes(self):
        v = load_validator()
        fleet = _fleet(("a", _agent("a", owns=[], excludes=[])))
        errors = v.check_ac_s5(fleet, SAMPLE_VOCAB)
        assert errors == []


# ---------------------------------------------------------------------------
# load_vocabulary
# ---------------------------------------------------------------------------

class TestLoadVocabulary:
    def test_loads_real_vocabulary_file(self):
        v = load_validator()
        vocab = v.load_vocabulary(VOCAB_PATH)
        assert isinstance(vocab, set), f"expected set, got {type(vocab)}"
        assert len(vocab) >= 5, f"vocabulary too small: {vocab}"

    def test_vocabulary_contains_core_eng(self):
        v = load_validator()
        vocab = v.load_vocabulary(VOCAB_PATH)
        assert "core-eng" in vocab, f"core-eng missing from vocabulary: {vocab}"

    def test_missing_vocab_file_raises_or_returns_empty(self):
        v = load_validator()
        import pathlib
        result = v.load_vocabulary(pathlib.Path("/nonexistent/vocab.md"))
        assert isinstance(result, set)


# ---------------------------------------------------------------------------
# Integration: real fleet passes all S3 checks with draft scope blocks
# ---------------------------------------------------------------------------

class TestRealFleetS3:
    def test_real_fleet_passes_all_slice3_checks(self):
        v = load_validator()
        root = pathlib.Path(__file__).parent.parent
        fleet = v.load_fleet(root)
        vocab = v.load_vocabulary(VOCAB_PATH)
        errors = v.run_slice3_checks(fleet, vocab)
        assert errors == [], "\n".join(errors)
