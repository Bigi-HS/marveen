#!/usr/bin/env python3
"""Acceptance tests for scripts/concept-lookup.py.

Covers:
  - ranked lookup (count desc, name tie-break, case-insensitive substring)
  - related-concept discovery (shared source files, shared-count ranking)
  - empty / no-match behaviour
  - the CLI surface (--index, --json, exit codes)

Hermetic: every test builds a tiny temp index json. Pure stdlib.

Run: python3 scripts/__tests__/concept-lookup.test.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(_HERE, "..", "concept-lookup.py")


def _load_module():
    spec = importlib.util.spec_from_file_location("concept_lookup", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cl = _load_module()


SAMPLE = {
    "watchdog": {"count": 7, "sources": ["a.md", "b.md"]},
    "memory tiering": {"count": 12, "sources": ["a.md", "c.md"]},
    "memory autoinject": {"count": 3, "sources": ["a.md"]},
    "watchdog respawn": {"count": 7, "sources": ["b.md", "d.md"]},
    "telegram pipe": {"count": 9, "sources": ["e.md"]},
}


def _write_index(data):
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return path


class LookupTest(unittest.TestCase):
    def test_ranked_by_count_desc(self):
        res = cl.lookup(SAMPLE, "memory")
        self.assertEqual([r["concept"] for r in res],
                         ["memory tiering", "memory autoinject"])
        self.assertEqual(res[0]["count"], 12)

    def test_name_tiebreak_on_equal_count(self):
        # both count 7 -> alphabetical
        res = cl.lookup(SAMPLE, "watchdog")
        self.assertEqual([r["concept"] for r in res],
                         ["watchdog", "watchdog respawn"])

    def test_case_insensitive_substring(self):
        res = cl.lookup(SAMPLE, "TELEGRAM")
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["concept"], "telegram pipe")

    def test_no_match(self):
        self.assertEqual(cl.lookup(SAMPLE, "nonexistent"), [])

    def test_empty_query_matches_all(self):
        res = cl.lookup(SAMPLE, "")
        self.assertEqual(len(res), len(SAMPLE))
        # still sorted by count desc
        counts = [r["count"] for r in res]
        self.assertEqual(counts, sorted(counts, reverse=True))


class RelatedTest(unittest.TestCase):
    def test_shares_source_file(self):
        # "watchdog" sources a.md,b.md
        rel = cl.related_concepts(SAMPLE, "watchdog")
        names = [r["concept"] for r in rel]
        # shares a.md: memory tiering, memory autoinject; shares b.md: watchdog respawn
        self.assertIn("memory tiering", names)
        self.assertIn("watchdog respawn", names)
        self.assertIn("memory autoinject", names)
        self.assertNotIn("telegram pipe", names)  # no shared source
        self.assertNotIn("watchdog", names)  # excludes self

    def test_ranked_by_shared_count_then_count(self):
        rel = cl.related_concepts(SAMPLE, "watchdog")
        # all share exactly 1 source with watchdog -> rank by count desc
        self.assertEqual(rel[0]["shared_count"], 1)
        self.assertEqual(rel[0]["concept"], "memory tiering")  # count 12, highest

    def test_isolated_concept_has_no_related(self):
        self.assertEqual(cl.related_concepts(SAMPLE, "telegram pipe"), [])

    def test_absent_concept(self):
        self.assertEqual(cl.related_concepts(SAMPLE, "ghost"), [])

    def test_shared_count_ranking(self):
        idx = {
            "root": {"count": 1, "sources": ["x.md", "y.md", "z.md"]},
            "two": {"count": 1, "sources": ["x.md", "y.md"]},
            "one": {"count": 99, "sources": ["z.md"]},
        }
        rel = cl.related_concepts(idx, "root")
        # "two" shares 2 sources, beats "one" (shares 1) despite lower count
        self.assertEqual(rel[0]["concept"], "two")
        self.assertEqual(rel[0]["shared_count"], 2)


class LoadAndCombineTest(unittest.TestCase):
    def test_load_index_roundtrip(self):
        path = _write_index(SAMPLE)
        try:
            idx = cl.load_index(path)
            self.assertEqual(idx, SAMPLE)
        finally:
            os.unlink(path)

    def test_load_rejects_non_object(self):
        path = _write_index([1, 2, 3])
        try:
            with self.assertRaises(ValueError):
                cl.load_index(path)
        finally:
            os.unlink(path)

    def test_lookup_with_related_top_match(self):
        out = cl.lookup_with_related(SAMPLE, "memory")
        self.assertEqual(out["matches"][0]["concept"], "memory tiering")
        rel_names = [r["concept"] for r in out["related"]]
        # memory tiering sources a.md,c.md -> shares a.md with watchdog/memory autoinject
        self.assertIn("watchdog", rel_names)

    def test_malformed_entry_tolerated(self):
        idx = {
            "good": {"count": 5, "sources": ["a.md"]},
            "no_count": {"sources": ["a.md"]},
            "bad_count": {"count": "x", "sources": ["a.md"]},
            "no_sources": {"count": 2},
        }
        res = cl.lookup(idx, "")
        by_name = {r["concept"]: r for r in res}
        self.assertEqual(by_name["no_count"]["count"], 0)
        self.assertEqual(by_name["bad_count"]["count"], 0)
        self.assertEqual(by_name["no_sources"]["sources"], [])


class CliTest(unittest.TestCase):
    def _run(self, args):
        return subprocess.run(
            [sys.executable, SCRIPT] + args,
            capture_output=True, text=True,
        )

    def test_cli_text_output(self):
        path = _write_index(SAMPLE)
        try:
            proc = self._run(["--index", path, "memory"])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("memory tiering", proc.stdout)
            self.assertIn("Related to", proc.stdout)
        finally:
            os.unlink(path)

    def test_cli_json_output(self):
        path = _write_index(SAMPLE)
        try:
            proc = self._run(["--index", path, "--json", "watchdog"])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["matches"][0]["concept"], "watchdog")
            self.assertIn("related", payload)
        finally:
            os.unlink(path)

    def test_cli_no_match_exit_1(self):
        path = _write_index(SAMPLE)
        try:
            proc = self._run(["--index", path, "zzzznope"])
            self.assertEqual(proc.returncode, 1)
        finally:
            os.unlink(path)

    def test_cli_missing_index_exit_2(self):
        proc = self._run(["--index", "/nonexistent/path/x.json", "q"])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("not found", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
