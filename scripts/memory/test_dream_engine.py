#!/usr/bin/env python3
"""
Unit & Integration Tests for Dream-Engine (F1 FIX: Real assertions)
"""

import unittest
import tempfile
import shutil
import sqlite3
import os
from pathlib import Path
from datetime import datetime, timezone, timedelta
from dream_engine import (
    snapshot_vault,
    cluster_entries,
    extract_patterns,
    dedup_check,
    generate_rb_entry,
    keyword_index_refresh_cold,
    check_hot_warm_keyword_gaps
)

class TestDreamEngineCore(unittest.TestCase):
    """Test core functionality"""

    def test_clustering(self):
        """Test theme clustering by domain keyword"""
        entries = [
            {'keywords': 'vault-ops, dedup'},
            {'keywords': 'vault-ops, tier-migration'},
            {'keywords': 'fleet-ops, spec-review'},
        ]
        clusters = cluster_entries(entries)
        self.assertIn('vault-ops', clusters)
        self.assertIn('fleet-ops', clusters)
        self.assertEqual(len(clusters['vault-ops']), 2)
        self.assertEqual(len(clusters['fleet-ops']), 1)

    def test_pattern_extraction(self):
        """Test pattern extraction returns required keys"""
        cluster = [{'keywords': 'vault-ops'}]
        patterns = extract_patterns(cluster)
        self.assertIn('worked', patterns)
        self.assertIn('avoid', patterns)
        self.assertIsInstance(patterns['worked'], list)
        self.assertIsInstance(patterns['avoid'], list)

    def test_rb_entry_generation_structure(self):
        """Test RB entry has all required sections"""
        content, keywords = generate_rb_entry('vault-ops', {
            'worked': ['bounded scope', 'atomic ops'],
            'avoid': ['auto-delete', 'fuzzy matching']
        })
        # Verify all sections present
        self.assertIn('**Téma**:', content)
        self.assertIn('**Mit csináltunk**:', content)
        self.assertIn('**Mi működött**:', content)
        self.assertIn('**Mit kerülj**:', content)
        self.assertIn('bounded scope', content)
        self.assertIn('auto-delete', content)

    def test_rb_entry_has_domain_keyword(self):
        """Safeguard: keywords must include domain"""
        _, keywords = generate_rb_entry('fleet-ops', {})
        self.assertIn('fleet-ops', keywords)
        self.assertIn('reasoningbank', keywords)

    def test_rb_entry_max_size(self):
        """Safeguard: RB entries <500 words"""
        content, _ = generate_rb_entry('test', {
            'worked': ['a'] * 50,
            'avoid': ['b'] * 50
        })
        word_count = len(content.split())
        self.assertLess(word_count, 500, f"RB entry too large: {word_count} words")

