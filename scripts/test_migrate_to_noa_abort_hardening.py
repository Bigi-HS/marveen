#!/usr/bin/env python3
"""Tests for the two independent migrate-to-noa.py cutover aborts (card fec5ec6a).

Run: python3 -m pytest scripts/test_migrate_to_noa_abort_hardening.py -q

House style mirrors scripts/test_migrate_to_noa_debrand.py: importlib module
load, temp sqlite fixtures under a tempdir, class-grouped unittest. Hermetic:
every DB lives under a TemporaryDirectory -- the real store/noa.db is NEVER
touched.

Covers the two cutover blockers proven by an end-to-end dry-run:

  * BLOCKER-1 (board_columns UNIQUE PK collision): schema-noa.sql pre-seeds 5
    board_columns rows at CREATE time; migrate_verbatim copied source rows with
    a plain INSERT -> UNIQUE constraint failed: board_columns.id -> exit 1, no
    target produced. Fix: INSERT OR IGNORE for schema-seeded base tables.
  * BLOCKER-2 (embedding_cache parity mismatch): the verbatim loop deliberately
    SKIPS embedding_cache (rebuildable cache), but the parity loop did not
    exempt it -> source 2249 vs target 0 -> parity mismatch -> exit 1 even once
    BLOCKER-1 is fixed. Fix: exempt the same not-migrated tables from parity.
"""
import importlib.util
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


def _make_source(path, *, embedding_cache_rows=0, board_column_override=None):
    """Build a minimal source DB by applying the FULL target schema to it.

    Applying schema-noa.sql auto-seeds the 5 canonical board_columns rows and
    creates the embedding_cache table -- exactly the two shapes that trigger the
    cutover aborts. We then add a couple of memories rows (a migrated core table
    with real data) and optionally some embedding_cache rows.

    board_column_override: optional (id, label, sort_order, is_terminal) tuple to
    DIVERGE one seeded board_columns row from the canonical seed -- used by the
    parity sanity check.
    """
    conn = sqlite3.connect(path)
    conn.executescript(open(_SCHEMA).read())
    # A few memories rows so a real migrated core table has data to copy.
    for i in (1, 2):
        conn.execute(
            "INSERT INTO memories (id, agent_id, category, content, created_at, accessed_at) "
            "VALUES (?,?,?,?,?,?)",
            (i, "noa", "cold", f"note {i}", 0, 0),
        )
    for i in range(embedding_cache_rows):
        conn.execute(
            "INSERT INTO embedding_cache (content_hash, model, embedding, created_at) "
            "VALUES (?,?,?,?)",
            (f"hash{i}", "model-x", b"\x00\x00\x00\x00", 0),
        )
    if board_column_override is not None:
        cid, label, sort_order, is_terminal = board_column_override
        conn.execute(
            "UPDATE board_columns SET label=?, sort_order=?, is_terminal=? WHERE id=?",
            (label, sort_order, is_terminal, cid),
        )
    conn.commit()
    conn.close()


def _run_cli(args):
    return subprocess.run([sys.executable, _MIG, *args], capture_output=True, text=True)


class Blocker1BoardColumnsTests(unittest.TestCase):
    """board_columns schema-seed vs verbatim-copy UNIQUE collision."""

    def test_schema_seeds_five_board_columns(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            _make_source(src)
            conn = sqlite3.connect(src)
            n = conn.execute("SELECT COUNT(*) FROM board_columns").fetchone()[0]
            conn.close()
            self.assertEqual(n, 5)

    def test_board_columns_is_a_schema_seeded_table(self):
        # The fix enumerates schema-seeded base tables into a constant; board_columns
        # MUST be in it (it is the proven collision).
        self.assertIn("board_columns", mig.SCHEMA_SEEDED_TABLES)

    def test_migration_does_not_abort_on_board_columns_collision(self):
        """GREEN: full migrate with the seeded board_columns no longer aborts."""
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "out.db")
            _make_source(src, embedding_cache_rows=3)
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn("UNIQUE constraint failed", r.stderr)
            self.assertTrue(os.path.exists(tgt))

    def test_board_columns_has_exactly_five_rows_after_migration(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "out.db")
            _make_source(src, embedding_cache_rows=3)
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            n = conn.execute("SELECT COUNT(*) FROM board_columns").fetchone()[0]
            conn.close()
            self.assertEqual(n, 5)


class Blocker2EmbeddingCacheParityTests(unittest.TestCase):
    """embedding_cache is deliberately not migrated -> must be parity-exempt too."""

    def test_embedding_cache_in_skip_set(self):
        # The fix reuses a named set for "tables not migrated" in BOTH loops.
        self.assertIn("embedding_cache", mig.NOT_MIGRATED)

    def test_migration_succeeds_with_source_embedding_cache_rows(self):
        """GREEN: source has embedding_cache rows, target has 0, NO parity abort."""
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "out.db")
            _make_source(src, embedding_cache_rows=5)
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn("parity mismatch", r.stderr)
            self.assertNotIn("embedding_cache", r.stderr)

    def test_embedding_cache_not_copied_to_target(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "out.db")
            _make_source(src, embedding_cache_rows=5)
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            n = conn.execute("SELECT COUNT(*) FROM embedding_cache").fetchone()[0]
            conn.close()
            self.assertEqual(n, 0)


class EndToEndTests(unittest.TestCase):
    """Both fixes together: end-to-end green cutover on a realistic fixture."""

    def test_full_migration_exit0_and_core_parity(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "out.db")
            _make_source(src, embedding_cache_rows=7)
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(os.path.exists(tgt))
            # Spot-check: a migrated core table row-count matches source.
            s = sqlite3.connect(src)
            t = sqlite3.connect(tgt)
            src_mem = s.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            tgt_mem = t.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            s.close()
            t.close()
            self.assertEqual(src_mem, 2)
            self.assertEqual(tgt_mem, src_mem)

    def test_diverging_seeded_row_stops_and_reports(self):
        """SANITY CHECK (card fec5ec6a): a source row that DIVERGES from the schema
        seed for a seeded table must STOP and report, not silently pick one.

        INSERT OR IGNORE would silently keep the canonical seed and drop the source
        divergence (quietly breaking fresh==migrated parity if the two genuinely
        differ). The migration must abort (exit 1) with a clear divergence message
        and produce NO target instead.
        """
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "out.db")
            _make_source(
                src,
                embedding_cache_rows=1,
                board_column_override=("planned", "DIVERGENT-LABEL", 9.0, 1),
            )
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn("DIVERGES", r.stderr)
            self.assertFalse(os.path.exists(tgt))

    def test_identical_seeded_row_migrates_cleanly(self):
        """A source seeded-table row IDENTICAL to the canonical seed is a no-op under
        INSERT OR IGNORE -- migration succeeds and the canonical seed is preserved.
        """
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "out.db")
            # No override: source board_columns == canonical seed byte-for-byte.
            _make_source(src, embedding_cache_rows=1)
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, r.stderr)
            conn = sqlite3.connect(tgt)
            label = conn.execute(
                "SELECT label FROM board_columns WHERE id='planned'"
            ).fetchone()[0]
            conn.close()
            self.assertEqual(label, "Tervezett")


if __name__ == "__main__":
    unittest.main()
