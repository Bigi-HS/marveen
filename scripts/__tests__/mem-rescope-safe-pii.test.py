#!/usr/bin/env python3
"""Tests for scripts/mem-rescope-safe-pii.py (MEM-018, 07596e45).

Verifies the new word-start PII classifier correctly identifies candidates
that the OLD (bare substring) classifier over-matched.
"""
import importlib.util
import os
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.normpath(os.path.join(HERE, '..', 'mem-rescope-safe-pii.py'))

spec_obj = importlib.util.spec_from_file_location("mem_rescope", MODULE_PATH)
mod = importlib.util.module_from_spec(spec_obj)
spec_obj.loader.exec_module(mod)


MEMORIES_DDL = """
CREATE TABLE memories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     TEXT NOT NULL DEFAULT 'test',
    content      TEXT NOT NULL DEFAULT '',
    keywords     TEXT,
    access_scope TEXT
)
"""

MIGRATION_LOG_DDL = """
CREATE TABLE IF NOT EXISTS migration_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at    INTEGER NOT NULL,
    memory_id INTEGER NOT NULL,
    agent_id  TEXT    NOT NULL,
    old_scope TEXT,
    new_scope TEXT,
    rule      TEXT    NOT NULL,
    dry_run   INTEGER NOT NULL DEFAULT 0
)
"""


def make_db(rows):
    tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
    path = tmp.name
    tmp.close()
    con = sqlite3.connect(path)
    con.execute(MEMORIES_DDL)
    con.execute(MIGRATION_LOG_DDL)
    for r in rows:
        con.execute(
            "INSERT INTO memories (agent_id, content, keywords, access_scope) VALUES (?, ?, ?, ?)",
            (r.get('agent_id', 'test'), r.get('content', ''), r.get('keywords'), r.get('access_scope')),
        )
    con.commit()
    return path, con


class TestNewPiiClassifier(unittest.TestCase):
    """Verify the new word-start classifier correctly handles old phantom matches."""

    # F1: "listaja" should NOT match 'taj' (bare substring in old classifier)
    def test_listaja_is_not_pii(self):
        self.assertFalse(mod.is_pii_new(None, 'listaja tartalmazza a feladatot'))

    # F2: "tajszamom" SHOULD match (starts with 'taj')
    def test_tajszamom_is_pii(self):
        self.assertTrue(mod.is_pii_new(None, 'a tajszamom: 123456'))

    # F3: "gzip" should NOT match 'zip' (no word boundary start)
    def test_gzip_is_not_pii(self):
        self.assertFalse(mod.is_pii_new(None, 'gzip -c file.txt'))

    # F4: "postal code" SHOULD match 'postal'
    def test_postal_code_is_pii(self):
        self.assertTrue(mod.is_pii_new(None, 'postal code 1234'))

    # F5: "specimen" should NOT match 'cim' (was false positive before 8ad3a1c9)
    # Actually 'specimen' contains 'c-i-m' in reversed -- actually no. Let me use "hivatal".
    # "van cimem" SHOULD match (word-start 'cim' after space)
    def test_van_cimem_is_pii(self):
        self.assertTrue(mod.is_pii_new(None, 'van cimem itt'))


class TestFindCandidates(unittest.TestCase):

    # F6: auto-scoped (access_scope == agent_id) memory with phantom-PII content is a candidate
    def test_phantom_pii_found_as_candidate(self):
        path, con = make_db([
            {'content': 'listaja a feladatnak', 'access_scope': 'test', 'agent_id': 'test'},
        ])
        try:
            candidates = mod.find_candidates(con, None)
            self.assertGreater(len(candidates), 0)
            self.assertEqual(candidates[0]['agent_id'], 'test')
        finally:
            con.close()
            os.unlink(path)

    # F6b: explicit cross-agent scope (access_scope != agent_id) is NEVER a candidate,
    # even with phantom-PII content -- guards against silently unscoping caller-set scopes.
    def test_explicit_cross_agent_scope_not_candidate(self):
        path, con = make_db([
            {'content': 'listaja a feladatnak', 'access_scope': 'other_agent', 'agent_id': 'test'},
        ])
        try:
            candidates = mod.find_candidates(con, None)
            self.assertEqual(len(candidates), 0)
        finally:
            con.close()
            os.unlink(path)

    # F7: unscoped memory is NOT a candidate (no access_scope to change)
    def test_unscoped_memory_is_not_candidate(self):
        path, con = make_db([
            {'content': 'listaja a feladatnak', 'access_scope': None},  # already unscoped
        ])
        try:
            candidates = mod.find_candidates(con, None)
            self.assertEqual(len(candidates), 0)
        finally:
            con.close()
            os.unlink(path)

    # F8: real PII content (matching new classifier) stays scoped
    def test_real_pii_stays_scoped(self):
        path, con = make_db([
            {'content': 'a tajszamom: 123456789', 'access_scope': 'test', 'agent_id': 'test'},
        ])
        try:
            candidates = mod.find_candidates(con, None)
            self.assertEqual(len(candidates), 0)  # not a candidate
        finally:
            con.close()
            os.unlink(path)


class TestApplyRescope(unittest.TestCase):

    # F9: dry_run=True does not change access_scope but logs the row
    def test_dry_run_does_not_change_scope(self):
        path, con = make_db([
            {'content': 'listaja', 'access_scope': 'test', 'agent_id': 'test'},
        ])
        try:
            candidates = mod.find_candidates(con, None)
            mod.apply_rescope(con, candidates, 0, dry_run=True)
            scope = con.execute("SELECT access_scope FROM memories").fetchone()[0]
            log = con.execute("SELECT dry_run FROM migration_log").fetchone()
            self.assertEqual(scope, 'test')  # unchanged
            self.assertEqual(log[0], 1)  # dry_run=1
        finally:
            con.close()
            os.unlink(path)


if __name__ == '__main__':
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
