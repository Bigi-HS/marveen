#!/usr/bin/env python3
"""
Unit tests for vault-lint-tm1-executor.py

Fixtures:
1. Success case: valid TM-1 proposal (hot→warm)
2. Duplicate case: entry already in target category
3. Invalid migration case: blocked (warm→hot)
"""

import json
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch

# Import the executor (use importlib to handle dashes in filename)
import sys
import importlib.util
sys.path.insert(0, str(Path(__file__).parent))

spec = importlib.util.spec_from_file_location(
    "executor",
    Path(__file__).parent / "vault-lint-tm1-executor.py"
)
executor_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor_module)

validate_proposal = executor_module.validate_proposal
apply_migrations = executor_module.apply_migrations
write_audit_log = executor_module.write_audit_log
connect_db = executor_module.connect_db


def setup_test_db(db_path):
    """Create a temporary test noa.db with fixtures."""
    conn = sqlite3.connect(str(db_path))
    conn.execute('''
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY,
            agent_id TEXT NOT NULL,
            category TEXT NOT NULL,
            keywords TEXT,
            content TEXT,
            accessed_at INTEGER
        )
    ''')

    # Fixture entries
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, keywords) VALUES (?, ?, ?, ?)',
        (100, 'applegate', 'hot', 'test, tm1, hot')
    )
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, keywords) VALUES (?, ?, ?, ?)',
        (101, 'applegate', 'warm', 'test, tm1, warm')
    )
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, keywords) VALUES (?, ?, ?, ?)',
        (102, 'applegate', 'cold', 'test, tm1, cold')
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
        assert entry_data == (100, 'hot', 'warm', 'applegate')

        conn.close()
        print("✓ Fixture 1: Success (hot→warm) PASSED")


def test_invalid_warm_to_hot():
    """Fixture 2: Invalid migration (warm→hot, not allowed)."""
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
        print("✓ Fixture 2: Invalid migration (warm→hot) REJECTED as expected")


def test_category_mismatch():
    """Fixture 3: Category mismatch (corrupt proposal guard)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        conn = sqlite3.connect(str(db_path))

        proposal = {
            'entry_id': 101,
            'agent_id': 'applegate',
            'from_category': 'hot',  # Mismatch: DB has 'warm'
            'to_category': 'cold',
            'type': 'TM-1'
        }

        is_valid, error, entry_data = validate_proposal(conn, proposal)
        assert not is_valid, "Should have detected category mismatch"
        assert 'current category' in error.lower()

        conn.close()
        print("✓ Fixture 3: Category mismatch DETECTED as expected")


def test_apply_migrations_success():
    """Integration: Apply valid proposals in transaction."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        # Patch the DB path
        with patch.object(executor_module, 'DB_PATH', db_path):
            proposals = [
                {
                    'entry_id': 100,
                    'agent_id': 'applegate',
                    'from_category': 'hot',
                    'to_category': 'warm',
                    'type': 'TM-1'
                }
            ]

            applied_count, failed_count, audit_records, error = apply_migrations(proposals)

            assert error is None, f"Unexpected error: {error}"
            assert applied_count == 1
            assert failed_count == 0
            assert len(audit_records) == 1
            assert audit_records[0]['entry_id'] == 100
            assert audit_records[0]['to_cat'] == 'warm'

        # Verify DB state
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute('SELECT category FROM memories WHERE id = 100')
        new_cat = cursor.fetchone()[0]
        assert new_cat == 'warm', f"Entry 100 category should be 'warm', got {new_cat}"
        conn.close()

        print("✓ Integration: Apply migrations (success) PASSED")


def test_apply_migrations_rollback():
    """Integration: Rollback on validation failure."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        # Patch the DB path
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

            # Should rollback entire batch due to second proposal failing validation
            assert applied_count == 0, f"Should have 0 applied, got {applied_count}"
            assert failed_count == 1, f"Should have 1 failed (invalid migration), got {failed_count}"
            assert error is not None, "Should have error message"

        # Verify DB state unchanged (rollback worked)
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute('SELECT category FROM memories WHERE id = 100')
        cat = cursor.fetchone()[0]
        assert cat == 'hot', f"Entry 100 should still be 'hot' (rollback), got {cat}"
        conn.close()

        print("✓ Integration: Rollback on failure PASSED")


def test_audit_log_write():
    """Audit log: append-only writes."""
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
                    'applied_at': '2026-09-27T12:00:00Z'
                }
            ]

            log_file = write_audit_log(records)
            assert log_file is not None

            # Verify file contents
            with open(log_file) as f:
                data = json.load(f)
            assert len(data) == 1
            assert data[0]['entry_id'] == 100

            # Append more records
            records2 = [
                {
                    'entry_id': 101,
                    'agent_id': 'applegate',
                    'from_cat': 'warm',
                    'to_cat': 'cold',
                    'rule': 'TM-1',
                    'applied_at': '2026-09-27T12:01:00Z'
                }
            ]

            with patch.object(executor_module, 'LOG_DIR', log_dir):
                log_file2 = write_audit_log(records2)

            # Should be the same file, appended
            with open(log_file) as f:
                data = json.load(f)
            assert len(data) == 2
            assert data[1]['entry_id'] == 101

        print("✓ Audit log: append-only PASSED")


def run_all_tests():
    """Run all test fixtures."""
    print("=" * 60)
    print("Running TM-1 Executor Unit Tests")
    print("=" * 60)

    tests = [
        ("Fixture 1: Success (hot→warm)", test_success_hot_to_warm),
        ("Fixture 2: Invalid (warm→hot)", test_invalid_warm_to_hot),
        ("Fixture 3: Category mismatch", test_category_mismatch),
        ("Integration: Apply success", test_apply_migrations_success),
        ("Integration: Rollback", test_apply_migrations_rollback),
        ("Audit log: Append-only", test_audit_log_write),
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
    sys.exit(run_all_tests())
