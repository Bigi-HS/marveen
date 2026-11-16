#!/usr/bin/env python3
"""Tests for debrand_text.py -- de-brand classify/apply engine (card cb92634f, Pass 4).

Run: python3 -m pytest scripts/test_debrand_text.py -q

House style mirrors scripts/hooks/test_egress_pii_scan.py: plain unittest,
class-grouped, importlib module load so no package install is needed. Hermetic:
pure functions, no IO, no network.

Covers:
  * the pre-existing context='code' core (regression guard -- byte-identical behavior)
  * the new context='memory' tier (M1 path / M2 agent-id+prose / M3 historical /
    provenance sentinel / blocklist-wins / unclassified fail-closed / NOOP)
  * DA-9 precedence boundary (historical marker forces KEEP over an M2-ish verb)
  * idempotence of apply()
  * contains_blocklist_token public helper
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD = os.path.join(_HERE, "debrand_text.py")

_spec = importlib.util.spec_from_file_location("debrand_text", _MOD)
dt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dt)


# ---------------------------------------------------------------------------
# context='code' regression guard -- must stay byte-identical.
# ---------------------------------------------------------------------------
class CodeContextRegressionTests(unittest.TestCase):
    def test_noop_when_no_token(self):
        self.assertEqual(dt.classify("plain string"), dt.Verdict(dt.NOOP))

    def test_blocklist_wins(self):
        v = dt.classify("label com.marveen.channels here")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "coordinated-infra")

    def test_a1_path_rewrite(self):
        v = dt.classify("/home/domin/marveen/store/noa.db")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.new_value, "/home/domin/noa/store/noa.db")

    def test_a3_route_refuse(self):
        v = dt.classify("/api/marveen")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "contract-change-route")

    def test_a2_agentid_key_gated_rewrite(self):
        v = dt.classify("marveen", key="agent_id")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.new_value, "noa")

    def test_a2_without_key_is_unclassified(self):
        v = dt.classify("marveen")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "unclassified")

    def test_unclassified_prose(self):
        v = dt.classify("marveen did something unusual")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "unclassified")


# ---------------------------------------------------------------------------
# context='memory' tier.
# ---------------------------------------------------------------------------
class MemoryContextTests(unittest.TestCase):
    def test_noop_no_token(self):
        self.assertEqual(dt.classify("nothing here", context="memory"), dt.Verdict(dt.NOOP))

    def test_m1_embedded_path_rewrite(self):
        v = dt.classify("pointer to /home/domin/marveen/store", context="memory")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.new_value, "pointer to /home/domin/noa/store")

    def test_m2_agentid_key_gated_rewrite(self):
        v = dt.classify("marveen", context="memory", key="agent_id")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.new_value, "noa")

    def test_m2_prose_live_identity_rewrite(self):
        v = dt.classify("marveen handles routing", context="memory")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.new_value, "noa handles routing")

    def test_m2_prose_from_marveen_rewrite(self):
        v = dt.classify("the message came from marveen earlier", context="memory")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.new_value, "the message came from noa earlier")

    def test_m2_prose_marveen_is_the_rewrite(self):
        v = dt.classify("marveen is the orchestrator", context="memory")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.new_value, "noa is the orchestrator")

    def test_m3_formerly_marveen_keep(self):
        v = dt.classify("the agent, formerly marveen, now runs v2", context="memory")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "historical-keep")
        self.assertTrue(v.needs_glance)

    def test_m3_ex_marveen_keep(self):
        v = dt.classify("ex-marveen record kept for accuracy", context="memory")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "historical-keep")

    def test_m3_marveen_incident_keep(self):
        v = dt.classify("see the marveen incident of 09-18", context="memory")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "historical-keep")

    def test_m3_dateish_the_marveen_keep(self):
        v = dt.classify("the 09-18 marveen rollback", context="memory")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "historical-keep")

    def test_m3_was_marveen_keep(self):
        v = dt.classify("the service was marveen before the rename", context="memory")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "historical-keep")

    def test_m3_renamed_marveen_keep(self):
        v = dt.classify("we renamed the marveen agent", context="memory")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "historical-keep")

    def test_provenance_sentinel_keep(self):
        v = dt.classify("keep this marveen<!--debrand:keep--> literal", context="memory")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "provenance-keep")

    def test_blocklist_wins_over_rewrite_shape(self):
        # Contains an A1/M1-looking path AND an external label: blocklist wins.
        v = dt.classify(
            "/home/domin/marveen/x references com.marveen.channels", context="memory"
        )
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "coordinated-infra")

    def test_blocklist_wins_over_sentinel_shape(self):
        # Blocklist is checked AFTER sentinel per precedence; sentinel-wrapped keep wins
        # only when the sentinel is present. A plain blocklist token -> coordinated-infra.
        v = dt.classify("quoting com.marveen.channels", context="memory")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "coordinated-infra")

    def test_unclassified_fail_closed(self):
        v = dt.classify("marveen appears with no recognized shape", context="memory")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "unclassified")


# ---------------------------------------------------------------------------
# DA-9 precedence boundary: a historical marker forces KEEP even if the same
# string also carries an M2-ish live-identity verb. The two cases are two
# SEPARATE values / two classify() calls (not one string that splits).
# ---------------------------------------------------------------------------
class DA9PrecedenceTests(unittest.TestCase):
    def test_historical_with_m2_verb_classifies_m3_keep(self):
        v = dt.classify(
            "the noa agent (formerly marveen) handles routing", context="memory"
        )
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "historical-keep")

    def test_bare_m2_reference_rewrites(self):
        v = dt.classify("marveen handles routing", context="memory")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.new_value, "noa handles routing")


# ---------------------------------------------------------------------------
# apply() + idempotence + public helper.
# ---------------------------------------------------------------------------
class ApplyAndHelperTests(unittest.TestCase):
    def test_apply_rewrite_memory(self):
        new, v = dt.apply("marveen handles routing", context="memory")
        self.assertEqual(new, "noa handles routing")
        self.assertEqual(v.action, dt.REWRITE)

    def test_apply_refuse_leaves_value(self):
        new, v = dt.apply("quoting com.marveen.channels", context="memory")
        self.assertEqual(new, "quoting com.marveen.channels")
        self.assertEqual(v.action, dt.REFUSE)

    def test_apply_idempotent_on_rewritten_value(self):
        new, v = dt.apply("marveen handles routing", context="memory")
        new2, v2 = dt.apply(new, context="memory")
        self.assertEqual(new2, new)
        self.assertEqual(v2.action, dt.NOOP)

    def test_apply_idempotent_on_path(self):
        new, _ = dt.apply("/home/domin/marveen/x", context="memory")
        new2, v2 = dt.apply(new, context="memory")
        self.assertEqual(new2, "/home/domin/noa/x")
        self.assertEqual(v2.action, dt.NOOP)

    def test_contains_blocklist_token_true(self):
        self.assertTrue(dt.contains_blocklist_token("x com.marveen.channels y"))
        self.assertTrue(dt.contains_blocklist_token("agent-marveen-prod"))

    def test_contains_blocklist_token_false(self):
        self.assertFalse(dt.contains_blocklist_token("marveen handles routing"))
        self.assertFalse(dt.contains_blocklist_token("no token here"))


# ---------------------------------------------------------------------------
# partial_rewrite() -- the 'mixed'-row per-occurrence path (card ec4a775e).
# Protected spans (blocklist / M3 historical / provenance sentinel) stay
# verbatim; everything else gets the M1 path + case-preserving bare rewrite.
# NOT wired into classify/apply (those stay fail-closed).
# ---------------------------------------------------------------------------
class PartialRewriteTests(unittest.TestCase):
    def test_mixed_row_rewrites_bare_keeps_blocklist(self):
        new, v = dt.partial_rewrite("marveen handles X via com.marveen.channels")
        self.assertEqual(new, "noa handles X via com.marveen.channels")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.tag, "mixed-partial")
        self.assertEqual(v.new_value, "noa handles X via com.marveen.channels")

    def test_m1_path_and_blocklist_in_one_row(self):
        new, v = dt.partial_rewrite(
            "/home/domin/marveen/x references com.marveen.channels"
        )
        self.assertEqual(
            new, "/home/domin/noa/x references com.marveen.channels"
        )
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.tag, "mixed-partial")
        self.assertIn("com.marveen.channels", new)

    def test_m3_span_preserved_inside_partial(self):
        new, v = dt.partial_rewrite("marveen runs X, formerly marveen")
        self.assertEqual(new, "noa runs X, formerly marveen")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertTrue(v.needs_glance)

    def test_pure_blocklist_row_refuses_unchanged(self):
        new, v = dt.partial_rewrite("com.marveen.channels")
        self.assertEqual(new, "com.marveen.channels")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "coordinated-infra")

    def test_pure_m3_row_refuses_unchanged(self):
        new, v = dt.partial_rewrite("formerly marveen")
        self.assertEqual(new, "formerly marveen")
        self.assertEqual(v.action, dt.REFUSE)
        self.assertEqual(v.tag, "coordinated-infra")

    def test_case_preservation_outside_protected(self):
        new, v = dt.partial_rewrite("Marveen handles routing")
        self.assertEqual(new, "Noa handles routing")
        self.assertEqual(v.action, dt.REWRITE)

    def test_provenance_sentinel_span_preserved(self):
        new, v = dt.partial_rewrite(
            "marveen is live but marveen<!--debrand:keep--> stays"
        )
        self.assertEqual(
            new, "noa is live but marveen<!--debrand:keep--> stays"
        )
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.tag, "mixed-partial")


# ---------------------------------------------------------------------------
# Thor M1+M3 fold-forward: an M1 path rewrite in _classify_memory must set
# needs_glance when a residual M3 historical token remains in the new value.
# ---------------------------------------------------------------------------
class M1ResidualM3Tests(unittest.TestCase):
    def test_m1_path_with_residual_m3_needs_glance(self):
        v = dt.classify(
            "/home/domin/marveen/x, formerly marveen", context="memory"
        )
        self.assertEqual(v.action, dt.REWRITE)
        self.assertEqual(v.new_value, "/home/domin/noa/x, formerly marveen")
        self.assertTrue(v.needs_glance)

    def test_m1_path_without_m3_no_glance(self):
        v = dt.classify("/home/domin/marveen/store", context="memory")
        self.assertEqual(v.action, dt.REWRITE)
        self.assertFalse(v.needs_glance)


if __name__ == "__main__":
    unittest.main()
