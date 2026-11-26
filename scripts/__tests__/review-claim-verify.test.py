#!/usr/bin/env python3
"""Adversarial tests for scripts/review-claim-verify.py (card f725adcd).

Design goals (detector-dod-gate):
  - Cover the DANGEROUS directions explicitly: a reviewer-inferred claim that is
    stale/wrong must be FLAGGED, not silently OK.
  - CWD-independence: the subprocess fixture uses a tempdir as CWD (not the repo
    root) to exercise the hostile-cwd path.
  - Fail-closed: an unresolvable claim, an absent file, or an under-specified
    claim must be FLAGGED, not UNVERIFIABLE or OK.
  - No real file is written to the repo; a temporary directory is used for all
    fixture files.

Run: python3 scripts/__tests__/review-claim-verify.test.py
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_SCRIPT = _TESTS_DIR.parent / "review-claim-verify.py"


def _load_module(repo_root: Path | None = None):
    """Load the module; optionally patch REPO_ROOT for isolated tests."""
    spec = importlib.util.spec_from_file_location("review_claim_verify", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if repo_root is not None:
        mod.REPO_ROOT = repo_root
    return mod


rcv = _load_module()


def _make_fixture_file(d: Path, name: str, lines: list[str]) -> Path:
    """Write a fixture file; returns the absolute path."""
    p = d / name
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# parse_claims -- unit tests
# ---------------------------------------------------------------------------

class TestParseClaims(unittest.TestCase):
    """parse_claims is a pure function; test it in isolation."""

    def test_no_markers_returns_empty(self):
        self.assertEqual(rcv.parse_claims("no claims here"), [])

    def test_single_present_claim(self):
        text = '[CLAIM file=src/foo.py line=5 present="def bar"]'
        claims = rcv.parse_claims(text)
        self.assertEqual(len(claims), 1)
        c = claims[0]
        self.assertEqual(c.file, "src/foo.py")
        self.assertEqual(c.line, 5)
        self.assertEqual(c.present, "def bar")

    def test_absent_claim(self):
        text = '[CLAIM file=x.py line=10 absent="TODO"]'
        c = rcv.parse_claims(text)[0]
        self.assertEqual(c.absent, "TODO")
        self.assertIsNone(c.present)

    def test_no_file_line_parsed_as_none(self):
        text = "[CLAIM this code is missing but no location]"
        claims = rcv.parse_claims(text)
        self.assertEqual(len(claims), 1)
        self.assertIsNone(claims[0].file)
        self.assertIsNone(claims[0].line)

    def test_multiple_claims_in_text(self):
        text = textwrap.dedent("""
            Review result:
            [CLAIM file=a.py line=1 present="import os"]
            Some prose in between.
            [CLAIM file=b.py line=3 absent="pass"]
        """)
        claims = rcv.parse_claims(text)
        self.assertEqual(len(claims), 2)
        self.assertEqual(claims[0].file, "a.py")
        self.assertEqual(claims[1].file, "b.py")

    def test_present_re_field_parsed(self):
        text = '[CLAIM file=x.py line=2 present_re="def \\w+"]'
        c = rcv.parse_claims(text)[0]
        self.assertIsNotNone(c.present_re)

    def test_absent_re_field_parsed(self):
        text = '[CLAIM file=x.py line=2 absent_re="TODO|FIXME"]'
        c = rcv.parse_claims(text)[0]
        self.assertEqual(c.absent_re, "TODO|FIXME")


# ---------------------------------------------------------------------------
# verify_claim -- unit tests with temporary fixture files
# ---------------------------------------------------------------------------

class TestVerifyClaimOK(unittest.TestCase):
    """Happy-path: claim matches live code -> OK."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        # Minimal fake repo: create the target file inside a 'src' sub-dir
        (self.root / "src").mkdir()
        self.fixture = _make_fixture_file(
            self.root / "src", "util.py",
            ["import os", "def helper():", '    return "ok"']
        )
        self.mod = _load_module(repo_root=self.root)

    def tearDown(self):
        self.td.cleanup()

    def _claim(self, **kwargs):
        return rcv.Claim(
            raw="[CLAIM ...]",
            file=kwargs.get("file", "src/util.py"),
            line=kwargs.get("line", 1),
            present=kwargs.get("present"),
            absent=kwargs.get("absent"),
            present_re=kwargs.get("present_re"),
            absent_re=kwargs.get("absent_re"),
        )

    def test_present_substring_ok(self):
        c = self._claim(file="src/util.py", line=1, present="import os")
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "OK")

    def test_absent_substring_ok(self):
        # Line 1 has "import os" -- "TODO" is absent
        c = self._claim(file="src/util.py", line=1, absent="TODO")
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "OK")

    def test_present_re_ok(self):
        c = self._claim(file="src/util.py", line=2, present_re=r"def \w+")
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "OK")

    def test_absent_re_ok(self):
        c = self._claim(file="src/util.py", line=1, absent_re=r"class \w+")
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "OK")


