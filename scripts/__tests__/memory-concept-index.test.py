#!/usr/bin/env python3
"""Acceptance tests for scripts/memory-concept-index.py.

Runs the compile-phase concept indexer over a tiny temp fixture vault and
asserts the emitted index structure: concept counts, source attribution,
co-occurrence, the importable build_index() contract, and the --root/--out CLI.

Run: python3 scripts/__tests__/memory-concept-index.test.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "memory-concept-index.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("memory_concept_index", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _make_vault(root: Path) -> None:
    """Build a tiny fixture vault under ``root``."""
    (root / "MEMORY.md").write_text(
        "# Memory Index\n"
        "The telegram watchdog recovers the telegram pipe. "
        "telegram telegram watchdog.\n",
        encoding="utf-8",
    )
    mem = root / "memory"
    daily = mem / "daily-log"
    daily.mkdir(parents=True)
    (daily / "2026-06-11.md").write_text(
        "Today the telegram watchdog fired. The deploy succeeded. "
        "deploy deploy verify.\n",
        encoding="utf-8",
    )
    (mem / "topic-deploy.md").write_text(
        "Deploy notes: deploy the dashboard, then verify. "
        "deploy verify verify.\n",
        encoding="utf-8",
    )
    # Noise file with a fenced code block that must be ignored.
    (mem / "code-snippet.md").write_text(
        "Example:\n```python\nzzzcodeword = 1\nzzzcodeword += zzzcodeword\n```\n"
        "prose mentions deploy once.\n",
        encoding="utf-8",
    )


class BuildIndexStructureTests(unittest.TestCase):
    def setUp(self):
        self.mod = _load_module()
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        _make_vault(self.root)
        self.index = self.mod.build_index(self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def test_top_level_keys(self):
        for key in ("generated_at", "root", "file_count", "concepts", "cooccurrence"):
            self.assertIn(key, self.index)
        self.assertIsInstance(self.index["concepts"], dict)
        self.assertIsInstance(self.index["cooccurrence"], dict)

    def test_file_count(self):
        # 4 non-empty fixture files were scanned.
        self.assertEqual(self.index["file_count"], 4)

    def test_concept_entry_shape(self):
        for name, entry in self.index["concepts"].items():
            self.assertIsInstance(name, str)
            self.assertIn("count", entry)
            self.assertIn("sources", entry)
            self.assertIsInstance(entry["count"], int)
            self.assertIsInstance(entry["sources"], list)
            self.assertEqual(entry["sources"], sorted(entry["sources"]))

    def test_salient_concepts_present(self):
        concepts = self.index["concepts"]
        self.assertIn("deploy", concepts)
        self.assertIn("telegram", concepts)
        # "deploy" appears in multiple files -> count should exceed single occ.
        self.assertGreaterEqual(concepts["deploy"]["count"], 4)

    def test_sources_are_relative_and_attributed(self):
        deploy_sources = self.index["concepts"]["deploy"]["sources"]
        # deploy appears in the daily log, the topic file, and the snippet prose.
        self.assertIn(os.path.join("memory", "topic-deploy.md"), deploy_sources)
        self.assertIn(
            os.path.join("memory", "daily-log", "2026-06-11.md"), deploy_sources
        )
        # telegram is attributed to MEMORY.md (root-level).
        self.assertIn("MEMORY.md", self.index["concepts"]["telegram"]["sources"])

    def test_code_fence_ignored(self):
        # The fenced code word must NOT leak into the concept index.
        self.assertNotIn("zzzcodeword", self.index["concepts"])

    def test_stopwords_excluded(self):
        for sw in ("the", "then", "this"):
            self.assertNotIn(sw, self.index["concepts"])

    def test_cooccurrence_pairs_well_formed(self):
        for pair, n in self.index["cooccurrence"].items():
            self.assertIn("|", pair)
            a, b = pair.split("|", 1)
            self.assertLess(a, b)  # lexically ordered
            self.assertIn(a, self.index["concepts"])
            self.assertIn(b, self.index["concepts"])
            self.assertIsInstance(n, int)
            self.assertGreaterEqual(n, 1)

    def test_cooccurrence_captures_same_file_pair(self):
        # deploy + verify co-occur in topic-deploy.md and the daily log.
        key = "|".join(sorted(["deploy", "verify"]))
        self.assertIn(key, self.index["cooccurrence"])
        self.assertGreaterEqual(self.index["cooccurrence"][key], 1)


class EmptyVaultTests(unittest.TestCase):
    def test_missing_vault_is_safe(self):
        mod = _load_module()
        with tempfile.TemporaryDirectory() as d:
            empty = Path(d) / "nope"  # does not exist
            index = mod.build_index(empty)
            self.assertEqual(index["file_count"], 0)
            self.assertEqual(index["concepts"], {})
            self.assertEqual(index["cooccurrence"], {})


class CliTests(unittest.TestCase):
    def test_cli_writes_valid_json(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "vault"
            root.mkdir()
            _make_vault(root)
            out = Path(d) / "sub" / "concept-index.json"
            r = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(root), "--out", str(out)],
                capture_output=True, text=True,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(out.exists())
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertIn("deploy", data["concepts"])
            self.assertEqual(data["file_count"], 4)
            self.assertIn("concept-index:", r.stdout)


if __name__ == "__main__":
    if not SCRIPT.exists():
        print(f"SKIP: {SCRIPT} not found")
        sys.exit(0)
    unittest.main(verbosity=2)
