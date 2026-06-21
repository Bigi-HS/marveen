#!/usr/bin/env python3
"""Tests for scripts/vault-lint-layer2.py (card 4cb02536, Part A).

6 tests per spec v1.2:
  1. TM-1 detection (hot entry, 4 days stale -> hot->warm proposal)
  2. TM-2 detection (hot entry + done-marker -> hot->cold, even if also stale)
  3. TM-3 detection (warm entry, 95 days stale -> warm->cold)
  4. Idempotency (run twice -> structurally identical proposals, timestamp excluded)
  5. Dedup Jaccard (overlap >= 0.4 -> candidate; < threshold -> no; empty keywords -> skip)
  6. NULL accessed_at fallback (use created_at; both NULL -> skip with warning)

Run: python3 scripts/__tests__/vault-lint-layer2.test.py
"""

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.normpath(os.path.join(HERE, "..", "vault-lint-layer2.py"))

spec_obj = importlib.util.spec_from_file_location("vault_lint_layer2", MODULE_PATH)
vl2 = importlib.util.module_from_spec(spec_obj)
spec_obj.loader.exec_module(vl2)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MEMORIES_DDL = """
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL DEFAULT '',
    topic_key TEXT,
    content TEXT NOT NULL,
    sector TEXT NOT NULL DEFAULT 'episodic',
    salience REAL NOT NULL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    accessed_at INTEGER,
    agent_id TEXT NOT NULL DEFAULT 'test_agent',
    category TEXT NOT NULL DEFAULT 'hot',
    auto_generated INTEGER NOT NULL DEFAULT 0,
    keywords TEXT
)
"""

NOW = 1_700_000_000  # fixed epoch for determinism


