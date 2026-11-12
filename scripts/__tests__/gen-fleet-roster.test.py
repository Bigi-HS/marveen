#!/usr/bin/env python3
"""Tests for scripts/gen-fleet-roster.py (card aeea36ee).

The generator enumerates the LIVE fleet from agent-config.json files, cross-
references the tmux session list to mark live/offline, groups agents, reconciles
the "config vs live" discrepancy, and renders a deterministic markdown roster.

Covered here:
  - load_agents reads configs from an injected dir (fixtures, no live FS dep)
  - grouping: orchestrator / core-eng / qa / channel / local buckets
  - live/offline marking from an injected tmux session list (no live tmux)
  - determinism: render_roster is byte-identical across two runs
  - reconcile section: live-tmux-without-config personas are surfaced, not dropped
  - both counts (configs, live sessions) are surfaced
  - graceful handling: missing dir / empty inputs do not raise
"""
import importlib.util
import os
import tempfile
import json
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


def _fixture_tree(root: Path) -> None:
    # Root config = main orchestrator (marveen), minimal schema.
    (root / "agent-config.json").write_text(
        json.dumps({"model": "claude-opus-4-8", "displayName": "NoA"}), encoding="utf-8"
    )
    _write_config(root, "dave", {
        "model": "claude-opus-4-8", "displayName": "Dave", "channelProvider": "telegram",
        "team": {"role": "leader", "reportsTo": None, "delegatesTo": ["blackbeard"]},
    })
    _write_config(root, "blackbeard", {
        "model": "claude-sonnet-4-6", "displayName": "Blackbeard",
        "team": {"role": "member", "reportsTo": "dave"},
    })
    _write_config(root, "thor", {
        "model": "claude-sonnet-4-6", "displayName": "Thor", "channelProvider": "telegram",
        "team": {"role": "leader", "reportsTo": None},
    })
    _write_config(root, "avery", {
        "model": "claude-sonnet-4-6", "displayName": "Avery",
        "team": {"role": "member", "reportsTo": "thor"},
    })
    _write_config(root, "bond", {
        "model": "claude-sonnet-4-6", "displayName": "Bond", "channelProvider": "telegram",
        "team": {"role": "member", "reportsTo": "marveen"},
    })
    _write_config(root, "marveen-local", {
        "model": "qwen3:4b", "displayName": "NoA (local)",
        "team": {"role": "worker", "reportsTo": "marveen"},
    })


class TestLoadAgents(unittest.TestCase):
    def test_reads_root_and_sub_configs(self):
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _fixture_tree(root)
            agents = mod.load_agents(str(root))
            ids = {a["id"] for a in agents}
            self.assertIn("marveen", ids)   # root config -> main agent id
            self.assertIn("dave", ids)
            self.assertIn("blackbeard", ids)
            self.assertIn("bond", ids)

    def test_missing_dir_returns_empty_no_raise(self):
        mod = _load_gen()
        agents = mod.load_agents("/nonexistent/path/xyz")
        self.assertEqual(agents, [])

    def test_malformed_config_skipped_not_raised(self):
        mod = _load_gen()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _fixture_tree(root)
            bad = root / "agents" / "broken"
            bad.mkdir(parents=True)
            (bad / "agent-config.json").write_text("{ not json", encoding="utf-8")
            agents = mod.load_agents(str(root))
            ids = {a["id"] for a in agents}
            self.assertNotIn("broken", ids)
            self.assertIn("dave", ids)  # others still load


class TestGrouping(unittest.TestCase):
    def setUp(self):
        self.mod = _load_gen()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _fixture_tree(self.root)
        self.agents = self.mod.load_agents(str(self.root))

    def tearDown(self):
        self.tmp.cleanup()

    def _group_of(self, agent_id):
        groups = self.mod.group_agents(self.agents)
        for gname, members in groups:
            if any(a["id"] == agent_id for a in members):
                return gname
        return None

    def test_orchestrator_group(self):
        self.assertEqual(self._group_of("marveen"), self.mod.G_ORCHESTRATOR)

    def test_core_engineering_group(self):
        self.assertEqual(self._group_of("dave"), self.mod.G_CORE_ENG)
        self.assertEqual(self._group_of("blackbeard"), self.mod.G_CORE_ENG)

    def test_qa_group(self):
        self.assertEqual(self._group_of("thor"), self.mod.G_QA)
        self.assertEqual(self._group_of("avery"), self.mod.G_QA)

    def test_channel_group(self):
        self.assertEqual(self._group_of("bond"), self.mod.G_CHANNEL)

    def test_local_group(self):
        self.assertEqual(self._group_of("marveen-local"), self.mod.G_LOCAL)


