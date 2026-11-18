#!/usr/bin/env python3
"""Adversarial tests for the migrate-to-noa.py SAFETY GUARDS (card c80cede3).

Run: python3 -m pytest scripts/test_migrate_guard.py -q
 or: python3 scripts/test_migrate_guard.py

House style mirrors scripts/test_migrate_to_noa_debrand.py: run the CLI as a
subprocess, temp sqlite fixtures, class-grouped unittest. FULLY HERMETIC -- every
DB and manifest lives under a tempdir; the real store/*.db is NEVER touched. The
subprocess inherits cwd=repo-root, so we ALWAYS pass an explicit --review-manifest
pointing at a guaranteed-absent tmp path (never the real store/debrand-review.json).

Covers two guards (card c80cede3):
  GUARD 1 (revoked-default source):
    * Running with NO explicit --source is REFUSED (exit 2) -- the revoked
      store/claudeclaw.db default (ENG-024) is gone; --source is now required.
    * Passing the revoked path explicitly is ALSO refused (exit 2).
    * A safe explicit --source is accepted (past the guard).
  GUARD 2 (live-target overwrite):
    * Targeting an EXISTING db file WITHOUT --allow-overwrite is REFUSED (exit 2)
      and the existing file is left BYTE-IDENTICAL (asserts the dangerous direction:
      the overwrite does NOT happen).
    * WITH --allow-overwrite the migration proceeds (overwrite is permitted).
"""
import hashlib
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MIG = os.path.join(_HERE, "migrate-to-noa.py")

# Minimal SOURCE memories schema: just the columns migrate_memories reads. Enough
# for a full migration run to succeed so the GUARD-2 opt-in path is exercised.
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


def _make_source(path):
    """A minimal, valid source DB with one clean (non-blocklist) memory row."""
    conn = sqlite3.connect(path)
    conn.executescript(_SRC_MEMORIES_DDL)
    conn.execute(
        "INSERT INTO memories (id, agent_id, category, content, created_at, accessed_at) "
        "VALUES (1, 'noa', 'cold', 'a harmless note', 0, 0)"
    )
    conn.commit()
    conn.close()


def _run_cli(args, extra_env=None):
    """Run the migrate CLI. ALWAYS inject a guaranteed-absent --review-manifest unless
    the caller supplied one, so the real store/debrand-review.json is never read
    (non-hermetic default-arg leak, see lesson 1116)."""
    if "--review-manifest" not in args:
        args = [*args, "--review-manifest", os.path.join(tempfile.gettempdir(),
                                                          "guard-test-absent-manifest.json")]
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, _MIG, *args], capture_output=True, text=True, env=env
    )


def _sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class RevokedDefaultSourceGuard(unittest.TestCase):
    def test_no_source_is_refused(self):
        """No --source at all -> refuse (the old claudeclaw.db implicit default is gone)."""
        with tempfile.TemporaryDirectory() as d:
            tgt = os.path.join(d, "out.db")
            r = _run_cli(["--target", tgt])
            self.assertNotEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            self.assertIn("--source", r.stderr)
            self.assertIn("ENG-024", r.stderr)
            # Safe default must NOT have built anything.
            self.assertFalse(os.path.exists(tgt))

    def test_explicit_revoked_path_is_refused(self):
        """Explicitly pointing --source at the revoked claudeclaw.db is refused."""
        with tempfile.TemporaryDirectory() as d:
            tgt = os.path.join(d, "out.db")
            r = _run_cli(["--source", os.path.join("store", "claudeclaw.db"),
                          "--target", tgt])
            self.assertNotEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            self.assertIn("REVOKED", r.stderr)
            self.assertFalse(os.path.exists(tgt))

    def test_safe_explicit_source_is_allowed(self):
        """A real explicit --source gets PAST guard 1 and completes a migration."""
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "out.db")  # does NOT exist -> no overwrite guard
            _make_source(src)
            r = _run_cli(["--source", src, "--target", tgt])
            self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            self.assertTrue(os.path.exists(tgt))


class LiveTargetOverwriteGuard(unittest.TestCase):
    def test_existing_target_not_overwritten_without_flag(self):
        """DANGEROUS direction: existing target + no opt-in -> refuse AND leave it
        byte-identical. We assert the overwrite does NOT happen."""
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "live.db")
            _make_source(src)
            # Pre-existing "live" target with recognizable, unrelated content.
            sentinel = b"LIVE-DB-DO-NOT-CLOBBER" * 64
            with open(tgt, "wb") as f:
                f.write(sentinel)
            before = _sha256(tgt)

            r = _run_cli(["--source", src, "--target", tgt])  # no --allow-overwrite
            self.assertNotEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            self.assertIn("already exists", r.stderr)
            # The file must be untouched, byte-for-byte.
            self.assertEqual(before, _sha256(tgt),
                             msg="existing target was modified despite no --allow-overwrite")
            with open(tgt, "rb") as f:
                self.assertEqual(f.read(), sentinel)

    def test_existing_target_overwritten_with_flag(self):
        """WITH --allow-overwrite the migration proceeds and replaces the target."""
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.db")
            tgt = os.path.join(d, "live.db")
            _make_source(src)
            with open(tgt, "wb") as f:
                f.write(b"OLD-CONTENT" * 64)
            before = _sha256(tgt)

            r = _run_cli(["--source", src, "--target", tgt, "--allow-overwrite"])
            self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            # A real sqlite DB now lives there, and it is NOT the old sentinel bytes.
            self.assertNotEqual(before, _sha256(tgt))
            conn = sqlite3.connect(tgt)
            n = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            conn.close()
            self.assertEqual(n, 1)


if __name__ == "__main__":
    unittest.main()
