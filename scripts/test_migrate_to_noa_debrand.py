#!/usr/bin/env python3
"""Tests for the Pass-4 memory-migration debrand plumbing in migrate-to-noa.py.

Run: python3 -m pytest scripts/test_migrate_to_noa_debrand.py -q

House style mirrors scripts/hooks/test_egress_pii_scan.py: importlib module load,
temp sqlite fixtures, class-grouped unittest. Hermetic: every DB lives under a
tempdir -- the real store/noa.db is NEVER touched.

Covers spec s6 Pass-4 slice:
  * DEFAULT_AGENT (DA-5) = "noa"; NULL agent_id row migrates to "noa".
  * blocklist_prescan surfaces blocklist-token rows.
  * assert_prescan_reviewed HARD GATE: unreviewed -> sys.exit(3); reviewed -> passes.
  * content transform: REWRITE applies, blocklist row (manifest skip) preserved verbatim.
  * --report NON-MUTATING: target db untouched / not created.
  * row-count parity preserved after a content-rewriting migration.
"""
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MIG = os.path.join(_HERE, "migrate-to-noa.py")
_SCHEMA = os.path.join(_HERE, "schema-noa.sql")

_spec = importlib.util.spec_from_file_location("migrate_to_noa", _MIG)
mig = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mig)


# Minimal SOURCE memories schema: just the columns migrate_memories reads.
_SRC_MEMORIES_DDL = """
CREATE TABLE memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT,
  category    TEXT,
  content     TEXT,
  keywords    TEXT,
  topic_key   TEXT,
  access_scope TEXT,
  embedding   BLOB,
  created_at  INTEGER,
  accessed_at INTEGER
);
"""


def _make_source(path, rows):
    """rows: list of dicts with memories columns (missing -> NULL/defaults)."""
    conn = sqlite3.connect(path)
    conn.executescript(_SRC_MEMORIES_DDL)
    for r in rows:
        conn.execute(
            "INSERT INTO memories (id, agent_id, category, content, keywords, topic_key, "
            "access_scope, embedding, created_at, accessed_at) "
            "VALUES (:id,:agent_id,:category,:content,:keywords,:topic_key,:access_scope,"
            ":embedding,:created_at,:accessed_at)",
            {
                "id": r.get("id"),
                "agent_id": r.get("agent_id"),
                "category": r.get("category", "cold"),
                "content": r.get("content", ""),
                "keywords": r.get("keywords"),
                "topic_key": r.get("topic_key"),
                "access_scope": r.get("access_scope"),
                "embedding": r.get("embedding"),
                "created_at": r.get("created_at", 0),
                "accessed_at": r.get("accessed_at", 0),
            },
        )
    conn.commit()
    conn.close()


def _run_cli(args):
    return subprocess.run(
        [sys.executable, _MIG, *args], capture_output=True, text=True
    )


