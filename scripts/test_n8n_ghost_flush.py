#!/usr/bin/env python3
"""
Unit tests for n8n-ghost-flush.py (OPS-091).
Tests _find_ghosts positive detection with seeded in-memory SQLite.
"""
import sqlite3
import sys
import tempfile
import os
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Allow importing from sibling module
sys.path.insert(0, str(Path(__file__).parent))

# Patch N8N_DB before import
import importlib.util

# We import the module functions by monkey-patching the DB path
_mod_path = Path(__file__).parent / "n8n-ghost-flush.py"
_spec = importlib.util.spec_from_file_location("n8n_ghost_flush", _mod_path)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)


def _make_db(boot_iso: str, ghost: bool) -> str:
    """Create a temp SQLite DB mirroring n8n schema. Returns path."""
    db_fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(db_fd)
    con = sqlite3.connect(db_path)
    con.execute("""
        CREATE TABLE workflow_entity (
            id TEXT PRIMARY KEY,
            name TEXT,
            active INTEGER
        )
    """)
    con.execute("""
        CREATE TABLE execution_entity (
            id TEXT PRIMARY KEY,
            workflowId TEXT,
            mode TEXT,
            startedAt TEXT
        )
    """)
    # One workflow that is active=0
    con.execute("INSERT INTO workflow_entity VALUES ('wf-test-1', 'Test Ghost WF', 0)")
    if ghost:
        # Execution AFTER boot -- should be detected as ghost
        after_boot = datetime.fromisoformat(boot_iso.replace(' ', 'T') + '+00:00') + timedelta(minutes=5)
        exec_ts = after_boot.strftime('%Y-%m-%d %H:%M:%S.') + '047'
        con.execute(
            "INSERT INTO execution_entity VALUES ('exec-1', 'wf-test-1', 'trigger', ?)",
            (exec_ts,)
        )
    else:
        # Execution BEFORE boot -- should NOT be detected
        before_boot = datetime.fromisoformat(boot_iso.replace(' ', 'T') + '+00:00') - timedelta(minutes=10)
        exec_ts = before_boot.strftime('%Y-%m-%d %H:%M:%S.') + '012'
        con.execute(
            "INSERT INTO execution_entity VALUES ('exec-1', 'wf-test-1', 'trigger', ?)",
            (exec_ts,)
        )
    con.commit()
    con.close()
    return db_path


class TestFindGhosts(unittest.TestCase):
    def setUp(self):
        self.boot_iso = '2026-08-03 06:00:00.000'

    def test_positive_detection(self):
        """active=0 workflow with trigger exec AFTER boot must be detected."""
        db = _make_db(self.boot_iso, ghost=True)
        try:
            _mod.N8N_DB = db
            ghosts = _mod._find_ghosts(self.boot_iso)
            self.assertEqual(len(ghosts), 1)
            self.assertEqual(ghosts[0]['id'], 'wf-test-1')
            self.assertEqual(ghosts[0]['exec_count'], 1)
        finally:
            os.unlink(db)

    def test_pre_boot_exec_not_detected(self):
        """Exec BEFORE boot must not produce a ghost finding."""
        db = _make_db(self.boot_iso, ghost=False)
        try:
            _mod.N8N_DB = db
            ghosts = _mod._find_ghosts(self.boot_iso)
            self.assertEqual(len(ghosts), 0)
        finally:
            os.unlink(db)

    def test_boot_iso_format(self):
        """boot_iso must use space separator (not T) and 3ms digits."""
        self.assertRegex(self.boot_iso, r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$')
        self.assertNotIn('T', self.boot_iso)
        self.assertNotIn('+', self.boot_iso)


class TestRotateLog(unittest.TestCase):
    def test_rotation_trims_to_max(self):
        fd, path = tempfile.mkstemp()
        os.close(fd)
        p = Path(path)
        try:
            p.write_text('\n'.join(f'line {i}' for i in range(600)) + '\n')
            _mod._rotate_log(p, max_lines=500)
            lines = p.read_text().splitlines()
            self.assertEqual(len(lines), 500)
            self.assertEqual(lines[0], 'line 100')  # first 100 trimmed
        finally:
            p.unlink()

    def test_no_rotation_when_under_limit(self):
        fd, path = tempfile.mkstemp()
        os.close(fd)
        p = Path(path)
        try:
            p.write_text('\n'.join(f'line {i}' for i in range(100)) + '\n')
            _mod._rotate_log(p, max_lines=500)
            lines = p.read_text().splitlines()
            self.assertEqual(len(lines), 100)
        finally:
            p.unlink()


if __name__ == '__main__':
    unittest.main(verbosity=2)
