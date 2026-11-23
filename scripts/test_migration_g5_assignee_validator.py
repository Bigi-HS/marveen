#!/usr/bin/env python3
"""Unit tests for migration-g5-assignee-validator.py.

Run: python3 scripts/test_migration_g5_assignee_validator.py
"""
import importlib.util
import os
import sqlite3
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "migration_g5_assignee_validator",
    os.path.join(_HERE, "migration-g5-assignee-validator.py"),
)
g5 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(g5)


def _agents(*ids):
    return [{"id": i, "display": i} for i in ids]


class ResolvableRosterTests(unittest.TestCase):
    def test_includes_ids_displays_live_and_aliases(self):
        agents = [{"id": "dave", "display": "Dave"}, {"id": "marveen", "display": "NoA"}]
        live = {"blackbart", "hibiki"}  # persona-only, no config
        resolvable = g5.resolvable_roster_ids(agents, live)
        self.assertIn("dave", resolvable)
        self.assertIn("marveen", resolvable)
        self.assertIn("noa", resolvable)          # display name
        self.assertIn("blackbart", resolvable)     # live persona-only
        self.assertIn("hibiki", resolvable)
        self.assertIn("genesis", resolvable)       # default alias key
        self.assertIn("marveen", resolvable)       # default alias target

    def test_custom_alias_map(self):
        resolvable = g5.resolvable_roster_ids(_agents("dave"), [], {"ghost": "dave"})
        self.assertIn("ghost", resolvable)
        self.assertIn("dave", resolvable)
        self.assertNotIn("genesis", resolvable)  # defaults replaced


class NormalizeAssigneeTests(unittest.TestCase):
    def test_none_and_sentinels_collapse_to_empty(self):
        for raw in (None, "", "  ", "none", "None", "unassigned", "null", "-"):
            self.assertEqual(g5.normalize_assignee(raw), "", f"{raw!r} should be ''")

    def test_real_assignee_lowercased_stripped(self):
        self.assertEqual(g5.normalize_assignee("  Dave "), "dave")
        self.assertEqual(g5.normalize_assignee("Genesis"), "genesis")


class ResolveAssigneesTests(unittest.TestCase):
    def setUp(self):
        self.resolvable = g5.resolvable_roster_ids(
            _agents("dave", "marveen", "thor"), []
        )

    def test_all_resolve(self):
        cards = [
            {"id": 1, "code": "AAA", "title": "x", "assignee": "dave"},
            {"id": 2, "code": "BBB", "title": "y", "assignee": "Thor"},
        ]
        r = g5.resolve_assignees(cards, self.resolvable)
        self.assertEqual(len(r["resolved"]), 2)
        self.assertEqual(r["unresolved"], [])
        self.assertEqual(r["unassigned"], [])

    def test_unassigned_is_not_an_error(self):
        cards = [
            {"id": 1, "code": "AAA", "title": "x", "assignee": None},
            {"id": 2, "code": "BBB", "title": "y", "assignee": "none"},
        ]
        r = g5.resolve_assignees(cards, self.resolvable)
        self.assertEqual(len(r["unassigned"]), 2)
        self.assertEqual(r["unresolved"], [])

    def test_unresolved_assignee_flagged(self):
        # FIXTURE: an open card assigned to a ghost agent.
        cards = [
            {"id": 1, "code": "AAA", "title": "x", "assignee": "dave"},
            {"id": 2, "code": "GHOST1", "title": "orphan", "assignee": "ghost-agent"},
        ]
        r = g5.resolve_assignees(cards, self.resolvable)
        self.assertEqual(len(r["resolved"]), 1)
        self.assertEqual(len(r["unresolved"]), 1)
        self.assertEqual(r["unresolved_assignees"], ["ghost-agent"])
        self.assertEqual(r["unresolved"][0]["code"], "GHOST1")

    def test_aliased_assignee_resolves(self):
        resolvable = g5.resolvable_roster_ids(_agents("marveen"), [])
        cards = [{"id": 1, "code": "AAA", "title": "x", "assignee": "Genesis"}]
        r = g5.resolve_assignees(cards, resolvable)
        self.assertEqual(len(r["resolved"]), 1)
        self.assertEqual(r["unresolved"], [])


class CanonicalDbGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        os.makedirs(os.path.join(self.root, "store"))
        os.makedirs(os.path.join(self.root, "agents", "rackham", "store"))
        self.canonical = os.path.join(self.root, "store", "noa.db")
        self.rackham = os.path.join(self.root, "agents", "rackham", "store", "noa.db")
        open(self.canonical, "w").close()
        open(self.rackham, "w").close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_canonical_is_canonical(self):
        self.assertTrue(g5.is_canonical_db(self.canonical, self.root))
        self.assertEqual(g5.classify_db_copy(self.canonical, self.root), "canonical")

    def test_rackham_copy_is_non_canonical(self):
        self.assertFalse(g5.is_canonical_db(self.rackham, self.root))
        self.assertEqual(
            g5.classify_db_copy(self.rackham, self.root), "non-canonical-copy"
        )

    def test_known_non_canonical_paths_lists_rackham(self):
        paths = g5.known_non_canonical_paths(self.root)
        self.assertIn(self.rackham, [os.path.normpath(p) for p in paths] + paths)

    def test_symlink_to_canonical_still_canonical(self):
        link = os.path.join(self.root, "store", "noa-link.db")
        try:
            os.symlink(self.canonical, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unsupported")
        self.assertTrue(g5.is_canonical_db(link, self.root))

    def test_suffix_fallback_when_file_absent(self):
        # Fixture/pre-migration: file does not exist -> normalized suffix compare.
        absent_root = os.path.join(self.root, "nowhere")
        p = os.path.join(absent_root, "store", "noa.db")
        self.assertTrue(g5.is_canonical_db(p, absent_root))


class LoadOpenCardsFromDbTests(unittest.TestCase):
    def test_reads_only_open_statuses_with_unresolved_fixture(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = os.path.join(tmp.name, "noa.db")
        con = sqlite3.connect(db)
        con.execute(
            "CREATE TABLE kanban_cards (id INTEGER PRIMARY KEY, code TEXT, "
            "title TEXT, status TEXT, assignee TEXT)"
        )
        con.executemany(
            "INSERT INTO kanban_cards (id, code, title, status, assignee) "
            "VALUES (?,?,?,?,?)",
            [
                (1, "A", "open-dave", "in_progress", "dave"),
                (2, "B", "open-ghost", "planned", "ghost-agent"),
                (3, "C", "done-card", "done", "someone-retired"),  # excluded
                (4, "D", "icebox", "icebox", "nobody"),            # excluded
                (5, "E", "open-none", "waiting", None),            # unassigned
            ],
        )
        con.commit()
        con.close()

        cards = g5.load_open_cards_from_db(db)
        self.assertEqual(len(cards), 3)  # done + icebox excluded
        codes = {c["code"] for c in cards}
        self.assertEqual(codes, {"A", "B", "E"})

        resolvable = g5.resolvable_roster_ids(_agents("dave"), [])
        r = g5.resolve_assignees(cards, resolvable)
        self.assertEqual(r["unresolved_assignees"], ["ghost-agent"])
        self.assertEqual(len(r["unassigned"]), 1)
        self.assertEqual(len(r["resolved"]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