class DefaultAgentTests(unittest.TestCase):
    def test_default_agent_is_noa(self):
        self.assertEqual(mig.DEFAULT_AGENT, "noa")

    def test_null_agent_row_migrates_to_noa(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            _make_source(src, [{"id": 1, "agent_id": None, "content": "plain note"}])
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            agent = conn.execute("SELECT agent_id FROM memories WHERE id=1").fetchone()[0]
            conn.close()
            self.assertEqual(agent, "noa")


class PrescanGateTests(unittest.TestCase):
    def test_blocklist_prescan_surfaces_row(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            _make_source(
                src,
                [
                    {"id": 1, "content": "quoting com.marveen.channels label"},
                    {"id": 2, "content": "marveen handles routing"},
                ],
            )
            conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
            rows = mig.blocklist_prescan(conn)
            conn.close()
            ids = {r["id"] for r in rows}
            self.assertEqual(ids, {1})

    def test_assert_prescan_reviewed_exits_3_when_unreviewed(self):
        rows = [{"id": 7, "content": "com.marveen.channels"}]
        with self.assertRaises(SystemExit) as cm:
            mig.assert_prescan_reviewed(rows, {})
        self.assertEqual(cm.exception.code, 3)

    def test_assert_prescan_reviewed_passes_when_reviewed(self):
        rows = [{"id": 7, "content": "com.marveen.channels"}]
        # Must not raise.
        mig.assert_prescan_reviewed(rows, {"7": "skip"})

    def test_real_migration_exits_3_with_unreviewed_blocklist_row(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            _make_source(src, [{"id": 1, "content": "quoting com.marveen.channels"}])
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 3, r.stderr)
            self.assertFalse(os.path.exists(tgt))

    def test_reviewed_blocklist_row_preserved_verbatim(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            manifest = os.path.join(d, "review.json")
            _make_source(src, [{"id": 1, "content": "quoting com.marveen.channels"}])
            with open(manifest, "w") as f:
                json.dump({"1": "skip"}, f)
            r = _run_cli(
                ["--source", src, "--target", tgt, "--review-manifest", manifest]
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            content = conn.execute("SELECT content FROM memories WHERE id=1").fetchone()[0]
            conn.close()
            self.assertEqual(content, "quoting com.marveen.channels")
            self.assertNotIn("com.noa.channels", content)


class ContentTransformTests(unittest.TestCase):
    def test_m2_prose_rewritten(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            _make_source(src, [{"id": 1, "content": "marveen handles routing"}])
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            content = conn.execute("SELECT content FROM memories WHERE id=1").fetchone()[0]
            conn.close()
            self.assertEqual(content, "noa handles routing")

    def test_m3_historical_left_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            _make_source(src, [{"id": 1, "content": "formerly marveen, kept for record"}])
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            content = conn.execute("SELECT content FROM memories WHERE id=1").fetchone()[0]
            conn.close()
            self.assertEqual(content, "formerly marveen, kept for record")

    def test_manifest_keep_copies_verbatim(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            manifest = os.path.join(d, "review.json")
            # A row that WOULD rewrite (M2 prose) but is manifest 'keep' -> verbatim.
            _make_source(src, [{"id": 1, "content": "marveen handles routing"}])
            with open(manifest, "w") as f:
                json.dump({"1": "keep"}, f)
            r = _run_cli(
                ["--source", src, "--target", tgt, "--review-manifest", manifest]
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            content = conn.execute("SELECT content FROM memories WHERE id=1").fetchone()[0]
            conn.close()
            self.assertEqual(content, "marveen handles routing")

    def test_row_count_parity_after_rewrite(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            _make_source(
                src,
                [
                    {"id": 1, "content": "marveen handles routing"},
                    {"id": 2, "content": "plain note"},
                    {"id": 3, "content": "/home/domin/marveen/store pointer"},
                ],
            )
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            n = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            conn.close()
            self.assertEqual(n, 3)


class MixedManifestTests(unittest.TestCase):
    def test_mixed_row_partial_rewrite_keeps_blocklist(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            manifest = os.path.join(d, "review.json")
            # A 'mixed' row: a migratable bare `marveen` plus a blocklist token.
            _make_source(
                src,
                [{"id": 1, "content": "marveen routes via com.marveen.channels"}],
            )
            with open(manifest, "w") as f:
                json.dump({"1": "mixed"}, f)
            r = _run_cli(
                ["--source", src, "--target", tgt, "--review-manifest", manifest]
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            content = conn.execute(
                "SELECT content FROM memories WHERE id=1"
            ).fetchone()[0]
            conn.close()
            self.assertEqual(content, "noa routes via com.marveen.channels")
            self.assertIn("com.marveen.channels", content)
            self.assertNotIn("com.noa.channels", content)

    def test_row_count_parity_with_mixed_row(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            manifest = os.path.join(d, "review.json")
            _make_source(
                src,
                [
                    {"id": 1, "content": "marveen routes via com.marveen.channels"},
                    {"id": 2, "content": "plain note"},
                    {"id": 3, "content": "formerly marveen"},
                ],
            )
            # id 1 is the mixed row; id 3 is a blocklist-free M3 historical row
            # (no gate needed). The gate only fires on blocklist-token rows, so
            # review id 1 (it has com.marveen.channels).
            with open(manifest, "w") as f:
                json.dump({"1": "mixed"}, f)
            r = _run_cli(
                ["--source", src, "--target", tgt, "--review-manifest", manifest]
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            n = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            conn.close()
            self.assertEqual(n, 3)


class ReportModeTests(unittest.TestCase):
    def test_report_does_not_create_target(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            _make_source(
                src,
                [
                    {"id": 1, "content": "marveen handles routing"},
                    {"id": 2, "content": "quoting com.marveen.channels"},
                    {"id": 3, "content": "formerly marveen"},
                ],
            )
            r = _run_cli(["--source", src, "--target", tgt, "--report"])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertFalse(os.path.exists(tgt), "report mode must NOT create target")
            self.assertFalse(os.path.exists(tgt + ".tmp"))

    def test_report_does_not_mutate_existing_target(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            _make_source(src, [{"id": 1, "content": "marveen handles routing"}])
            # Pre-existing target with sentinel content.
            with open(tgt, "wb") as f:
                f.write(b"PRE-EXISTING-BYTES")
            before = open(tgt, "rb").read()
            r = _run_cli(["--source", src, "--target", tgt, "--report"])
            self.assertEqual(r.returncode, 0, r.stderr)
            after = open(tgt, "rb").read()
            self.assertEqual(before, after, "report mode must not mutate target")

    def test_report_lists_blocklist_and_glance_candidates(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            _make_source(
                src,
                [
                    {"id": 1, "content": "marveen handles routing"},
                    {"id": 2, "content": "quoting com.marveen.channels"},
                    {"id": 3, "content": "formerly marveen"},
                ],
            )
            r = _run_cli(["--source", src, "--target", tgt, "--report"])
            self.assertEqual(r.returncode, 0, r.stderr)
            # Blocklist review list names id 2; glance candidates name 1 and 3.
            self.assertIn("2", r.stdout)
            self.assertRegex(r.stdout, r"(?i)blocklist")


class DeferredFkContractTests(unittest.TestCase):
    """Contract for the migrate-time foreign_key_check partition (card 55e877e4).

    schema-noa.sql carries M3 FK-ON (four core columns REFERENCE agents(agent_id)),
    but migrate has NO agents dim-table seed step -- that is intentionally POST-cutover
    (scripts/migration/dim-seed.py) with FK enforcement flipped later by fk-on.py.
    So every migrated actor row is an orphan against the empty agents table. Those
    'agents'-parent violations MUST be DEFERRED (exit 0 + notice), not FATAL."""

    def test_agents_orphans_are_deferred_exit_zero_with_notice(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            # agent_id 'ghost' is absent from the (unseeded) agents dim-table ->
            # an agents-parent FK orphan under M3 FK-ON.
            _make_source(src, [{"id": 1, "agent_id": "ghost", "content": "a note"}])
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertTrue(os.path.exists(tgt))
            self.assertIn("DEFERRED FK", r.stdout)
            # Per-child-table orphan count is surfaced.
            self.assertRegex(r.stdout, r"memories=\d+")
            # The old fatal path must NOT have fired for an agents-only orphan.
            self.assertNotIn("ERROR: foreign key violations", r.stderr)

    def test_non_agents_fk_violation_is_fatal(self):
        # Card 83e1e306 MAJOR-4: the prior skip reason ("no non-agents FK target in
        # schema-noa.sql") was FALSE. schema-noa.sql DOES define non-agents FKs --
        # kanban_cards.parent_id and depends_on both REFERENCE kanban_cards(id)
        # (self-referential, NOT the agents dim-table). An orphan parent_id is a real
        # integrity error with no post-cutover seeding story, so it MUST hit the FATAL
        # branch (real = [v for v in fk_violations if v[2] != "agents"] -> ERROR +
        # exit 1), NOT the agents-DEFERRED branch. We synthesize it through the real
        # migrate path (no divergent schema), so this exercises the code, not a fixture.
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "noa.db")
            conn = sqlite3.connect(src)
            conn.executescript(open(_SCHEMA).read())
            # sqlite3 defaults foreign_keys=OFF, so an orphan parent_id can be staged
            # in the source exactly as a real dirty live row would be.
            conn.execute(
                "INSERT INTO kanban_cards (id, title, status, parent_id, assignee, "
                "created_at, updated_at) VALUES "
                "('child-1', 'orphan child', 'planned', 'missing-parent', NULL, 0, 0)"
            )
            conn.commit()
            conn.close()
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertIn("ERROR: foreign key violations", r.stderr)
            # Proves the NON-agents (kanban_cards self-ref) branch fired, not DEFERRED.
            self.assertIn("kanban_cards", r.stderr)
            self.assertNotIn("DEFERRED FK", r.stdout)
            # Fatal abort leaves no target behind.
            self.assertFalse(os.path.exists(tgt))


if __name__ == "__main__":
    unittest.main()