class TestLiveMarking(unittest.TestCase):
    def setUp(self):
        self.mod = _load_gen()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _fixture_tree(self.root)
        self.agents = self.mod.load_agents(str(self.root))

    def tearDown(self):
        self.tmp.cleanup()

    def test_live_and_offline_marking(self):
        live = {"dave", "thor"}  # only these have tmux sessions
        out = self.mod.render_roster(self.agents, live)
        # dave live, blackbeard offline
        self.assertIn("dave", out)
        # The live/offline marker must distinguish the two.
        dave_line = next(l for l in out.splitlines() if l.startswith("| dave "))
        bb_line = next(l for l in out.splitlines() if l.startswith("| blackbeard "))
        self.assertIn(self.mod.LIVE_MARK, dave_line)
        self.assertIn(self.mod.OFFLINE_MARK, bb_line)

    def test_parse_tmux_sessions(self):
        sample = (
            "agent-dave: 1 windows (created ...)\n"
            "agent-thor: 1 windows (created ...)\n"
            "boss: 1 windows (created ...)\n"
            "noa-sandbox: 1 windows\n"
        )
        live = self.mod.parse_tmux_sessions(sample)
        self.assertEqual(live, {"dave", "thor"})

    def test_parse_tmux_maps_main_channel_session_to_marveen(self):
        # The main orchestrator runs as `marveen-channels`, not `agent-marveen`.
        sample = (
            "agent-dave: 1 windows\n"
            "marveen-channels: 1 windows\n"
        )
        live = self.mod.parse_tmux_sessions(sample)
        self.assertEqual(live, {"dave", "marveen"})


class TestReconcile(unittest.TestCase):
    def setUp(self):
        self.mod = _load_gen()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _fixture_tree(self.root)
        self.agents = self.mod.load_agents(str(self.root))

    def tearDown(self):
        self.tmp.cleanup()

    def test_non_config_live_agents_surfaced(self):
        # 'hibiki' is live in tmux but has no agent-config -> must appear in a
        # reconcile section, never silently dropped.
        live = {"dave", "hibiki"}
        out = self.mod.render_roster(self.agents, live)
        self.assertIn("hibiki", out)
        self.assertIn(self.mod.RECONCILE_HEADING, out)

    def test_both_counts_surfaced(self):
        live = {"dave", "hibiki"}
        out = self.mod.render_roster(self.agents, live)
        n_configs = len(self.agents)
        # live agent-* sessions that correspond to configs OR not
        self.assertIn(str(n_configs), out)
        # The live session count (2) must appear too.
        self.assertIn("2", out)


class TestDeterminism(unittest.TestCase):
    def setUp(self):
        self.mod = _load_gen()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _fixture_tree(self.root)
        self.agents = self.mod.load_agents(str(self.root))

    def tearDown(self):
        self.tmp.cleanup()

    def test_idempotent_output(self):
        live = {"dave", "thor", "hibiki"}
        a = self.mod.render_roster(self.agents, live)
        b = self.mod.render_roster(self.agents, live)
        self.assertEqual(a, b)

    def test_live_set_order_irrelevant(self):
        # A set has no order; passing a list in different order must not matter.
        a = self.mod.render_roster(self.agents, ["dave", "thor"])
        b = self.mod.render_roster(self.agents, ["thor", "dave"])
        self.assertEqual(a, b)

    def test_agent_order_within_group_is_sorted(self):
        out = self.mod.render_roster(self.agents, set())
        # Within core-eng, blackbeard should be listed after dave is not
        # guaranteed by name; but sub-agents are name-sorted. Assert the two
        # core-eng ids appear in a stable (sorted) relative order.
        idx_bb = out.index("| blackbeard ")
        idx_dave = out.index("| dave ")
        # dave (leader) is pinned before its name-sorted members.
        self.assertLess(idx_dave, idx_bb)


class TestGraceful(unittest.TestCase):
    def test_empty_agents_renders_header_no_raise(self):
        mod = _load_gen()
        out = mod.render_roster([], set())
        self.assertTrue(out.strip())
        self.assertIn(mod.RECONCILE_HEADING, out)


if __name__ == "__main__":
    unittest.main()