class TestDreamEngineSafeguards(unittest.TestCase):
    """Test safeguards: never-delete, dedup-flag, snapshot (F1 Real Tests)"""

    def setUp(self):
        """Create test DB"""
        self.test_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        self.test_db_path = self.test_db.name
        self.test_db.close()

        # Create schema
        conn = sqlite3.connect(self.test_db_path)
        conn.execute("""
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY,
                agent_id TEXT,
                content TEXT,
                category TEXT,
                keywords TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now'))
            )
        """)
        conn.commit()
        conn.close()

    def tearDown(self):
        """Clean up test DB"""
        if os.path.exists(self.test_db_path):
            os.remove(self.test_db_path)

    def test_snapshot_creates_file(self):
        """F1: Snapshot creates a read-only file"""
        # Temporarily override VAULT_PATH for test
        import dream_engine
        old_path = dream_engine.VAULT_PATH
        dream_engine.VAULT_PATH = self.test_db_path

        snapshot_path = snapshot_vault()

        # Assert snapshot file exists and is readable
        self.assertIsNotNone(snapshot_path)
        self.assertTrue(os.path.exists(snapshot_path), f"Snapshot {snapshot_path} not created")
        self.assertTrue(os.access(snapshot_path, os.R_OK), "Snapshot not readable")

        # Clean up
        if os.path.exists(snapshot_path):
            os.remove(snapshot_path)
        dream_engine.VAULT_PATH = old_path

    def test_dedup_requires_domain_and_reasoningbank(self):
        """F4 FIX: Dedup must match domain keyword AND 'reasoningbank', not just any keyword"""
        # Insert existing RB entries with different domains
        conn = sqlite3.connect(self.test_db_path)
        conn.execute("""
            INSERT INTO memories (agent_id, content, category, keywords)
            VALUES (?, ?, ?, ?)
        """, ('applegate', 'RB entry 1', 'cold', 'vault-ops, reasoningbank, dedup'))
        conn.commit()
        conn.close()

        # A2 FIX: Override dream_engine.VAULT_PATH to use test DB
        import dream_engine
        old_path = dream_engine.VAULT_PATH
        dream_engine.VAULT_PATH = self.test_db_path

        try:
            # Test 1: Same domain+reasoningbank -> conflict (dedup=True)
            is_dup = dedup_check('test content', 'vault-ops, reasoningbank, new')
            self.assertTrue(is_dup, "Should flag as duplicate (same domain+reasoningbank)")

            # Test 2: Different domain+reasoningbank -> no conflict (dedup=False)
            is_dup = dedup_check('test content', 'fleet-ops, reasoningbank, new')
            self.assertFalse(is_dup, "Should NOT flag as duplicate (different domain)")

            # Test 3: Only reasoningbank (no domain) -> no conflict (dedup=False)
            is_dup = dedup_check('test content', 'reasoningbank, nightly')
            self.assertFalse(is_dup, "Should NOT flag (no domain keyword)")
        finally:
            dream_engine.VAULT_PATH = old_path

    def test_keyword_index_cold_tier_only(self):
        """F3: keyword-index refresh must only touch cold-tier entries >24h"""
        conn = sqlite3.connect(self.test_db_path)

        # Insert hot/warm entries (should NOT be touched)
        now = int(datetime.now(tz=timezone.utc).timestamp())
        old_ts = int((datetime.now(tz=timezone.utc) - timedelta(hours=48)).timestamp())

        conn.execute("""
            INSERT INTO memories (agent_id, content, category, keywords, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, ('applegate', 'hot entry', 'hot', '', now))

        conn.execute("""
            INSERT INTO memories (agent_id, content, category, keywords, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, ('applegate', 'warm entry', 'warm', '', now))

        conn.execute("""
            INSERT INTO memories (agent_id, content, category, keywords, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, ('applegate', 'old cold entry', 'cold', '', old_ts))

        conn.commit()
        conn.close()

        # Override DB path and run refresh
        import dream_engine
        old_path = dream_engine.VAULT_PATH
        dream_engine.VAULT_PATH = self.test_db_path

        updated = keyword_index_refresh_cold()

        # Verify: only cold-tier >24h entries were updated
        conn = sqlite3.connect(self.test_db_path)
        c = conn.cursor()

        c.execute("SELECT keywords FROM memories WHERE category='hot'")
        hot_kw = c.fetchone()[0]
        self.assertEqual(hot_kw, '', "Hot entry should NOT be modified")

        c.execute("SELECT keywords FROM memories WHERE category='warm'")
        warm_kw = c.fetchone()[0]
        self.assertEqual(warm_kw, '', "Warm entry should NOT be modified")

        c.execute("SELECT keywords FROM memories WHERE category='cold'")
        cold_kw = c.fetchone()[0]
        self.assertNotEqual(cold_kw, '', "Cold entry >24h should be updated")

        conn.close()
        dream_engine.VAULT_PATH = old_path

    def test_hot_warm_keyword_gaps_flag(self):
        """F3: Hot/warm keyword-gaps return FLAG list (no auto-write)"""
        conn = sqlite3.connect(self.test_db_path)

        # Insert hot/warm entries without keywords
        conn.execute("""
            INSERT INTO memories (agent_id, content, category, keywords)
            VALUES (?, ?, ?, ?)
        """, ('applegate', 'hot content', 'hot', ''))

        conn.execute("""
            INSERT INTO memories (agent_id, content, category, keywords)
            VALUES (?, ?, ?, ?)
        """, ('applegate', 'warm content', 'warm', None))

        conn.commit()
        conn.close()

        # Override DB path
        import dream_engine
        old_path = dream_engine.VAULT_PATH
        dream_engine.VAULT_PATH = self.test_db_path

        gaps = check_hot_warm_keyword_gaps()

        # Verify: gaps returned (not auto-fixed)
        self.assertEqual(len(gaps), 2, "Should find 2 hot/warm keyword-gaps")

        # Verify: hot/warm entries still have no keywords (not auto-written)
        conn = sqlite3.connect(self.test_db_path)
        c = conn.cursor()
        c.execute("SELECT keywords FROM memories WHERE category IN ('hot', 'warm')")
        for row in c.fetchall():
            kw = row[0]
            self.assertFalse(kw, "Hot/warm keywords should NOT be auto-filled")
        conn.close()

        dream_engine.VAULT_PATH = old_path

if __name__ == '__main__':
    unittest.main()
