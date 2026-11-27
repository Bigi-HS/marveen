#!/usr/bin/env python3
"""Adversarial tests for the migrate-to-noa.py SAFETY GUARDS (card c80cede3 + 9346ee6a).

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

Additional adversarial fixtures (card 9346ee6a -- realpath-canonicalize bypass):
  REALPATH BYPASS:
    * Passing an ABSOLUTE PATH to the revoked claudeclaw.db is REFUSED (exit 2).
      (os.path.normpath could not catch this -- os.path.realpath can.)
    * Passing a SYMLINK that points to the revoked claudeclaw.db is REFUSED (exit 2).
      (os.path.normpath does not follow symlinks -- os.path.realpath does.)
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


def _run_cli(args, extra_env=None, cwd=None):
    """Run the migrate CLI. ALWAYS inject a guaranteed-absent --review-manifest unless
    the caller supplied one, so the real store/debrand-review.json is never read
    (non-hermetic default-arg leak, see lesson 1116).

    cwd: working directory for the subprocess. Defaults to the caller's cwd (repo-root
    under pytest). The CwdIndependenceGuard tests pass an explicit foreign cwd to prove
    GUARD 1 is anchored to the script dir, not the process cwd."""
    if "--review-manifest" not in args:
        args = [*args, "--review-manifest", os.path.join(tempfile.gettempdir(),
                                                          "guard-test-absent-manifest.json")]
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, _MIG, *args], capture_output=True, text=True, env=env, cwd=cwd
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


class RealpathBypassGuard(unittest.TestCase):
    """Card 9346ee6a: adversarial fixtures for the abs-path and symlink bypass vectors.

    Both tests assert the DANGEROUS direction: an absolute path / symlink alias that
    resolves to store/claudeclaw.db must be REFUSED with exit 2 and must NOT produce
    any output file.  The subprocess inherits cwd=repo-root so realpath('store/claudeclaw.db')
    == realpath('<abs-path-to-repo-root>/store/claudeclaw.db').
    """

    # Repo root is the parent of the directory this file lives in.
    _REPO_ROOT = os.path.dirname(_HERE)

    def _revoked_abs(self):
        """Absolute path to store/claudeclaw.db in the repo root."""
        return os.path.join(self._REPO_ROOT, "store", "claudeclaw.db")

    def test_abs_path_to_revoked_source_is_refused(self):
        """Passing an ABSOLUTE path to the revoked claudeclaw.db is refused (exit 2).

        Before card 9346ee6a the guard used os.path.normpath which does NOT expand
        a relative path to an absolute one, so the absolute form slipped through.
        """
        with tempfile.TemporaryDirectory() as d:
            tgt = os.path.join(d, "out.db")
            abs_revoked = self._revoked_abs()
            r = _run_cli(["--source", abs_revoked, "--target", tgt])
            self.assertNotEqual(
                r.returncode, 0,
                msg=f"absolute-path bypass: CLI accepted the revoked source.\n"
                    f"stdout: {r.stdout}\nstderr: {r.stderr}"
            )
            self.assertIn("REVOKED", r.stderr,
                          msg="Expected 'REVOKED' in stderr; got: " + r.stderr)
            self.assertFalse(
                os.path.exists(tgt),
                msg="Guard should not produce any output file when it refuses."
            )

    def test_symlink_to_revoked_source_is_refused(self):
        """Passing a SYMLINK that points to the revoked claudeclaw.db is refused (exit 2).

        Before card 9346ee6a the guard used os.path.normpath which does NOT follow
        symlinks, so a symlink alias slipped through.  os.path.realpath resolves the
        chain, so both sides land on the same canonical absolute path.
        """
        with tempfile.TemporaryDirectory() as d:
            tgt = os.path.join(d, "out.db")
            # Symlink alias.db -> <abs-path-to-revoked-source>
            # The target file need not exist; realpath compares path strings, not inodes.
            link = os.path.join(d, "alias.db")
            abs_revoked = self._revoked_abs()
            os.symlink(abs_revoked, link)
            r = _run_cli(["--source", link, "--target", tgt])
            self.assertNotEqual(
                r.returncode, 0,
                msg=f"symlink bypass: CLI accepted the revoked source via symlink.\n"
                    f"stdout: {r.stdout}\nstderr: {r.stderr}"
            )
            self.assertIn("REVOKED", r.stderr,
                          msg="Expected 'REVOKED' in stderr; got: " + r.stderr)
            self.assertFalse(
                os.path.exists(tgt),
                msg="Guard should not produce any output file when it refuses."
            )


class HardlinkBypassGuard(unittest.TestCase):
    """Card 1f781314: adversarial fixture for the hardlink bypass vector.

    A hardlink created in a FOREIGN directory has a different canonical path
    (os.path.realpath returns the link's own path, not the target's) so the
    realpath-based guard does NOT catch it -- this is the documented advisory from
    card 1f781314.  The inode/samefile check was explicitly REFUSED during card
    9346ee6a (adds complexity, realpath already handles symlinks; samefile in a
    separate dir is a trust-model question).  TOCTOU is deferred.

    This fixture asserts the CURRENT behavior (bypass allowed) as a regression
    marker: if a future pass adds inode/samefile detection, this test must be
    updated to assert refusal instead (rc != 0, 'REVOKED' in stderr).
    """

    _REPO_ROOT = os.path.dirname(_HERE)

    def _revoked_abs(self):
        return os.path.join(self._REPO_ROOT, "store", "claudeclaw.db")

    def test_hardlink_in_foreign_dir_currently_bypasses_guard(self):
        """Hardlink in /tmp to store/claudeclaw.db bypasses the realpath guard.

        os.path.realpath(link) == /tmp/.../hardlink.db which does NOT equal
        os.path.realpath(revoked_source) == /path/to/marveen/store/claudeclaw.db.
        The guard compares canonicalized paths; different paths -> guard skips.

        ADVISORY: this is fail-open for the hardlink-in-other-dir vector.  The
        trust model requires write access to the foreign directory (attacker already
        has filesystem access), so the risk is LOW and accepted.
        """
        revoked_abs = self._revoked_abs()
        if not os.path.exists(revoked_abs):
            self.skipTest("store/claudeclaw.db absent; cannot create hardlink")
        with tempfile.TemporaryDirectory() as d:
            link = os.path.join(d, "hardlink.db")
            tgt = os.path.join(d, "out.db")
            try:
                os.link(revoked_abs, link)
            except OSError as e:
                self.skipTest(f"os.link failed (cross-device or permissions): {e}")
            r = _run_cli(["--source", link, "--target", tgt])
            # ADVISORY-FLIP triggered (2026-11-27): hardlink-in-foreign-dir NOW blocked
            # (rc=2, 'REVOKED' in stderr). Assertion updated from "rc==0, no REVOKED" to
            # the new hardened behavior.
            self.assertNotEqual(
                r.returncode, 0,
                msg=f"Expected hardlink bypass to be blocked (rc != 0). stdout: {r.stdout}\nstderr: {r.stderr}"
            )
            self.assertIn(
                "REVOKED", r.stderr,
                msg=f"Expected 'REVOKED' in stderr for blocked hardlink. stderr: {r.stderr}"
            )


class CwdIndependenceGuard(unittest.TestCase):
    """Card 9346ee6a REROLL: GUARD 1 must be cwd-INDEPENDENT.

    The original harden realpath'd the RELATIVE constant REVOKED_SOURCE, which anchors
    to the PROCESS cwd -- so the guard only worked when invoked from repo-root and FAILED
    OPEN from any other cwd (`cd /tmp && migrate --source /abs/.../store/claudeclaw.db`
    sailed past). The earlier abs-path/symlink fixtures never caught this because the
    subprocess inherited cwd=repo-root (green for the wrong reason). These tests run the
    CLI from a FOREIGN cwd (a tempdir) and assert the revoked source is STILL refused.

    They assert on "REVOKED" in stderr, NOT merely returncode != 0: on the pre-reroll
    code the guard passes from a foreign cwd and the run fails later with
    "source DB not found" (a DIFFERENT non-zero exit, no "REVOKED") -- so a returncode-only
    check would be a false green. Requiring "REVOKED" pins the guard, not any later error.
    """

    _REPO_ROOT = os.path.dirname(_HERE)

    def _revoked_abs(self):
        return os.path.join(self._REPO_ROOT, "store", "claudeclaw.db")

    def test_abs_revoked_refused_from_foreign_cwd(self):
        """Abs path to the revoked DB, CLI invoked from a tempdir cwd -> still REFUSED."""
        with tempfile.TemporaryDirectory() as d:
            tgt = os.path.join(d, "out.db")
            r = _run_cli(["--source", self._revoked_abs(), "--target", tgt], cwd=d)
            self.assertNotEqual(
                r.returncode, 0,
                msg=f"cwd-independence bypass: CLI accepted the revoked source from a "
                    f"foreign cwd.\nstdout: {r.stdout}\nstderr: {r.stderr}"
            )
            self.assertIn(
                "REVOKED", r.stderr,
                msg="Expected GUARD 1 'REVOKED' refusal (not a later source-not-found "
                    "error) when run from a foreign cwd; got: " + r.stderr
            )
            self.assertFalse(
                os.path.exists(tgt),
                msg="Guard should not produce any output file when it refuses."
            )

    def test_symlink_revoked_refused_from_foreign_cwd(self):
        """Symlink -> revoked DB, CLI invoked from a tempdir cwd -> still REFUSED.

        The symlink itself lives under the foreign cwd; its (absolute) target is the
        repo-root revoked DB. realpath resolves the chain cwd-independently once the
        revoked side is anchored to the script dir.
        """
        with tempfile.TemporaryDirectory() as d:
            tgt = os.path.join(d, "out.db")
            link = os.path.join(d, "alias.db")
            os.symlink(self._revoked_abs(), link)
            # Pass the link by its bare name, resolved against the foreign cwd=d.
            r = _run_cli(["--source", "alias.db", "--target", tgt], cwd=d)
            self.assertNotEqual(
                r.returncode, 0,
                msg=f"cwd-independence bypass via symlink.\nstdout: {r.stdout}\n"
                    f"stderr: {r.stderr}"
            )
            self.assertIn(
                "REVOKED", r.stderr,
                msg="Expected GUARD 1 'REVOKED' refusal from a foreign cwd via symlink; "
                    "got: " + r.stderr
            )
            self.assertFalse(os.path.exists(tgt))


if __name__ == "__main__":
    unittest.main()
