#!/usr/bin/env python3
"""
Unit tests for vault-lint-tm1-executor.py

Fixtures:
1. Success case: valid TM-1 proposal (hot→warm)
2. Duplicate case: entry already in target category (idempotent no-op)
3. Invalid migration case: blocked (warm→hot)
4. Agent ID mismatch: proposal agent != DB agent
5. Already applied case: migration_log shows prior application
6. Apply success: entries migrate and audit records created
7. Per-item skip (not all-or-rollback): failures don't block good proposals
"""

import json
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch
import importlib.util

spec = importlib.util.spec_from_file_location(
    "executor",
    Path('.') / 'vault-lint-tm1-executor.py'
)
executor_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor_module)

validate_proposal = executor_module.validate_proposal
apply_migrations = executor_module.apply_migrations
write_audit_log = executor_module.write_audit_log
connect_db = executor_module.connect_db


def setup_test_db(db_path):
    """Create a temporary test noa.db with prod-parity schema."""
    conn = sqlite3.connect(str(db_path))
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
    conn.execute('''
        CREATE TABLE migration_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_at INTEGER NOT NULL,
            memory_id INTEGER NOT NULL,
            agent_id TEXT NOT NULL,
            from_tier TEXT NOT NULL,
            to_tier TEXT NOT NULL,
            rule TEXT NOT NULL,
            dry_run INTEGER NOT NULL DEFAULT 0
        )
    ''')

    now = int(__import__('time').time())
    # Fixture entries
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, content, created_at, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        (100, 'applegate', 'hot', 'test entry', now, 'test, tm1, hot')
    )
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, content, created_at, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        (101, 'applegate', 'warm', 'test entry', now, 'test, tm1, warm')
    )
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, content, created_at, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        (102, 'applegate', 'cold', 'test entry', now, 'test, tm1, cold')
    )
    conn.execute(
        'INSERT INTO memories (id, agent_id, category, content, created_at, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        (103, 'other_agent', 'hot', 'test entry', now, 'test, tm1, hot')
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
        assert entry_data[4] == False, "Should apply (not skip)"  # should_skip flag

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
        assert entry_data[4] == True, "Should skip (already at target)"  # should_skip flag

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
        print("✓ Fixture 3: Invalid migration (warm→hot) REJECTED as expected")


def test_agent_id_mismatch():
    """Fixture 4: Agent ID mismatch (Chad test requirement)."""
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
        print("✓ Fixture 4: Agent ID mismatch REJECTED as expected")


def test_already_applied_in_migration_log():
    """Fixture 5: Entry already applied (B1 duplicate-reconcile guard)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        setup_test_db(db_path)

        conn = sqlite3.connect(str(db_path))

        # Pre-populate migration_log (simulating prior application)
        conn.execute(
            '''INSERT INTO migration_log (run_at, memory_id, agent_id, from_tier, to_tier, rule, dry_run)
               VALUES (?, ?, ?, ?, ?, ?, 0)''',
            (int(__import__('time').time()), 100, 'applegate', 'hot', 'warm', 'TM-1')
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
        assert entry_data[4] == True, "Should skip (already applied)"  # should_skip flag

        conn.close()
        print("✓ Fixture 5: Already applied (migration_log guard) PASSED")


def test_apply_migrations_per_item_skip():
    """Fixture 6: Per-item skip (not all-or-rollback) — one bad proposal doesn't block good ones."""
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

            # With per-item skip: 1 applied, 1 failed (not all rolled back)
            assert applied_count == 1, f"Should apply 1, got {applied_count}"
            assert failed_count == 1, f"Should fail 1, got {failed_count}"
            assert error is None

        # Verify DB state: entry 100 should be migrated
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute('SELECT category FROM memories WHERE id = 100')
        cat = cursor.fetchone()[0]
        assert cat == 'warm', f"Entry 100 should be migrated to 'warm', got {cat}"
        conn.close()

        print("✓ Fixture 6: Per-item skip (independent entries) PASSED")


def test_audit_log_write():
    """Fixture 7: Audit log write (append-only)."""
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
                    'applied_at': '2026-09-27T19:00:00+00:00'
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
    print("Running TM-1 Executor Unit Tests (Fixed)")
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