class TestVerifyClaimFlagged(unittest.TestCase):
    """DANGEROUS directions -- stale/wrong claims must be FLAGGED, not silently
    OK.  These are the adversarial fixtures mandated by detector-dod-gate."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        (self.root / "src").mkdir()
        # Fixture: file whose content differs from what a stale reviewer may assert
        self.fixture = _make_fixture_file(
            self.root / "src", "guard.py",
            [
                "def check(x):",
                "    return x > 0",   # <- no TODO, no old code
                "",
            ]
        )
        self.mod = _load_module(repo_root=self.root)

    def tearDown(self):
        self.td.cleanup()

    def _claim(self, **kwargs):
        return rcv.Claim(
            raw="[CLAIM ...]",
            file=kwargs.get("file", "src/guard.py"),
            line=kwargs.get("line", 2),
            present=kwargs.get("present"),
            absent=kwargs.get("absent"),
            present_re=kwargs.get("present_re"),
            absent_re=kwargs.get("absent_re"),
        )

    # -------------------------------------------------------------------
    # ADVERSARIAL: stale "this code is still there" claim
    # -------------------------------------------------------------------
    def test_stale_present_claim_is_flagged(self):
        """A reviewer inferred that old dead code is on line 2; it was already
        fixed.  The claim must be FLAGGED, not silently accepted."""
        c = self._claim(line=2, present="# TODO: remove this")
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "FLAGGED",
            "stale 'present' claim must be FLAGGED when text is not on that line")
        self.assertIn("not found", r.reason)

    # -------------------------------------------------------------------
    # ADVERSARIAL: "already fixed" absent-claim is actually still present
    # -------------------------------------------------------------------
    def test_stale_absent_claim_is_flagged(self):
        """Reviewer claims 'TODO was removed' but the word is still there in the
        file.  Write a fixture where it IS present, then assert FLAGGED."""
        _make_fixture_file(self.root / "src", "legacy.py",
                           ["# TODO: clean up", "pass"])
        c = rcv.Claim(
            raw="[CLAIM ...]",
            file="src/legacy.py",
            line=1,
            present=None,
            absent="TODO",   # <- reviewer says it's gone, but it isn't
            present_re=None,
            absent_re=None,
        )
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "FLAGGED",
            "absent claim must be FLAGGED when the text IS on that line")
        self.assertIn("unexpectedly present", r.reason)

    # -------------------------------------------------------------------
    # ADVERSARIAL: file not found (reviewer cited wrong path)
    # -------------------------------------------------------------------
    def test_nonexistent_file_is_flagged(self):
        c = self._claim(file="src/does_not_exist.py", line=1, present="anything")
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "FLAGGED")
        self.assertIn("not found", r.reason)

    # -------------------------------------------------------------------
    # ADVERSARIAL: line number beyond EOF
    # -------------------------------------------------------------------
    def test_line_beyond_eof_is_flagged(self):
        # guard.py has 3 lines; ask for line 99
        c = self._claim(file="src/guard.py", line=99, present="anything")
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "FLAGGED")
        self.assertIn("does not exist", r.reason)

    # -------------------------------------------------------------------
    # ADVERSARIAL: under-specified claim (file:line but no assertion)
    # -------------------------------------------------------------------
    def test_no_assertion_is_flagged(self):
        """A claim with file:line but no present/absent/regex is under-specified.
        It cannot be verified, so it must be FLAGGED (fail-closed), not OK."""
        c = self._claim(file="src/guard.py", line=1,
                        present=None, absent=None,
                        present_re=None, absent_re=None)
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "FLAGGED",
            "under-specified claim (no assertion) must be FLAGGED, not OK")
        self.assertIn("under-specified", r.reason)

    # -------------------------------------------------------------------
    # ADVERSARIAL: path traversal attempt
    # -------------------------------------------------------------------
    def test_path_traversal_is_flagged(self):
        c = self._claim(file="../../etc/passwd", line=1, present="root")
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "FLAGGED")
        self.assertIn("escapes repo root", r.reason)

    # -------------------------------------------------------------------
    # ADVERSARIAL: bad regex is FLAGGED, not an unhandled exception
    # -------------------------------------------------------------------
    def test_invalid_present_re_is_flagged(self):
        c = self._claim(file="src/guard.py", line=1,
                        present_re="[invalid regex")
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "FLAGGED")
        self.assertIn("invalid", r.reason)


class TestVerifyClaimUnverifiable(unittest.TestCase):
    """Claims with no file:line cannot be checked -> UNVERIFIABLE."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        self.mod = _load_module(repo_root=self.root)

    def tearDown(self):
        self.td.cleanup()

    def test_no_file_no_line_unverifiable(self):
        c = rcv.Claim(raw="[CLAIM no location here]",
                      file=None, line=None,
                      present="something", absent=None,
                      present_re=None, absent_re=None)
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "UNVERIFIABLE")

    def test_file_without_line_unverifiable(self):
        c = rcv.Claim(raw="[CLAIM file=src/x.py]",
                      file="src/x.py", line=None,
                      present="x", absent=None,
                      present_re=None, absent_re=None)
        r = self.mod.verify_claim(c, self.root)
        self.assertEqual(r.verdict, "UNVERIFIABLE")


