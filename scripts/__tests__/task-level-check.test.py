#!/usr/bin/env python3
"""Acceptance tests for scripts/task-level-check.py (card 6fd1e40c / OPS-336).

Spec: store/plan-fleet-model-tiering-2026-11-17.md section 3 (task-level L0/L1/L2
thresholds) + section 4.A (heartbeat-preflight integration, steps 4-5).

KEY DESIGN CONSTRAINT (forge dispatch, plan section 1): the verdict is
VERDICT-ONLY. task_level_check() classifies L0/L1/L2 but NEVER switches the
model -- the Opus (L2) promotion is Boss-gated and manual. So auto_switch MUST
be False on every verdict, including an L2 one. The adversarial direction the
tests must exercise is "did an L2 verdict silently imply an escalation?".

Run: python3 scripts/__tests__/task-level-check.test.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(_HERE, "..", "task-level-check.py")

# Load the hyphenated module file by path.
_spec = importlib.util.spec_from_file_location("task_level_check", _SCRIPT)
tlc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tlc)


class ClassifyTaskLevel(unittest.TestCase):
    def test_quiet_tick_is_L0(self):
        self.assertEqual(tlc.classify_task_level(), "L0")

    def test_in_progress_card_is_L1(self):
        self.assertEqual(tlc.classify_task_level(in_progress_count=1), "L1")

    def test_boss_dm_is_L1(self):
        self.assertEqual(tlc.classify_task_level(has_boss_dm=True), "L1")

    def test_inter_agent_task_is_L1(self):
        self.assertEqual(tlc.classify_task_level(has_inter_agent_task=True), "L1")

    def test_scheduled_task_type_task_is_L1(self):
        self.assertEqual(tlc.classify_task_level(scheduled_task_type="task"), "L1")

    def test_scheduled_heartbeat_is_L0(self):
        # a heartbeat-type scheduled trigger is NOT a task trigger (section 3 L0)
        self.assertEqual(tlc.classify_task_level(scheduled_task_type="heartbeat"), "L0")

    def test_explicit_opus_go_is_L2(self):
        self.assertEqual(tlc.classify_task_level(explicit_opus_go=True), "L2")

    def test_explicit_opus_go_overrides_quiet(self):
        # L2 is explicit-only; with no other signal an Opus GO still yields L2
        self.assertEqual(
            tlc.classify_task_level(explicit_opus_go=True, in_progress_count=0), "L2"
        )

    def test_any_trigger_beats_L0(self):
        self.assertEqual(
            tlc.classify_task_level(in_progress_count=0, has_inter_agent_task=True),
            "L1",
        )

    def test_zero_in_progress_is_L0(self):
        self.assertEqual(tlc.classify_task_level(in_progress_count=0), "L0")


class ModelTier(unittest.TestCase):
    def test_haiku_is_tier0(self):
        self.assertEqual(tlc.model_tier("claude-haiku-5-5"), 0)

    def test_sonnet_is_tier1(self):
        self.assertEqual(tlc.model_tier("claude-sonnet-4-6"), 1)

    def test_opus_is_tier2(self):
        self.assertEqual(tlc.model_tier("claude-opus-4-8"), 2)

    def test_bare_aliases(self):
        self.assertEqual(tlc.model_tier("haiku"), 0)
        self.assertEqual(tlc.model_tier("sonnet"), 1)
        self.assertEqual(tlc.model_tier("opus"), 2)

    def test_unknown_defaults_to_sonnet_tier(self):
        self.assertEqual(tlc.model_tier("gpt-whatever"), 1)
        self.assertEqual(tlc.model_tier(None), 1)
        self.assertEqual(tlc.model_tier(""), 1)


class TaskLevelCheckVerdict(unittest.TestCase):
    def test_auto_switch_always_false(self):
        # KEY CONSTRAINT: verdict-only. No level/model combination may set it True.
        for kwargs in (
            {},  # L0
            {"in_progress_count": 1},  # L1
            {"explicit_opus_go": True},  # L2
            {"explicit_opus_go": True, "current_model": "claude-sonnet-4-6"},
            {"current_model": "claude-opus-4-8", "in_progress_count": 3},
        ):
            v = tlc.task_level_check("dave", **kwargs)
            self.assertFalse(v["auto_switch"], f"auto_switch must be False for {kwargs}")

    def test_L2_verdict_does_not_imply_escalation(self):
        # Adversarial: an L2 verdict must NOT carry any switch/escalation signal.
        v = tlc.task_level_check("forge", explicit_opus_go=True,
                                 current_model="claude-sonnet-4-6")
        self.assertEqual(v["level"], "L2")
        self.assertFalse(v["auto_switch"])
        # current_model is reported unchanged; eligibility is advisory only
        self.assertEqual(v["current_model"], "claude-sonnet-4-6")

    def test_advisory_on_L0_running_above_haiku(self):
        # Spec step 5: L0 task on a >Haiku model -> advisory (log), never a switch.
        v = tlc.task_level_check("dave", current_model="claude-opus-4-8")
        self.assertEqual(v["level"], "L0")
        self.assertIsNotNone(v["advisory"])
        self.assertFalse(v["auto_switch"])

    def test_no_advisory_on_L0_haiku(self):
        v = tlc.task_level_check("applegate", current_model="claude-haiku-5-5")
        self.assertEqual(v["level"], "L0")
        self.assertIsNone(v["advisory"])

    def test_no_advisory_on_L1_opus(self):
        # A default-Opus agent (dave) on real L1 work is legitimate -- not flagged.
        v = tlc.task_level_check("dave", current_model="claude-opus-4-8",
                                 in_progress_count=2)
        self.assertEqual(v["level"], "L1")
        self.assertIsNone(v["advisory"])

    def test_verdict_shape(self):
        v = tlc.task_level_check("dave", current_model="claude-opus-4-8")
        for key in ("agent", "level", "level_tier", "current_model",
                    "current_tier", "advisory", "auto_switch"):
            self.assertIn(key, v)
        self.assertEqual(v["agent"], "dave")


class ReadConfigModel(unittest.TestCase):
    def test_direct_dir(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "agents", "foo"))
            with open(os.path.join(d, "agents", "foo", "agent-config.json"), "w") as f:
                json.dump({"model": "claude-sonnet-4-6"}, f)
            self.assertEqual(tlc._read_config_model("foo", root=d), "claude-sonnet-4-6")

    def test_local_suffix_fallback(self):
        # MAIN_AGENT_ID 'marveen' lives in the 'marveen-local' dir.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "agents", "marveen-local"))
            with open(os.path.join(d, "agents", "marveen-local", "agent-config.json"), "w") as f:
                json.dump({"model": "claude-opus-4-8-1m"}, f)
            self.assertEqual(tlc._read_config_model("marveen", root=d), "claude-opus-4-8-1m")

    def test_missing_returns_none(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(tlc._read_config_model("nope", root=d))


class CliSmoke(unittest.TestCase):
    """Hermetic CLI: pass signals via flags so no live kanban/network query runs."""

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, _SCRIPT, *args],
            capture_output=True, text=True, timeout=30,
        )

    def test_cli_quiet_tick_exit0_and_L0(self):
        p = self._run("dave", "--in-progress", "0", "--model", "claude-opus-4-8")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("VERDICT", p.stdout)
        self.assertIn("L0", p.stdout)

    def test_cli_json_is_parseable_and_verdict_only(self):
        p = self._run("dave", "--in-progress", "0", "--model", "claude-opus-4-8",
                      "--json")
        self.assertEqual(p.returncode, 0, p.stderr)
        obj = json.loads(p.stdout)
        self.assertEqual(obj["level"], "L0")
        self.assertFalse(obj["auto_switch"])
        self.assertIsNotNone(obj["advisory"])  # L0 on opus -> advisory

    def test_cli_opus_go_is_L2_but_exit0(self):
        # Even an L2 verdict is advisory -- the CLI never fails the heartbeat.
        p = self._run("forge", "--in-progress", "0", "--model",
                      "claude-sonnet-4-6", "--opus-go", "--json")
        self.assertEqual(p.returncode, 0, p.stderr)
        obj = json.loads(p.stdout)
        self.assertEqual(obj["level"], "L2")
        self.assertFalse(obj["auto_switch"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