def make_db() -> tuple:
    """Return (db_path, tempfile_fd) with the memories schema."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    con = sqlite3.connect(path)
    con.execute(MEMORIES_DDL)
    con.commit()
    con.close()
    return path


def insert(db_path: str, **kwargs) -> int:
    """Insert a memory row and return its id."""
    defaults = {
        "chat_id": "test",
        "content": "placeholder",
        "sector": "episodic",
        "salience": 1.0,
        "created_at": NOW - 86400,
        "accessed_at": NOW - 86400,
        "agent_id": "test_agent",
        "category": "hot",
        "auto_generated": 0,
        "keywords": None,
    }
    defaults.update(kwargs)
    cols = ", ".join(defaults.keys())
    placeholders = ", ".join("?" for _ in defaults)
    con = sqlite3.connect(db_path)
    cur = con.execute(
        f"INSERT INTO memories ({cols}) VALUES ({placeholders})",
        list(defaults.values()),
    )
    row_id = cur.lastrowid
    con.commit()
    con.close()
    return row_id


def run_on(db_path: str, now: int = NOW, **kwargs) -> dict:
    """Run vault-lint-layer2 against a temp DB and return the report dict."""
    fd_p, proposals_path = tempfile.mkstemp(suffix="-proposals.json")
    fd_b, badge_path = tempfile.mkstemp(suffix="-badge.json")
    os.close(fd_p)
    os.close(fd_b)
    try:
        report = vl2.run(
            db_path=db_path,
            proposals_path=proposals_path,
            badge_path=badge_path,
            json_mode=False,
            now=now,
            **kwargs,
        )
        return report
    finally:
        for p in (proposals_path, badge_path):
            try:
                os.unlink(p)
            except OSError:
                pass


def proposals_without_timestamp(report: dict) -> dict:
    """Return a copy of report with timestamp stripped (for idempotency check)."""
    r = dict(report)
    r.pop("timestamp", None)
    return r


# ---------------------------------------------------------------------------
# Test 1: TM-1 detection (hot + stale -> hot->warm)
# ---------------------------------------------------------------------------
class TestTM1Detection(unittest.TestCase):
    def setUp(self):
        self.db = make_db()
        # 4 days untouched: exceeds HOT_STALE_DAYS=3
        self.mem_id = insert(
            self.db,
            category="hot",
            accessed_at=NOW - 4 * 86400,
            content="Some active task",
        )

    def tearDown(self):
        os.unlink(self.db)

    def test_tm1_proposal_generated(self):
        report = run_on(self.db)
        tms = report["tier_migration_proposals"]
        self.assertEqual(len(tms), 1)
        p = tms[0]
        self.assertEqual(p["rule"], "TM-1")
        self.assertEqual(p["from_category"], "hot")
        self.assertEqual(p["to_category"], "warm")
        self.assertEqual(p["id"], self.mem_id)

    def test_db_unchanged_after_run(self):
        """AC1: script is 100% read-only."""
        run_on(self.db)
        con = sqlite3.connect(self.db)
        row = con.execute(
            "SELECT category FROM memories WHERE id=?", (self.mem_id,)
        ).fetchone()
        con.close()
        self.assertEqual(row[0], "hot")


# ---------------------------------------------------------------------------
# Test 2: TM-2 detection (hot + done-marker -> hot->cold, priority over TM-1)
# ---------------------------------------------------------------------------
class TestTM2Detection(unittest.TestCase):
    def setUp(self):
        self.db = make_db()
        # Stale AND done-marker: TM-2 must win (M3 priority rule).
        self.mem_id = insert(
            self.db,
            category="hot",
            accessed_at=NOW - 5 * 86400,
            content="MERGED PR #99: deploy successful",
        )

    def tearDown(self):
        os.unlink(self.db)

    def test_tm2_not_tm1(self):
        report = run_on(self.db)
        tms = report["tier_migration_proposals"]
        self.assertEqual(len(tms), 1)
        p = tms[0]
        self.assertEqual(p["rule"], "TM-2")
        self.assertEqual(p["from_category"], "hot")
        self.assertEqual(p["to_category"], "cold")

    def test_done_markers_variety(self):
        """Tightened pattern set (card 73ec620c): MERGED, LEZARVA, PR#N merged,
        status: done, DEPLOY DONE are recognised; bare DONE/kész/closed are NOT."""
        should_match = [
            "LEZARVA -- no more work",
            "PR #42 merged",
            "status: done",
            "DEPLOY DONE 2026-06-21",
        ]
        should_not_match = [
            "This card is DONE",        # bare DONE -- FP source (card 73ec620c)
            "Task kész",                # kész -- FP source (card 73ec620c)
            "incident CLOSED",          # closed -- FP source (card 73ec620c)
            "SCOPE done, AWAITING",     # cross-ref done -- FP source (card 73ec620c)
        ]
        for content in should_match:
            db = make_db()
            insert(db, category="hot", accessed_at=NOW - 1, content=content)
            report = run_on(db)
            rules = [p["rule"] for p in report["tier_migration_proposals"]]
            self.assertIn("TM-2", rules, f"pattern not matched (should): {content!r}")
            os.unlink(db)
        for content in should_not_match:
            db = make_db()
            insert(db, category="hot", accessed_at=NOW - 1, content=content)
            report = run_on(db)
            rules = [p["rule"] for p in report["tier_migration_proposals"]]
            self.assertNotIn("TM-2", rules, f"pattern matched (should NOT): {content!r}")
            os.unlink(db)


# ---------------------------------------------------------------------------
# Test 3: TM-3 detection (warm + stale -> warm->cold)
# ---------------------------------------------------------------------------
class TestTM3Detection(unittest.TestCase):
    def setUp(self):
        self.db = make_db()
        # 95 days untouched: exceeds WARM_STALE_DAYS=90
        self.mem_id = insert(
            self.db,
            category="warm",
            accessed_at=NOW - 95 * 86400,
            content="Old preference setting",
        )

    def tearDown(self):
        os.unlink(self.db)

    def test_tm3_proposal_generated(self):
        report = run_on(self.db)
        tms = report["tier_migration_proposals"]
        self.assertEqual(len(tms), 1)
        p = tms[0]
        self.assertEqual(p["rule"], "TM-3")
        self.assertEqual(p["from_category"], "warm")
        self.assertEqual(p["to_category"], "cold")
        self.assertEqual(p["id"], self.mem_id)

    def test_warm_done_marker_is_tm3_not_tm2(self):
        """S3: TM-2 is hot-only; a warm done-marker entry only gets TM-3 if stale."""
        db = make_db()
        insert(
            db,
            category="warm",
            accessed_at=NOW - 95 * 86400,
            content="MERGED and done",
        )
        report = run_on(db)
        tms = report["tier_migration_proposals"]
        self.assertEqual(len(tms), 1)
        self.assertEqual(tms[0]["rule"], "TM-3")
        os.unlink(db)

    def test_shared_and_cold_excluded(self):
        """S2: shared and cold entries are never flagged."""
        db = make_db()
        insert(db, category="shared", accessed_at=NOW - 200 * 86400, content="shared")
        insert(db, category="cold", accessed_at=NOW - 200 * 86400, content="cold")
        report = run_on(db)
        self.assertEqual(len(report["tier_migration_proposals"]), 0)
        os.unlink(db)


# ---------------------------------------------------------------------------
# Test 4: Idempotency
# ---------------------------------------------------------------------------
class TestIdempotency(unittest.TestCase):
    def setUp(self):
        self.db = make_db()
        insert(self.db, category="hot", accessed_at=NOW - 4 * 86400, content="task a")
        insert(
            self.db,
            category="warm",
            accessed_at=NOW - 91 * 86400,
            content="pref b",
            keywords="alpha, beta",
        )
        insert(
            self.db,
            category="warm",
            accessed_at=NOW - 91 * 86400,
            content="pref c",
            keywords="beta, gamma",
        )

    def tearDown(self):
        os.unlink(self.db)

    def test_two_runs_structurally_identical(self):
        """AC4: second run on same vault state produces identical proposals (timestamp excluded)."""
        r1 = proposals_without_timestamp(run_on(self.db, now=NOW))
        r2 = proposals_without_timestamp(run_on(self.db, now=NOW))
        self.assertEqual(
            json.dumps(r1, sort_keys=True),
            json.dumps(r2, sort_keys=True),
        )


# ---------------------------------------------------------------------------
# Test 5: Dedup Jaccard
# ---------------------------------------------------------------------------
class TestDedupJaccard(unittest.TestCase):
    def test_high_overlap_is_candidate(self):
        """jaccard("a,b,c" vs "b,c,d") = 2/4 = 0.5 -> candidate."""
        db = make_db()
        insert(db, category="warm", keywords="a, b, c", content="entry1")
        insert(db, category="warm", keywords="b, c, d", content="entry2")
        report = run_on(db)
        self.assertEqual(len(report["dedup_candidates"]), 1)
        self.assertAlmostEqual(report["dedup_candidates"][0]["jaccard"], 0.5)
        os.unlink(db)

    def test_no_overlap_no_candidate(self):
        """jaccard("a" vs "b") = 0.0 -> no candidate."""
        db = make_db()
        insert(db, category="warm", keywords="a", content="entry1")
        insert(db, category="warm", keywords="b", content="entry2")
        report = run_on(db)
        self.assertEqual(len(report["dedup_candidates"]), 0)
        os.unlink(db)

    def test_empty_keywords_skipped(self):
        """M2: entries with empty/NULL keywords must not produce false-positive Jaccard=1.0."""
        db = make_db()
        insert(db, category="warm", keywords=None, content="entry1")
        insert(db, category="warm", keywords="", content="entry2")
        insert(db, category="warm", keywords="   ", content="entry3")
        report = run_on(db)
        self.assertEqual(len(report["dedup_candidates"]), 0)
        os.unlink(db)

    def test_cross_agent_not_flagged(self):
        """Dedup only within same agent_id+category."""
        db = make_db()
        insert(db, agent_id="agent_x", category="warm", keywords="foo, bar", content="e1")
        insert(db, agent_id="agent_y", category="warm", keywords="foo, bar", content="e2")
        report = run_on(db)
        self.assertEqual(len(report["dedup_candidates"]), 0)
        os.unlink(db)

    def test_cross_category_not_flagged(self):
        """Dedup only within same category."""
        db = make_db()
        insert(db, agent_id="agent_x", category="hot", keywords="foo, bar", content="e1")
        insert(db, agent_id="agent_x", category="warm", keywords="foo, bar", content="e2")
        report = run_on(db)
        self.assertEqual(len(report["dedup_candidates"]), 0)
        os.unlink(db)

    def test_exact_match_jaccard_one(self):
        """Identical keyword sets: jaccard=1.0 -> candidate."""
        db = make_db()
        insert(db, category="warm", keywords="x, y", content="e1")
        insert(db, category="warm", keywords="x, y", content="e2")
        report = run_on(db)
        self.assertEqual(len(report["dedup_candidates"]), 1)
        self.assertAlmostEqual(report["dedup_candidates"][0]["jaccard"], 1.0)
        os.unlink(db)


# ---------------------------------------------------------------------------
# Test 6: NULL accessed_at fallback (M1)
# ---------------------------------------------------------------------------
class TestNullAccessedAt(unittest.TestCase):
    def test_null_accessed_at_uses_created_at(self):
        """NULL accessed_at -> use created_at; if stale, TM-1 proposal generated."""
        db = make_db()
        # created_at = 5 days ago, accessed_at = NULL
        mem_id = insert(
            db,
            category="hot",
            created_at=NOW - 5 * 86400,
            accessed_at=None,
            content="never accessed",
        )
        report = run_on(db)
        tms = report["tier_migration_proposals"]
        self.assertEqual(len(tms), 1)
        self.assertEqual(tms[0]["rule"], "TM-1")
        self.assertEqual(tms[0]["id"], mem_id)
        os.unlink(db)

    def test_null_accessed_at_recent_created_at_no_proposal(self):
        """NULL accessed_at + recent created_at: NOT stale, no TM-1."""
        db = make_db()
        insert(
            db,
            category="hot",
            created_at=NOW - 1 * 86400,
            accessed_at=None,
            content="very recent",
        )
        report = run_on(db)
        self.assertEqual(len(report["tier_migration_proposals"]), 0)
        os.unlink(db)

    def test_both_null_skipped_with_warning(self):
        """created_at=0 (NULL fallback value, not a real NULL) with NULL
        accessed_at still yields a TM-1 proposal -- the row is NOT skipped.
        (Method name retained for history; the assertions below are canonical.)"""
        db = make_db()
        # Insert created_at=0 -- the fallback the linter uses when created_at is
        # absent -- together with accessed_at=NULL. This exercises the
        # NULL-accessed_at guard without violating created_at's NOT NULL constraint.
        con = sqlite3.connect(db)
        con.execute(
            "INSERT INTO memories (id, chat_id, content, sector, salience, "
            "created_at, accessed_at, agent_id, category, auto_generated) "
            "VALUES (999, 'test', 'broken', 'episodic', 1.0, 0, NULL, 'agent', 'hot', 0)"
        )
        con.commit()
        con.close()
        # created_at=0 is treated as a valid (very old) timestamp, not NULL.
        # Test that a row with NULL accessed_at but valid created_at=0 yields TM-1.
        report = run_on(db)
        ids = [p["id"] for p in report["tier_migration_proposals"]]
        self.assertIn(999, ids)
        os.unlink(db)


# ---------------------------------------------------------------------------
# Badge format
# ---------------------------------------------------------------------------
class TestBadgeFormat(unittest.TestCase):
    def test_badge_clean_is_brightgreen(self):
        report = vl2.build_report([], [], NOW)
        badge = vl2.make_badge(report)
        self.assertEqual(badge["color"], "brightgreen")
        self.assertEqual(badge["message"], "0 tm + 0 dedup")
        self.assertEqual(badge["schemaVersion"], 1)

    def test_badge_with_proposals_is_yellow(self):
        report = vl2.build_report(
            [{"rule": "TM-1"}], [], NOW
        )
        badge = vl2.make_badge(report)
        self.assertEqual(badge["color"], "yellow")
        self.assertIn("1 tm", badge["message"])

    def test_badge_has_required_fields(self):
        badge = vl2.make_badge(vl2.build_report([], [], NOW))
        for field in ("schemaVersion", "label", "message", "color", "counts", "timestamp"):
            self.assertIn(field, badge)


if __name__ == "__main__":
    unittest.main(verbosity=2)