# ---------------------------------------------------------------------------
# overall verdict aggregation
# ---------------------------------------------------------------------------

class TestOverallVerdict(unittest.TestCase):

    def _make_result(self, verdict):
        c = rcv.Claim(raw="", file=None, line=None,
                      present=None, absent=None, present_re=None, absent_re=None)
        return rcv.ClaimResult(c, verdict, "")

    def test_all_ok_returns_ok_exit_0(self):
        results = [self._make_result("OK"), self._make_result("OK")]
        label, code = rcv._overall_verdict(results)
        self.assertEqual(label, "OK")
        self.assertEqual(code, 0)

    def test_flagged_dominates_unverifiable(self):
        results = [
            self._make_result("FLAGGED"),
            self._make_result("UNVERIFIABLE"),
            self._make_result("OK"),
        ]
        label, code = rcv._overall_verdict(results)
        self.assertEqual(label, "FLAGGED")
        self.assertEqual(code, 1)

    def test_unverifiable_alone_exit_2(self):
        results = [self._make_result("OK"), self._make_result("UNVERIFIABLE")]
        label, code = rcv._overall_verdict(results)
        self.assertEqual(label, "UNVERIFIABLE")
        self.assertEqual(code, 2)


# ---------------------------------------------------------------------------
# CWD-independence: subprocess with cwd=tempdir (hostile CWD)
# The key danger class: a CWD-relative anchor would resolve the fixture path
# against the tempdir, not the repo root, breaking the lookup.
# ---------------------------------------------------------------------------

class TestCwdIndependence(unittest.TestCase):
    """Run the script from a tempdir that is NOT the repo root to verify that
    path resolution is anchored to __file__, not CWD."""

    def setUp(self):
        # Repo-side fixture: create a small file inside the REAL repo root
        # (the worktree).  We only read it; we do not write to any source file.
        self.td_cwd = tempfile.TemporaryDirectory()   # hostile CWD
        self.td_repo = tempfile.TemporaryDirectory()  # fake repo root
        self.fake_root = Path(self.td_repo.name)
        (self.fake_root / "src").mkdir()
        self.fixture = _make_fixture_file(
            self.fake_root / "src", "anchor_test.py",
            ["x = 1", "y = 2"]
        )

    def tearDown(self):
        self.td_cwd.cleanup()
        self.td_repo.cleanup()

    def _run(self, review_text: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(_SCRIPT),
             "--json",
             "--repo-root", str(self.fake_root)],
            input=review_text,
            capture_output=True,
            text=True,
            cwd=self.td_cwd.name,   # <-- hostile: NOT the repo root
        )

    def test_ok_claim_verified_from_hostile_cwd(self):
        """A correct claim is verified even when CWD is a totally different dir."""
        text = '[CLAIM file=src/anchor_test.py line=1 present="x = 1"]'
        r = self._run(text)
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["verdict"], "OK")

    def test_stale_claim_flagged_from_hostile_cwd(self):
        """A stale claim is FLAGGED even when CWD is a totally different dir.
        This is the adversarial direction: a CWD-relative anchor would fail to
        find the file at all (which could cause silent OK or wrong error) instead
        of correctly flagging the wrong assertion."""
        text = '[CLAIM file=src/anchor_test.py line=1 present="totally wrong text"]'
        r = self._run(text)
        self.assertEqual(r.returncode, 1, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["verdict"], "FLAGGED")

    def test_absent_file_flagged_from_hostile_cwd(self):
        """A claim referencing a nonexistent file is FLAGGED, not silently OK."""
        text = '[CLAIM file=src/no_such.py line=1 present="anything"]'
        r = self._run(text)
        self.assertEqual(r.returncode, 1, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["verdict"], "FLAGGED")


# ---------------------------------------------------------------------------
# CLI integration tests
# ---------------------------------------------------------------------------

