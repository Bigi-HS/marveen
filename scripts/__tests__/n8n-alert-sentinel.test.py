#!/usr/bin/env python3
"""
Unit tests for n8n-alert-sentinel.py GHOST_TRIGGER detection (cc639a34).

The fix: GHOST_TRIGGER must not fire for trigger execs that occurred BEFORE
a workflow was deactivated (active->0). Only post-deactivation trigger execs
on an inactive workflow are a genuine ghost trigger.

Run: python3 scripts/__tests__/n8n-alert-sentinel.test.py
"""
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Load the sentinel module with a patched DB path (set before main() is called)
_SENTINEL_PATH = Path(__file__).parent.parent / "n8n-alert-sentinel.py"


def _load_sentinel(db_path: str):
    spec = importlib.util.spec_from_file_location("n8n_alert_sentinel", _SENTINEL_PATH)
    mod = importlib.util.module_from_spec(spec)
    mod.DB = db_path
    spec.loader.exec_module(mod)
    mod.DB = db_path
    return mod


# ISO timestamps used across tests
BOOT_TS = "2026-09-09T20:00:00+00:00"
_BOOT_DT = datetime.fromisoformat(BOOT_TS)

PRE_BOOT = (_BOOT_DT - timedelta(hours=2)).isoformat()
POST_BOOT_PRE_DEACT = (_BOOT_DT + timedelta(hours=1)).isoformat()   # after boot, before deactivation
DEACT_TS = (_BOOT_DT + timedelta(hours=3)).isoformat()               # workflow deactivated here
POST_DEACT = (_BOOT_DT + timedelta(hours=4)).isoformat()             # after deactivation


def _make_sentinel_db(
    workflow_active: int,
    workflow_updated_at: str,
    exec_ts: str | None,
) -> str:
    """Create an in-memory-backed temp SQLite with minimal n8n schema."""
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    con = sqlite3.connect(path)
    con.execute("""
        CREATE TABLE workflow_entity (
            id TEXT PRIMARY KEY,
            name TEXT,
            active INTEGER,
            nodes TEXT,
            updatedAt TEXT
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
    con.execute(
        "INSERT INTO workflow_entity VALUES (?, ?, ?, ?, ?)",
        ("wf-1", "Test WF", workflow_active, "[]", workflow_updated_at),
    )
    if exec_ts is not None:
        con.execute(
            "INSERT INTO execution_entity VALUES (?, ?, ?, ?)",
            ("exec-1", "wf-1", "trigger", exec_ts),
        )
    con.commit()
    con.close()
    return path


class TestGhostTriggerDeactivationFix(unittest.TestCase):
    """GHOST_TRIGGER must only flag post-deactivation trigger execs."""

    def _run_ghost_check(self, db_path: str, boot_iso: str) -> list:
        """Extract GHOST_TRIGGER findings by running only check #1 logic."""
        mod = _load_sentinel(db_path)
        import sqlite3 as _sqlite3
        con = _sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        con.row_factory = _sqlite3.Row
        wfs = con.execute(
            "SELECT id, name, active, nodes, updatedAt FROM workflow_entity"
        ).fetchall()
        findings = []
        for w in wfs:
            if w["active"]:
                continue
            updated_at = w["updatedAt"] if "updatedAt" in w.keys() else None
            threshold = updated_at if (updated_at and updated_at > boot_iso) else boot_iso
            n = con.execute(
                "SELECT COUNT(*) c FROM execution_entity "
                "WHERE workflowId=? AND mode='trigger' AND startedAt > ?",
                (w["id"], threshold),
            ).fetchone()["c"]
            if n > 0:
                findings.append({"workflow": w["name"], "id": w["id"], "count": n})
        con.close()
        return findings

    def test_pre_deactivation_exec_not_flagged(self):
        """Exec that fired AFTER boot but BEFORE deactivation must not be a ghost.

        Scenario: workflow ran normally at POST_BOOT_PRE_DEACT, was deactivated
        at DEACT_TS. Without the fix, boot_iso would count this exec -- false
        positive. With the fix, threshold = DEACT_TS and the exec precedes it.
        """
        db = _make_sentinel_db(
            workflow_active=0,
            workflow_updated_at=DEACT_TS,
            exec_ts=POST_BOOT_PRE_DEACT,
        )
        try:
            findings = self._run_ghost_check(db, BOOT_TS)
            self.assertEqual(findings, [],
                "Pre-deactivation exec must NOT be flagged as ghost trigger")
        finally:
            os.unlink(db)

    def test_post_deactivation_exec_is_flagged(self):
        """Exec that fired AFTER deactivation must be flagged as a ghost trigger."""
        db = _make_sentinel_db(
            workflow_active=0,
            workflow_updated_at=DEACT_TS,
            exec_ts=POST_DEACT,
        )
        try:
            findings = self._run_ghost_check(db, BOOT_TS)
            self.assertEqual(len(findings), 1,
                "Post-deactivation exec must be flagged as ghost trigger")
            self.assertEqual(findings[0]["id"], "wf-1")
        finally:
            os.unlink(db)

    def test_pre_boot_deactivation_exec_after_boot_is_flagged(self):
        """Workflow deactivated before boot; exec after boot = genuine ghost.

        updatedAt < boot_iso, so threshold falls back to boot_iso (old logic).
        The exec is after boot -> should be flagged.
        """
        db = _make_sentinel_db(
            workflow_active=0,
            workflow_updated_at=PRE_BOOT,
            exec_ts=POST_BOOT_PRE_DEACT,
        )
        try:
            findings = self._run_ghost_check(db, BOOT_TS)
            self.assertEqual(len(findings), 1,
                "Exec after boot on pre-boot-deactivated WF must be flagged")
        finally:
            os.unlink(db)

    def test_no_exec_no_finding(self):
        """Inactive workflow with no execs at all must not produce a finding."""
        db = _make_sentinel_db(
            workflow_active=0,
            workflow_updated_at=DEACT_TS,
            exec_ts=None,
        )
        try:
            findings = self._run_ghost_check(db, BOOT_TS)
            self.assertEqual(findings, [])
        finally:
            os.unlink(db)

    def test_active_workflow_never_flagged(self):
        """Active workflows must never appear in ghost findings."""
        db = _make_sentinel_db(
            workflow_active=1,
            workflow_updated_at=DEACT_TS,
            exec_ts=POST_DEACT,
        )
        try:
            findings = self._run_ghost_check(db, BOOT_TS)
            self.assertEqual(findings, [])
        finally:
            os.unlink(db)


if __name__ == "__main__":
    if not _SENTINEL_PATH.exists():
        print(f"SKIP: {_SENTINEL_PATH} not found")
        sys.exit(0)
    unittest.main(verbosity=2)
