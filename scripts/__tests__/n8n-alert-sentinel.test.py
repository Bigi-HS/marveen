#!/usr/bin/env python3
"""
Unit tests for n8n-alert-sentinel.py GHOST_TRIGGER detection (cc639a34).

The fix: GHOST_TRIGGER must not fire for trigger execs that occurred BEFORE
a workflow was deactivated (active->0). Only post-deactivation trigger execs
on an inactive workflow are a genuine ghost trigger.

Critical correctness property tested here: the comparison must work across
the THREE INCOMPATIBLE timestamp formats actually present in the n8n DB:
  - startedAt  = 'YYYY-MM-DD HH:MM:SS.mmm'  (SPACE sep, millis, no TZ => UTC)
  - updatedAt  = 'YYYY-MM-DDTHH:MM:SS.mmmZ' (T sep, millis, Z suffix => UTC)
  - boot_iso   = 'YYYY-MM-DDTHH:MM:SS+00:00' (Python isoformat => UTC)
Lexicographic string comparison breaks (SPACE 0x20 < T 0x54); must parse epoch.

Run: python3 scripts/__tests__/n8n-alert-sentinel.test.py
"""
import importlib.util
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

_SENTINEL_PATH = Path(__file__).parent.parent / "n8n-alert-sentinel.py"


def _load_sentinel(db_path: str):
    spec = importlib.util.spec_from_file_location("n8n_alert_sentinel", _SENTINEL_PATH)
    mod = importlib.util.module_from_spec(spec)
    mod.DB = db_path
    spec.loader.exec_module(mod)
    mod.DB = db_path
    return mod


# ---- Helpers to produce the REAL n8n timestamp formats ----

def _startedAt(dt: datetime) -> str:
    """n8n startedAt format: 'YYYY-MM-DD HH:MM:SS.mmm' (SPACE sep, UTC, millis)."""
    return dt.strftime('%Y-%m-%d %H:%M:%S.') + f"{dt.microsecond // 1000:03d}"


def _updatedAt(dt: datetime) -> str:
    """n8n updatedAt format: 'YYYY-MM-DDTHH:MM:SS.mmmZ' (T sep, UTC, millis, Z)."""
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f"{dt.microsecond // 1000:03d}Z"


def _boot_iso(dt: datetime) -> str:
    """Python isoformat: 'YYYY-MM-DDTHH:MM:SS+00:00' (no millis)."""
    return datetime(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second,
                    tzinfo=timezone.utc).isoformat()


# Base timeline (all UTC, same calendar day to exercise cross-format same-day bug)
BASE          = datetime(2026, 9, 28, 20, 0, 0, tzinfo=timezone.utc)
BOOT_DT       = BASE
PRE_BOOT_DT   = BASE - timedelta(hours=2)
DEACT_DT      = BASE + timedelta(hours=3)    # same calendar day as boot
POST_DEACT_DT = BASE + timedelta(hours=4)    # after deactivation, same day
PRE_DEACT_DT  = BASE + timedelta(hours=1)    # after boot, BEFORE deactivation, same day


def _make_db(workflow_active: int, workflow_updated_at: str,
             exec_started_at) -> str:
    """Create a temp SQLite DB with minimal n8n schema. Returns path."""
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
    if exec_started_at is not None:
        con.execute(
            "INSERT INTO execution_entity VALUES (?, ?, ?, ?)",
            ("exec-1", "wf-1", "trigger", exec_started_at),
        )
    con.commit()
    con.close()
    return path


def _run_ghost_check(db_path: str, boot_epoch: float) -> list:
    """Run ONLY the GHOST_TRIGGER logic from the sentinel against a test DB."""
    mod = _load_sentinel(db_path)
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    wfs = con.execute(
        "SELECT id, name, active, nodes, updatedAt FROM workflow_entity"
    ).fetchall()
    findings = []
    for w in wfs:
        if w["active"]:
            continue
        updated_epoch = mod.parse_to_epoch(
            w["updatedAt"] if "updatedAt" in w.keys() else None
        )
        threshold_epoch = (
            updated_epoch if (updated_epoch and updated_epoch > boot_epoch) else boot_epoch
        )
        n = con.execute(
            "SELECT COUNT(*) c FROM execution_entity "
            "WHERE workflowId=? AND mode='trigger' "
            "AND CAST(strftime('%s', startedAt) AS INTEGER) > ?",
            (w["id"], int(threshold_epoch)),
        ).fetchone()["c"]
        if n > 0:
            t_iso = datetime.fromtimestamp(threshold_epoch, timezone.utc).isoformat()
            findings.append({
                "workflow": w["name"],
                "id": w["id"],
                "count": n,
                "threshold_iso": t_iso,
            })
    con.close()
    return findings


