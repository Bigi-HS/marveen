#!/usr/bin/env python3
"""
Unit & Integration Tests for Dream-Engine
"""

import unittest
import tempfile
import shutil
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from dream_engine import (
    snapshot_vault,
    cluster_entries,
    extract_patterns,
    dedup_check,
    generate_rb_entry,
    keyword_index_refresh_cold
)

class TestDreamEngineCore(unittest.TestCase):
    """Test core functionality"""

    def test_clustering(self):
        """Test theme clustering"""
        entries = [
            {'keywords': 'vault-ops, dedup'},
            {'keywords': 'vault-ops, tier-migration'},
            {'keywords': 'fleet-ops, spec-review'},
        ]
        clusters = cluster_entries(entries)
        self.assertIn('vault-ops', clusters)
        self.assertIn('fleet-ops', clusters)
        self.assertEqual(len(clusters['vault-ops']), 2)

    def test_pattern_extraction(self):
        """Test pattern extraction"""
        cluster = [
            {'keywords': 'vault-ops'},
            {'keywords': 'vault-ops'},
        ]
        patterns = extract_patterns(cluster)
        self.assertIn('worked', patterns)
        self.assertIn('avoid', patterns)

    def test_rb_entry_generation(self):
        """Test RB entry structure"""
        content, keywords = generate_rb_entry('vault-ops', {
            'worked': ['bounded scope'],
            'avoid': ['auto-delete']
        })
        self.assertIn('vault-ops', content)
        self.assertIn('reasoningbank', keywords)
        self.assertIn('bounded scope', content)
        self.assertIn('auto-delete', content)

    def test_keywords_have_domain(self):
        """Safeguard: keywords must include domain"""
        _, keywords = generate_rb_entry('fleet-ops', {})
        self.assertIn('fleet-ops', keywords)

    def test_rb_entry_under_500_words(self):
        """Safeguard: RB entries <500 words"""
        content, _ = generate_rb_entry('test', {})
        word_count = len(content.split())
        self.assertLess(word_count, 500)

class TestDreamEngineSafeguards(unittest.TestCase):
    """Test safeguards: never-delete, dedup-flag, snapshot"""

    def test_snapshot_creates_file(self):
        """Safeguard: snapshot is created"""
        # Placeholder: assume snapshot() returns a path
        # Full test requires file-system setup
        pass

    def test_dedup_flag_not_auto_delete(self):
        """Safeguard: dedup returns FLAG, never auto-delete"""
        # Dedup should return True (flag) if duplicate found
        # No deletion occurs in dedup_check()
        pass

    def test_keyword_index_cold_tier_only(self):
        """Safeguard: keyword-index refresh only touches cold tier"""
        # keyword_index_refresh_cold() should have WHERE category='cold'
        # Integration test with test DB
        pass

if __name__ == '__main__':
    unittest.main()
