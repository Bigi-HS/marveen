#!/usr/bin/env python3
"""Unit tests for validate_knowledge_wiki.py.

Run: python3 scripts/test_validate_knowledge_wiki.py
"""

import importlib.util
import os
import tempfile
import textwrap
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "validate_knowledge_wiki", os.path.join(_HERE, "validate_knowledge_wiki.py")
)
v = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v)


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(textwrap.dedent(text).lstrip("\n"))


class FrontmatterParseTests(unittest.TestCase):
    def test_parses_valid_frontmatter(self):
        fm, body = v.parse_frontmatter(
            "---\ntitle: \"X\"\nkeywords: \"a, b\"\n---\n\n# Body\n"
        )
        self.assertEqual(fm["title"], "X")
        self.assertEqual(fm["keywords"], "a, b")
        self.assertIn("# Body", body)

    def test_no_frontmatter_returns_none(self):
        fm, body = v.parse_frontmatter("# Just a heading\n\ntext")
        self.assertIsNone(fm)
        self.assertIn("# Just a heading", body)

    def test_unclosed_frontmatter_returns_none(self):
        fm, _ = v.parse_frontmatter("---\ntitle: X\n\nno closing fence")
        self.assertIsNone(fm)

    def test_list_fields_parse(self):
        fm, _ = v.parse_frontmatter(
            "---\ntitle: X\nkeywords: k\nrelated:\n  - \"wiki/a.md\"\n  - \"wiki/b.md\"\n---\n"
        )
        self.assertEqual(fm["related"], ["wiki/a.md", "wiki/b.md"])


class EntryValidationTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def _entry(self, rel, related=None, sources=None, omit=None):
        omit = omit or []
        lines = ["---"]
        if "title" not in omit:
            lines.append('title: "T"')
        if "keywords" not in omit:
            lines.append('keywords: "k1, k2"')
        if "created_at" not in omit:
            lines.append("created_at: 2026-06-16")
        if "updated_at" not in omit:
            lines.append("updated_at: 2026-06-16")
        if related is not None and "related" not in omit:
            lines.append("related:")
            for r in related:
                lines.append(f'  - "{r}"')
        elif "related" not in omit:
            lines.append("related: []")
        if sources is not None:
            lines.append("sources:")
            for s in sources:
                lines.append(f'  - "{s}"')
        lines.append("---")
        lines.append("")
        lines.append("## Body")
        _write(os.path.join(self.d, rel), "\n".join(lines) + "\n")

    def test_valid_entry_no_errors(self):
        self._entry("wiki/foundations/a.md", related=["wiki/foundations/b.md"])
        self._entry("wiki/foundations/b.md", related=[])
        errs = v.validate_entry(os.path.join(self.d, "wiki/foundations/a.md"), self.d)
        self.assertEqual(errs, [])

    def test_missing_required_key_flagged(self):
        self._entry("wiki/foundations/a.md", omit=["keywords"])
        errs = v.validate_entry(os.path.join(self.d, "wiki/foundations/a.md"), self.d)
        self.assertTrue(any("keywords" in e for e in errs))

    def test_missing_frontmatter_flagged(self):
        _write(os.path.join(self.d, "wiki/foundations/a.md"), "# No frontmatter\n")
        errs = v.validate_entry(os.path.join(self.d, "wiki/foundations/a.md"), self.d)
        self.assertTrue(any("frontmatter" in e.lower() for e in errs))

    def test_dangling_related_link_flagged(self):
        self._entry("wiki/foundations/a.md", related=["wiki/foundations/ghost.md"])
        errs = v.validate_entry(os.path.join(self.d, "wiki/foundations/a.md"), self.d)
        self.assertTrue(any("ghost.md" in e for e in errs))

    def test_source_outside_sources_dir_flagged(self):
        self._entry("wiki/foundations/a.md", related=[], sources=["wiki/foundations/b.md"])
        errs = v.validate_entry(os.path.join(self.d, "wiki/foundations/a.md"), self.d)
        self.assertTrue(any("sources/" in e for e in errs))

    def test_existing_source_under_sources_ok(self):
        _write(os.path.join(self.d, "sources/dominik-research-notes/note.md"), "raw\n")
        self._entry(
            "wiki/foundations/a.md", related=[],
            sources=["sources/dominik-research-notes/note.md"],
        )
        errs = v.validate_entry(os.path.join(self.d, "wiki/foundations/a.md"), self.d)
        self.assertEqual(errs, [])


class IndexValidationTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        _write(os.path.join(self.d, "wiki/foundations/a.md"),
               "---\ntitle: A\nkeywords: k\nrelated: []\ncreated_at: 2026-06-16\nupdated_at: 2026-06-16\n---\n#A\n")

    def test_index_links_resolve(self):
        _write(os.path.join(self.d, "index.md"),
               "# Index\n\n| k | [A](wiki/foundations/a.md) |\n")
        errs = v.validate_index(os.path.join(self.d, "index.md"), self.d)
        self.assertEqual(errs, [])

    def test_index_dangling_link_flagged(self):
        _write(os.path.join(self.d, "index.md"),
               "# Index\n\n- [Ghost](wiki/foundations/ghost.md)\n")
        errs = v.validate_index(os.path.join(self.d, "index.md"), self.d)
        self.assertTrue(any("ghost.md" in e for e in errs))

    def test_non_wiki_links_ignored(self):
        _write(os.path.join(self.d, "index.md"),
               "# Index\n\n- [Foundations](#foundations)\n- [ext](https://example.com)\n- [A](wiki/foundations/a.md)\n")
        errs = v.validate_index(os.path.join(self.d, "index.md"), self.d)
        self.assertEqual(errs, [])


class TreeValidationTests(unittest.TestCase):
    def test_validate_tree_aggregates(self):
        d = tempfile.mkdtemp()
        _write(os.path.join(d, "index.md"), "# Index\n\n- [A](wiki/foundations/a.md)\n")
        _write(os.path.join(d, "wiki/foundations/a.md"),
               "---\ntitle: A\nkeywords: k\nrelated: []\ncreated_at: 2026-06-16\nupdated_at: 2026-06-16\n---\n#A\n")
        errs = v.validate_tree(d)
        self.assertEqual(errs, [])

    def test_validate_tree_surfaces_entry_error(self):
        d = tempfile.mkdtemp()
        _write(os.path.join(d, "index.md"), "# Index\n")
        _write(os.path.join(d, "wiki/foundations/a.md"), "# no frontmatter\n")
        errs = v.validate_tree(d)
        self.assertTrue(len(errs) >= 1)


class RealTreeIntegrationTests(unittest.TestCase):
    """Validate the actual shipped knowledge-wiki/ skeleton, not a fixture."""

    def test_shipped_tree_passes(self):
        repo_root = os.path.dirname(_HERE)
        wiki_root = os.path.join(repo_root, "knowledge-wiki")
        if not os.path.isdir(wiki_root):
            self.skipTest("knowledge-wiki/ not present")
        errs = v.validate_tree(wiki_root)
        self.assertEqual(errs, [], "shipped wiki has integrity errors:\n" + "\n".join(errs))

    def test_shipped_tree_has_entries(self):
        repo_root = os.path.dirname(_HERE)
        wiki_root = os.path.join(repo_root, "knowledge-wiki")
        if not os.path.isdir(wiki_root):
            self.skipTest("knowledge-wiki/ not present")
        n = sum(1 for _ in v._iter_wiki_entries(wiki_root))
        self.assertGreaterEqual(n, 10, "phase-1 expects ~10 example entries")


if __name__ == "__main__":
    unittest.main(verbosity=2)