class TestCLI(unittest.TestCase):

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        (self.root / "src").mkdir()
        _make_fixture_file(self.root / "src", "app.py",
                           ["import sys", "def main(): pass"])

    def tearDown(self):
        self.td.cleanup()

    def _run(self, text: str, extra_args: list[str] | None = None):
        args = [sys.executable, str(_SCRIPT),
                "--repo-root", str(self.root)]
        if extra_args:
            args.extend(extra_args)
        return subprocess.run(
            args,
            input=text,
            capture_output=True,
            text=True,
        )

    def test_no_claims_exit_0(self):
        r = self._run("No claims in this text.")
        self.assertEqual(r.returncode, 0)
        self.assertIn("no [CLAIM] markers found", r.stdout)

    def test_ok_claim_exit_0(self):
        text = '[CLAIM file=src/app.py line=1 present="import sys"]'
        r = self._run(text)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("OK", r.stdout)

    def test_flagged_claim_exit_1(self):
        text = '[CLAIM file=src/app.py line=1 present="this is not there"]'
        r = self._run(text)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("FLAGGED", r.stdout)

    def test_unverifiable_claim_exit_2(self):
        text = "[CLAIM this code is probably missing but no file or line]"
        r = self._run(text)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("UNVERIFIABLE", r.stdout)

    def test_json_flag_ok_claim(self):
        text = '[CLAIM file=src/app.py line=2 present="def main"]'
        r = self._run(text, ["--json"])
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["verdict"], "OK")
        self.assertIn("claims_found", data)
        self.assertIn("results", data)

    def test_json_flag_flagged_claim(self):
        text = '[CLAIM file=src/app.py line=1 present="nonexistent token"]'
        r = self._run(text, ["--json"])
        self.assertEqual(r.returncode, 1, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["verdict"], "FLAGGED")
        self.assertGreater(data["flagged"], 0)

    def test_flagged_dominates_unverifiable_in_mixed_text(self):
        """When both FLAGGED and UNVERIFIABLE claims exist, exit code must be 1."""
        text = (
            "[CLAIM no location]\n"
            '[CLAIM file=src/app.py line=1 present="nonexistent"]\n'
        )
        r = self._run(text, ["--json"])
        data = json.loads(r.stdout)
        self.assertEqual(data["verdict"], "FLAGGED")
        self.assertEqual(r.returncode, 1)


# ---------------------------------------------------------------------------
# ReDoS protection (card bb71b112)
# ---------------------------------------------------------------------------

class TestReDoSProtection(unittest.TestCase):
    """present_re / absent_re with catastrophic-backtracking patterns must not
    hang the process.  Uses subprocess with an explicit timeout so the test
    runner itself does not block if production protection is absent."""

    # Hard ceiling for the subprocess call; production must return well inside this.
    _PROC_TIMEOUT = 5  # seconds

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        (self.root / "src").mkdir()
        # A line that triggers near-match catastrophic backtracking for (a+)+$:
        # many 'a's followed by a non-matching char.
        _make_fixture_file(
            self.root / "src", "target.py",
            ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"]
        )

    def tearDown(self):
        self.td.cleanup()

    def _run_via_cli(self, claim_text: str) -> dict:
        """Run the script as a subprocess with a hard timeout.

        Returns the parsed JSON dict.  Raises AssertionError if the process
        times out (indicating the ReDoS protection is absent).
        """
        try:
            proc = subprocess.run(
                [sys.executable, str(_SCRIPT),
                 "--json", "--repo-root", str(self.root)],
                input=claim_text,
                capture_output=True,
                text=True,
                timeout=self._PROC_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            self.fail(
                f"review-claim-verify hung for >{self._PROC_TIMEOUT}s on "
                f"catastrophic regex -- ReDoS protection missing.  "
                f"claim: {claim_text!r}"
            )
        return json.loads(proc.stdout)

    def test_catastrophic_present_re_is_flagged_not_hung(self):
        """(a+)+$ on a near-match string triggers catastrophic backtracking.
        The verifier must return FLAGGED within a bounded time, not hang."""
        claim = '[CLAIM file=src/target.py line=1 present_re="(a+)+$"]'
        data = self._run_via_cli(claim)
        self.assertEqual(data["verdict"], "FLAGGED",
            f"catastrophic present_re must be FLAGGED, got: {data}")
        reason = data["results"][0]["reason"].lower()
        self.assertIn("timed out", reason,
            f"reason should mention timeout, got: {reason}")

    def test_catastrophic_absent_re_is_flagged_not_hung(self):
        """Same test for absent_re: catastrophic pattern must be FLAGGED, not hung."""
        claim = '[CLAIM file=src/target.py line=1 absent_re="(a+)+$"]'
        data = self._run_via_cli(claim)
        self.assertEqual(data["verdict"], "FLAGGED",
            f"catastrophic absent_re must be FLAGGED, got: {data}")
        reason = data["results"][0]["reason"].lower()
        self.assertIn("timed out", reason,
            f"reason should mention timeout, got: {reason}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
