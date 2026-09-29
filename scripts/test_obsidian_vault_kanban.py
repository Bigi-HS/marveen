"""Tests for the kanban sync additions to obsidian-vault-sync.py (card 3f62811c)."""
import importlib.util
import os
import sys
import tempfile
import json
import unittest

# Load the module without executing main() or reading the token file.
# Patch TOKEN and VAULT before loading.
spec = importlib.util.spec_from_file_location(
    "obsidian_vault_sync",
    os.path.join(os.path.dirname(__file__), "obsidian-vault-sync.py"),
)
mod = importlib.util.module_from_spec(spec)
# Inject stubs so the top-level open(TOKEN_FILE) doesn't fail
import builtins
_real_open = builtins.open
def _stub_open(path, *a, **kw):
    if "dashboard-token" in str(path):
        import io
        return io.StringIO("test-token")
    return _real_open(path, *a, **kw)
builtins.open = _stub_open
spec.loader.exec_module(mod)
builtins.open = _real_open


class TestSyncKanban(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _cards(self, overrides=None):
        base = {
            "id": "abc12345",
            "title": "Fix the bug",
            "status": "in_progress",
            "priority": "high",
            "assignee": "dave",
            "project": "OPS",
            "due_date": "2026-10-15",
            "updated_at": 1790000000,
            "created_at": 1789000000,
            "archived_at": None,
            "description": "Some description here.",
        }
        if overrides:
            base.update(overrides)
        return [base]

    def _read(self, *path):
        with open(os.path.join(self.tmp, *path), encoding="utf-8") as f:
            return f.read()

    def test_writes_file_under_project_dir(self):
        mod.sync_kanban(self.tmp, self._cards(), "2026-09-29", "2026-09-29 15:00")
        path = os.path.join(self.tmp, "Kanban", "OPS")
        self.assertTrue(os.path.isdir(path), "Kanban/OPS dir should exist")
        files = os.listdir(path)
        self.assertEqual(len(files), 1)
        self.assertIn("abc12345", files[0])

    def test_frontmatter_contains_required_bases_fields(self):
        mod.sync_kanban(self.tmp, self._cards(), "2026-09-29", "2026-09-29 15:00")
        content = self._read("Kanban", "OPS", "abc12345 - Fix the bug.md")
        self.assertIn("type: kanban-card", content)
        self.assertIn("status: in_progress", content)
        self.assertIn("priority: high", content)
        self.assertIn("assignee: dave", content)
        self.assertIn("project: OPS", content)
        self.assertIn("due_date: 2026-10-15", content)
        self.assertIn("generated: true", content)

    def test_archived_cards_are_skipped(self):
        cards = self._cards({"archived_at": 1790000000})
        n = mod.sync_kanban(self.tmp, cards, "2026-09-29", "2026-09-29 15:00")
        self.assertEqual(n, 0)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "Kanban")))

    def test_missing_due_date_writes_empty_field(self):
        cards = self._cards({"due_date": None})
        mod.sync_kanban(self.tmp, cards, "2026-09-29", "2026-09-29 15:00")
        content = self._read("Kanban", "OPS", "abc12345 - Fix the bug.md")
        self.assertIn("due_date: ", content)

    def test_returns_count_of_written_cards(self):
        cards = self._cards() + self._cards({"id": "def67890", "title": "Second card"})
        n = mod.sync_kanban(self.tmp, cards, "2026-09-29", "2026-09-29 15:00")
        self.assertEqual(n, 2)

    def test_title_with_invalid_filename_chars_is_sanitised(self):
        cards = self._cards({"title": 'Fix: the "bug" <now>'})
        mod.sync_kanban(self.tmp, cards, "2026-09-29", "2026-09-29 15:00")
        files = os.listdir(os.path.join(self.tmp, "Kanban", "OPS"))
        self.assertEqual(len(files), 1)
        # No forbidden chars in filename
        for ch in r'\/:*?"<>|':
            self.assertNotIn(ch, files[0])

    def test_kanban_bases_view_in_bases_dict(self):
        self.assertIn("Kanban", mod.BASES)
        kanban_base = mod.BASES["Kanban"]
        self.assertIn('type == "kanban-card"', kanban_base)
        self.assertIn("type: kanban", kanban_base)
        self.assertIn("groupBy: status", kanban_base)

    def test_property_types_includes_bases_fields(self):
        for field in ("status", "priority", "assignee", "project", "due_date"):
            self.assertIn(field, mod.PROPERTY_TYPES, f"{field} missing from PROPERTY_TYPES")


if __name__ == "__main__":
    unittest.main()