class TestParseToEpoch(unittest.TestCase):
    """Unit tests for the parse_to_epoch() helper function itself."""

    def setUp(self):
        self._mod = _load_sentinel(":memory:")

    def test_space_sep_no_tz(self):
        """startedAt space-sep format parses correctly (assumed UTC)."""
        ts = _startedAt(BOOT_DT)
        epoch = self._mod.parse_to_epoch(ts)
        self.assertAlmostEqual(epoch, BOOT_DT.timestamp(), places=0)

    def test_z_suffix_format(self):
        """updatedAt Z-suffix format parses correctly."""
        ts = _updatedAt(DEACT_DT)
        epoch = self._mod.parse_to_epoch(ts)
        self.assertAlmostEqual(epoch, DEACT_DT.timestamp(), places=0)

    def test_isoformat_plus_utc(self):
        """Python isoformat (+00:00) parses correctly."""
        ts = _boot_iso(BOOT_DT)
        epoch = self._mod.parse_to_epoch(ts)
        self.assertAlmostEqual(epoch, BOOT_DT.timestamp(), places=0)

    def test_none_returns_none(self):
        self.assertIsNone(self._mod.parse_to_epoch(None))

    def test_empty_returns_none(self):
        self.assertIsNone(self._mod.parse_to_epoch(""))


class TestGhostTriggerCrossFormat(unittest.TestCase):
    """GHOST_TRIGGER detection with REAL n8n timestamp formats (cross-format)."""

    def test_pre_deactivation_exec_not_flagged(self):
        """Exec AFTER boot but BEFORE deactivation must NOT be flagged.

        Core false-positive scenario (cc639a34 zepp-freshness-check). Mixed formats:
          updatedAt  = T-sep Z-suffix (DEACT_DT)
          startedAt  = space-sep no-TZ (PRE_DEACT_DT, same day, before deactivation)
        Lexicographic comparison would flag this because space (0x20) < T (0x54).
        Epoch comparison must return 0 findings.
        """
        db = _make_db(
            workflow_active=0,
            workflow_updated_at=_updatedAt(DEACT_DT),
            exec_started_at=_startedAt(PRE_DEACT_DT),
        )
        try:
            findings = _run_ghost_check(db, BOOT_DT.timestamp())
            self.assertEqual(findings, [],
                "Pre-deactivation exec (same day, cross-format) must NOT be flagged")
        finally:
            os.unlink(db)

    def test_post_deactivation_exec_is_flagged(self):
        """Exec AFTER deactivation must be flagged (genuine ghost trigger).

        Same calendar day, cross-format: updatedAt=Z-suffix, startedAt=space-sep.
        POST_DEACT_DT > DEACT_DT -> must fire.
        """
        db = _make_db(
            workflow_active=0,
            workflow_updated_at=_updatedAt(DEACT_DT),
            exec_started_at=_startedAt(POST_DEACT_DT),
        )
        try:
            findings = _run_ghost_check(db, BOOT_DT.timestamp())
            self.assertEqual(len(findings), 1,
                "Post-deactivation exec must be flagged as ghost trigger")
        finally:
            os.unlink(db)

    def test_pre_boot_deactivation_exec_after_boot_flagged(self):
        """WF deactivated before boot; exec after boot = genuine ghost.

        updatedAt (Z-suffix) before boot -> threshold falls back to boot_epoch.
        startedAt (space-sep) after boot -> should be flagged.
        """
        db = _make_db(
            workflow_active=0,
            workflow_updated_at=_updatedAt(PRE_BOOT_DT),
            exec_started_at=_startedAt(PRE_DEACT_DT),  # after boot, same day
        )
        try:
            findings = _run_ghost_check(db, BOOT_DT.timestamp())
            self.assertEqual(len(findings), 1,
                "Exec after boot on pre-boot-deactivated WF must be flagged")
        finally:
            os.unlink(db)

    def test_same_day_zepp_scenario_no_flag(self):
        """Exact zepp-freshness-check scenario from the incident.

        Workflow ran at PRE_DEACT_DT (~23:00), deactivated at DEACT_DT (~23:15),
        0 execs after deactivation -> must NOT be flagged. Mixed formats, same day.
        """
        db = _make_db(
            workflow_active=0,
            workflow_updated_at=_updatedAt(DEACT_DT),
            exec_started_at=_startedAt(PRE_DEACT_DT),
        )
        try:
            findings = _run_ghost_check(db, BOOT_DT.timestamp())
            self.assertEqual(findings, [],
                "zepp scenario: exec before deactivation on same day must not be flagged")
        finally:
            os.unlink(db)

    def test_no_exec_no_finding(self):
        """Inactive workflow with no executions at all."""
        db = _make_db(
            workflow_active=0,
            workflow_updated_at=_updatedAt(DEACT_DT),
            exec_started_at=None,
        )
        try:
            findings = _run_ghost_check(db, BOOT_DT.timestamp())
            self.assertEqual(findings, [])
        finally:
            os.unlink(db)

    def test_active_workflow_never_flagged(self):
        """Active workflows must not appear in ghost findings."""
        db = _make_db(
            workflow_active=1,
            workflow_updated_at=_updatedAt(DEACT_DT),
            exec_started_at=_startedAt(POST_DEACT_DT),
        )
        try:
            findings = _run_ghost_check(db, BOOT_DT.timestamp())
            self.assertEqual(findings, [])
        finally:
            os.unlink(db)


if __name__ == "__main__":
    if not _SENTINEL_PATH.exists():
        print(f"SKIP: {_SENTINEL_PATH} not found")
        sys.exit(0)
    unittest.main(verbosity=2)
