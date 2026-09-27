#!/usr/bin/env python3
"""
Unit tests for vault-lint-tm1-executor.py

Tests use LIVE curator migration_log schema (not fake schemas):
- migration_log(id, rule, entry_id, from_cat, to_cat, reason, applier, applied_at)
- memories: created_at/content NOT NULL (prod parity)

Fixtures:
1. Success: valid TM-1 proposal (hot→warm)
2. Already at target: idempotent no-op
3. Invalid migration: rejected (warm→hot)
4. Agent ID mismatch: rejected
5. Already applied: skip (in migration_log)
6. Per-item skip: failures don't block good proposals
7. Audit log: append-only write
"""

import json
import sqlite3
import tempfile
import time
from pathlib import Path
from unittest.mock import patch
import importlib.util

spec = importlib.util.spec_from_file_location(
    "executor",
    Path(__file__).resolve().parent / 'vault-lint-tm1-executor.py'
)
executor_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor_module)

validate_proposal = executor_module.validate_proposal
apply_migrations = executor_module.apply_migrations
write_audit_log = executor_module.write_audit_log


def setup_test_db(db_path):
    """Create test noa.db with LIVE curator schemas (not fake ones)."""
    conn = sqlite3.connect(str(db_path))

    # LIVE migration_log schema (from curator applier)
    conn.execute('''
        CREATE TABLE migration_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule TEXT NOT NULL,
            entry_id INTEGER NOT NULL,
            from_cat TEXT NOT NULL,
            to_cat TEXT NOT NULL,
            reason TEXT,
            applier TEXT DEFAULT 'curator-applyer',
            applied_at INTEGER NOT NULL
        )
    ''')

    # LIVE memories schema (prod parity: created_at/content NOT NULL)
    conn.execute('''
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY,
            agent_id TEXT NOT NULL,
            category TEXT NOT NULL,
            keywords TEXT,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            accessed_at INTEGER
        )
    ''')

    now = int(time.time())
    # Fixture entries
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, content, created_at, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        (100, 'applegate', 'hot', 'test content', now, 'test, hot')
    )
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, content, created_at, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        (101, 'applegate', 'warm', 'test content', now, 'test, warm')
    )
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, content, created_at, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        (102, 'applegate', 'cold', 'test content', now, 'test, cold')
    )
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, content, created_at, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        (103, 'other_agent', 'hot', 'test content', now, 'test, hot')
    )

    conn.commit()
    conn.close()


def test_success_hot_to_warm():
    """Fixture 1: Valid TM-1 hot→warm migration."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        conn = sqlite3.connect(str(db_path))

        proposal = {
            'entry_id': 100,
            'agent_id': 'applegate',
            'from_category': 'hot',
            'to_category': 'warm',
            'type': 'TM-1'
        }

        is_valid, error, entry_data = validate_proposal(conn, proposal)
        assert is_valid, f"Validation failed: {error}"
        assert entry_data[4] == False, "Should apply (not skip)"

        conn.close()
        print("✓ Fixture 1: Success (hot→warm) PASSED")


def test_duplicate_already_at_target():
    """Fixture 2: Entry already at target (idempotent no-op)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        conn = sqlite3.connect(str(db_path))

        proposal = {
            'entry_id': 101,
            'agent_id': 'applegate',
            'from_category': 'hot',  # Mismatch: DB has 'warm'
            'to_category': 'warm',  # But target IS current state
            'type': 'TM-1'
        }

        is_valid, error, entry_data = validate_proposal(conn, proposal)
        assert is_valid, f"Validation failed: {error}"
        assert entry_data[4] == True, "Should skip (already at target)"

        conn.close()
        print("✓ Fixture 2: Already at target (idempotent) PASSED")


def test_invalid_warm_to_hot():
    """Fixture 3: Invalid migration (warm→hot, not allowed)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        conn = sqlite3.connect(str(db_path))

        proposal = {
            'entry_id': 101,
            'agent_id': 'applegate',
            'from_category': 'warm',
            'to_category': 'hot',
            'type': 'TM-1'
        }

        is_valid, error, entry_data = validate_proposal(conn, proposal)
        assert not is_valid, "Should have rejected warm→hot"
        assert 'not allowed' in error.lower()

        conn.close()
        print("✓ Fixture 3: Invalid migration (warm→hot) REJECTED")


def test_agent_id_mismatch():
    """Fixture 4: Agent ID mismatch."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        conn = sqlite3.connect(str(db_path))

        proposal = {
            'entry_id': 103,  # DB has agent_id='other_agent'
            'agent_id': 'applegate',
            'from_category': 'hot',
            'to_category': 'warm',
            'type': 'TM-1'
        }

        is_valid, error, entry_data = validate_proposal(conn, proposal)
        assert not is_valid, "Should have rejected agent_id mismatch"
        assert 'agent' in error.lower()

        conn.close()
        print("✓ Fixture 4: Agent ID mismatch REJECTED")


