#!/usr/bin/env python3
"""Tests for scripts/gen-provisioning-manifest.py (migration GAP G3).

The provisioning manifest is the migration recreate source-of-truth. Its one
hard invariant: persona-only agents (identity only in agents/<id>/CLAUDE.md, no
agent-config.json) MUST appear in the manifest and MUST NOT be silently dropped.

Covered here:
  - discover_persona_sources reads CLAUDE.md personas from an injected dir
  - parse_claude_display extracts the display name from the H1 (with/without "(id)")
  - build_manifest (PURE) folds config + persona + live sources into one list
  - GAP G3 invariant: persona-only agents are present with has_config=False
  - each record carries every required field (agent_id/display/model/channel/
    role/has_config/store_size/persona_source)
  - store_size is injected (store_sizer callable) -> no live `du`
  - render_table / render_json are deterministic and surface persona-only agents
  - graceful: missing dir, empty inputs do not raise
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
SCRIPTS = HERE.parent
GEN_MOD = SCRIPTS / "gen-provisioning-manifest.py"


def _load_gen():
    spec = importlib.util.spec_from_file_location("gen_provisioning_manifest", str(GEN_MOD))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _write_config(root: Path, agent_id: str, cfg: dict) -> None:
    d = root / "agents" / agent_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "agent-config.json").write_text(json.dumps(cfg), encoding="utf-8")


def _write_claude(root: Path, agent_id: str, text: str) -> None:
    d = root / "agents" / agent_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "CLAUDE.md").write_text(text, encoding="utf-8")


def _fixture_tree(root: Path) -> None:
    """A config agent (dave), a config+claude agent (bond), and two PERSONA-ONLY
    agents (hibiki with Telegram persona, kerrigan without a channel)."""
    (root / "agent-config.json").write_text(
        json.dumps({"model": "claude-opus-4-8", "displayName": "NoA"}), encoding="utf-8"
    )
    _write_config(root, "dave", {
        "model": "claude-opus-4-8", "displayName": "Dave", "channelProvider": "",
        "team": {"role": "leader", "reportsTo": None},
    })
    _write_config(root, "bond", {
        "model": "claude-sonnet-4-6", "displayName": "Bond", "channelProvider": "telegram",
        "team": {"role": "member", "reportsTo": "marveen"},
    })
    _write_claude(root, "bond", "# Bond\n\nYou are Bond.\n")
    # Persona-only agents -- NO agent-config.json.
    _write_claude(
        root, "hibiki",
        "# Hibiki\n\nTe Hibiki vagy, Dominik edzo agense. Telegram-on kommunikalsz.\n",
    )
    _write_claude(
        root, "blackbart",
        "# Black Bart (blackbart)\n\nTe Black Bart vagy, a flotta PM agense.\n",
    )


class TestParseClaudeDisplay(unittest.TestCase):
    def setUp(self):
        self.mod = _load_gen()

    def test_h1_plain(self):
        self.assertEqual(self.mod.parse_claude_display("# Hibiki\n\nbody"), "Hibiki")

    def test_h1_with_parenthetical_id(self):
        self.assertEqual(
            self.mod.parse_claude_display("# Black Bart (blackbart)\n\nbody"),
            "Black Bart",
        )

    def test_no_h1_returns_none(self):
        self.assertIsNone(self.mod.parse_claude_display("no heading here"))


class TestDiscoverPersonaSources(unittest.TestCase):
    def setUp(self):
        self.mod = _load_gen()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _fixture_tree(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_lists_claude_md_agents(self):
        personas = self.mod.discover_persona_sources(str(self.root))
        self.assertIn("hibiki", personas)
        self.assertIn("blackbart", personas)
        self.assertIn("bond", personas)       # config agent that also has CLAUDE.md
        self.assertNotIn("dave", personas)    # dave has no CLAUDE.md in fixture

    def test_display_and_channel_inferred(self):
        personas = self.mod.discover_persona_sources(str(self.root))
        self.assertEqual(personas["hibiki"]["display"], "Hibiki")
        self.assertEqual(personas["hibiki"]["channel"], "telegram")
        self.assertEqual(personas["blackbart"]["display"], "Black Bart")
        self.assertEqual(personas["blackbart"]["channel"], "")

    def test_missing_dir_returns_empty_no_raise(self):
        self.assertEqual(self.mod.discover_persona_sources("/nonexistent/xyz"), {})


class TestBuildManifestInvariant(unittest.TestCase):
    """The GAP G3 core: persona-only agents are never dropped."""

    def setUp(self):
        self.mod = _load_gen()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _fixture_tree(self.root)
        self.config_agents = self.mod.load_config_agents(str(self.root))
        self.personas = self.mod.discover_persona_sources(str(self.root))

    def tearDown(self):
        self.tmp.cleanup()

    def _records(self, live):
        return self.mod.build_manifest(
            self.config_agents, self.personas, live, store_sizer=lambda aid: ""
        )

    def test_persona_only_agents_present(self):
        records = self._records(live=set())
        by_id = {r["agent_id"]: r for r in records}
        # Persona-only agents MUST be in the manifest.
        self.assertIn("hibiki", by_id)
        self.assertIn("blackbart", by_id)
        # ...marked as NO config, recoverable from CLAUDE.md.
        self.assertFalse(by_id["hibiki"]["has_config"])
        self.assertEqual(by_id["hibiki"]["persona_source"], self.mod.SRC_CLAUDE_ONLY)
        self.assertFalse(by_id["blackbart"]["has_config"])

    def test_persona_only_not_dropped_even_without_live_session(self):
        # No live sessions at all -> persona-only agents still enumerated purely
        # from their CLAUDE.md. This is the silent-drop regression guard.
        records = self._records(live=set())
        ids = {r["agent_id"] for r in records}
        self.assertTrue({"hibiki", "blackbart"}.issubset(ids))

    def test_config_agents_marked_config_source(self):
        records = self._records(live=set())
        by_id = {r["agent_id"]: r for r in records}
        self.assertTrue(by_id["dave"]["has_config"])
        self.assertEqual(by_id["dave"]["persona_source"], self.mod.SRC_CONFIG)
        # bond has both a config and a CLAUDE.md.
        self.assertTrue(by_id["bond"]["has_config"])
        self.assertEqual(by_id["bond"]["persona_source"], self.mod.SRC_CONFIG_CLAUDE)

    def test_live_session_only_agent_surfaced(self):
        # An id present ONLY in tmux (no config, no CLAUDE.md) must still land in
        # the manifest as live-session-only -- loudest do-not-drop case.
        records = self._records(live={"ghostrunner"})
        by_id = {r["agent_id"]: r for r in records}
        self.assertIn("ghostrunner", by_id)
        self.assertFalse(by_id["ghostrunner"]["has_config"])
        self.assertEqual(by_id["ghostrunner"]["persona_source"], self.mod.SRC_LIVE_ONLY)
        self.assertTrue(by_id["ghostrunner"]["live"])

    def test_every_record_has_required_fields(self):
        required = {
            "agent_id", "display", "model", "channel", "role",
            "has_config", "store_size", "persona_source",
        }
        for r in self._records(live={"dave"}):
            self.assertTrue(required.issubset(r.keys()), f"missing fields in {r}")

    def test_display_falls_back_to_claude_h1(self):
        records = self._records(live=set())
        by_id = {r["agent_id"]: r for r in records}
        self.assertEqual(by_id["hibiki"]["display"], "Hibiki")
        self.assertEqual(by_id["blackbart"]["display"], "Black Bart")

    def test_store_sizer_injected(self):
        records = self.mod.build_manifest(
            self.config_agents, self.personas, set(),
            store_sizer=lambda aid: "64M" if aid == "hibiki" else "",
        )
        by_id = {r["agent_id"]: r for r in records}
        self.assertEqual(by_id["hibiki"]["store_size"], "64M")
        self.assertEqual(by_id["dave"]["store_size"], "")

    def test_records_sorted_by_id(self):
        records = self._records(live=set())
        ids = [r["agent_id"] for r in records]
        self.assertEqual(ids, sorted(ids))


class TestRender(unittest.TestCase):
    def setUp(self):
        self.mod = _load_gen()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _fixture_tree(self.root)
        self.records = self.mod.build_manifest(
            self.mod.load_config_agents(str(self.root)),
            self.mod.discover_persona_sources(str(self.root)),
            {"dave", "hibiki"},
            store_sizer=lambda aid: "64M" if aid == "hibiki" else "",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_table_surfaces_persona_only(self):
        out = self.mod.render_table(self.records)
        self.assertIn("Persona-only agents", out)
        self.assertIn("hibiki", out)
        self.assertIn("blackbart", out)
        # has_config=NO must be visible for a persona-only row.
        hibiki_line = next(l for l in out.splitlines() if l.startswith("| hibiki "))
        self.assertIn("NO", hibiki_line)

    def test_table_deterministic(self):
        a = self.mod.render_table(self.records)
        b = self.mod.render_table(self.records)
        self.assertEqual(a, b)

    def test_json_manifest_valid_and_counts(self):
        out = self.mod.render_json(self.records)
        data = json.loads(out)
        self.assertEqual(data["schema"], "fleet-provisioning-manifest/v1")
        self.assertEqual(data["total"], len(self.records))
        n_persona = sum(1 for r in self.records if not r["has_config"])
        self.assertEqual(data["persona_only"], n_persona)
        self.assertGreaterEqual(n_persona, 2)  # hibiki + blackbart at least
        # Persona-only agents present in the JSON agents list too.
        json_ids = {a["agent_id"] for a in data["agents"]}
        self.assertTrue({"hibiki", "blackbart"}.issubset(json_ids))

    def test_json_deterministic(self):
        self.assertEqual(
            self.mod.render_json(self.records), self.mod.render_json(self.records)
        )


class TestGraceful(unittest.TestCase):
    def test_empty_inputs_no_raise(self):
        mod = _load_gen()
        records = mod.build_manifest([], {}, set(), store_sizer=lambda aid: "")
        self.assertEqual(records, [])
        out = mod.render_table(records)
        self.assertIn("Persona-only agents", out)
        data = json.loads(mod.render_json(records))
        self.assertEqual(data["total"], 0)


if __name__ == "__main__":
    unittest.main()