def test_already_applied_in_migration_log():
    """Fixture 5: Entry already applied (in LIVE migration_log)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        conn = sqlite3.connect(str(db_path))

        # Pre-populate migration_log with LIVE schema
        conn.execute(
            '''INSERT INTO migration_log (rule, entry_id, from_cat, to_cat, reason, applier, applied_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)''',
            ('TM-1', 100, 'hot', 'warm', 'L2 proposal', 'vault-lint-tm1-executor', int(time.time()))
        )
        conn.commit()

        proposal = {
            'entry_id': 100,
            'agent_id': 'applegate',
            'from_category': 'hot',
            'to_category': 'warm',
            'type': 'TM-1'
        }

        is_valid, error, entry_data = validate_proposal(conn, proposal)
        assert is_valid, f"Validation failed: {error}"
        assert entry_data[4] == True, "Should skip (already applied)"

        conn.close()
        print("✓ Fixture 5: Already applied (LIVE migration_log) PASSED")


def test_apply_migrations_per_item_skip():
    """Fixture 6: Per-item skip (one bad doesn't block good)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        with patch.object(executor_module, 'DB_PATH', db_path):
            proposals = [
                {
                    'entry_id': 100,
                    'agent_id': 'applegate',
                    'from_category': 'hot',
                    'to_category': 'warm',
                    'type': 'TM-1'
                },
                {
                    'entry_id': 101,
                    'agent_id': 'applegate',
                    'from_category': 'warm',
                    'to_category': 'hot',  # Invalid
                    'type': 'TM-1'
                }
            ]

            applied_count, failed_count, audit_records, error = apply_migrations(proposals)

            assert applied_count == 1, f"Should apply 1, got {applied_count}"
            assert failed_count == 1, f"Should fail 1, got {failed_count}"

        # Verify: entry 100 migrated to 'warm'
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute('SELECT category FROM memories WHERE id = 100')
        cat = cursor.fetchone()[0]
        assert cat == 'warm', f"Entry 100 should be 'warm', got {cat}"
        conn.close()

        print("✓ Fixture 6: Per-item skip (independent entries) PASSED")


def test_audit_log_write():
    """Fixture 7: Audit log append-only."""
    with tempfile.TemporaryDirectory() as tmpdir:
        log_dir = Path(tmpdir)

        with patch.object(executor_module, 'LOG_DIR', log_dir):
            records = [
                {
                    'entry_id': 100,
                    'agent_id': 'applegate',
                    'from_cat': 'hot',
                    'to_cat': 'warm',
                    'rule': 'TM-1',
                    'applied_at': '2026-09-27T20:00:00+00:00'
                }
            ]

            log_file = write_audit_log(records)
            assert log_file is not None

            with open(log_file) as f:
                data = json.load(f)
            assert len(data) == 1
            assert data[0]['entry_id'] == 100

        print("✓ Fixture 7: Audit log (append-only) PASSED")


def run_all_tests():
    """Run all test fixtures."""
    print("=" * 60)
    print("Running TM-1 Executor Unit Tests (LIVE Schema)")
    print("=" * 60)

    tests = [
        ("Fixture 1: Success (hot→warm)", test_success_hot_to_warm),
        ("Fixture 2: Already at target", test_duplicate_already_at_target),
        ("Fixture 3: Invalid (warm→hot)", test_invalid_warm_to_hot),
        ("Fixture 4: Agent ID mismatch", test_agent_id_mismatch),
        ("Fixture 5: Already applied", test_already_applied_in_migration_log),
        ("Fixture 6: Per-item skip", test_apply_migrations_per_item_skip),
        ("Fixture 7: Audit log", test_audit_log_write),
    ]

    passed = 0
    failed = 0

    for name, test_func in tests:
        try:
            test_func()
            passed += 1
        except AssertionError as e:
            print(f"✗ {name} FAILED: {e}")
            failed += 1
        except Exception as e:
            print(f"✗ {name} ERROR: {e}")
            failed += 1

    print("=" * 60)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 60)

    return 0 if failed == 0 else 1


if __name__ == '__main__':
    import sys
    sys.exit(run_all_tests())
