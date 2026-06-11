#!/usr/bin/env python3
"""Acceptance tests for scripts/memory-lint.py (fleet-meeting item A, card memory-lint).

The deterministic memory-vault linter (Layer 1, zero-token) audits the markdown
memory vault and emits a report (stdout + JSON) plus a shields.io badge. It is
FLAG/SUGGEST only -- it MUST NOT edit, delete, or merge anything (never-delete +
reproducibility invariant). Contract:

  (a) stale     -- entry older than STALE_DAYS (frontmatter `date:` if present, else mtime)
  (b) oversized -- entry > MAX_LINES; index file > INDEX_MAX_BYTES; index line > MAX_LINE_CHARS
  (c) duplicate -- two files share the same frontmatter `name:` slug
  (d) dangling  -- a [[slug]] with no matching file (slug = filename stem OR frontmatter name)

Verdict: PASS (no actionable findings) or WARN (>=1 actionable finding); never BLOCK
(advisory only). Dangling links are verdict-NEUTRAL by default -- the vault convention
documents that a [[link]] with no target yet is an intentional forward-reference, not an
error -- unless MEMORY_LINT_STRICT_LINKS=1.

Design: a synthetic memory dir per test via MEMORY_LINT_DIR; deterministic "now" via
MEMORY_LINT_NOW (epoch); badge redirected to a temp path via MEMORY_LINT_BADGE. Hermetic --
never touches the real vault or the repo's store/.

Run: python3 scripts/__tests__/memory-lint.test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(REPO, "scripts", "memory-lint.py")

NOW = 1_780_000_000  # fixed epoch for deterministic staleness math
DAY = 86_400


def _write(path, content, mtime=None):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def _entry(name, body="body line\n", description="d", date=None, extra_lines=0):
    fm = ["---", f"name: {name}", f"description: {description}"]
    if date is not None:
        fm.append(f"date: {date}")
    fm += ["metadata:", "  type: project", "---", ""]
    text = "\n".join(fm) + body + ("filler\n" * extra_lines)
    return text


def _make_vault(d, index_text=None):
    """A clean baseline vault: two fresh, small, unique, link-consistent entries."""
    _write(os.path.join(d, "alpha.md"), _entry("alpha", "see [[beta]]\n"), mtime=NOW - DAY)
    _write(os.path.join(d, "beta.md"), _entry("beta", "plain\n"), mtime=NOW - DAY)
    idx = index_text if index_text is not None else (
        "# Memory Index\n\n- [Alpha](alpha.md) hook\n- [Beta](beta.md) hook\n"
    )
    _write(os.path.join(d, "MEMORY.md"), idx, mtime=NOW - DAY)


def _run(memory_dir, badge_path, *args, strict_links=False):
    env = dict(os.environ)
    env["MEMORY_LINT_DIR"] = memory_dir
    env["MEMORY_LINT_BADGE"] = badge_path
    env["MEMORY_LINT_NOW"] = str(NOW)
    if strict_links:
        env["MEMORY_LINT_STRICT_LINKS"] = "1"
    return subprocess.run(
        ["python3", SCRIPT, *args],
        capture_output=True, text=True, env=env, timeout=60,
    )


def _report(memory_dir, badge_path, **kw):
    r = _run(memory_dir, badge_path, "--json", **kw)
    assert r.returncode in (0, 1), f"unexpected exit {r.returncode}\n{r.stderr}"
    return json.loads(r.stdout)


class CleanVaultTests(unittest.TestCase):
    def test_clean_vault_passes(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            self.assertEqual(rep["verdict"], "PASS", rep)
            self.assertEqual(rep["actionable"], 0, rep)
            for cat in ("stale", "oversized", "duplicate_slug"):
                self.assertEqual(rep["counts"][cat], 0, f"{cat}: {rep['findings'][cat]}")


class StaleTests(unittest.TestCase):
    def test_old_mtime_is_stale(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            _write(os.path.join(d, "old.md"), _entry("old"), mtime=NOW - 120 * DAY)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            stale_files = [f["file"] for f in rep["findings"]["stale"]]
            self.assertIn("old.md", stale_files, rep["findings"]["stale"])
            self.assertEqual(rep["verdict"], "WARN")

    def test_frontmatter_date_overrides_mtime(self):
        """Fresh on disk, but an old frontmatter `date:` -> stale by frontmatter basis."""
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            _write(os.path.join(d, "dated.md"),
                   _entry("dated", date="2025-01-01"), mtime=NOW - DAY)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            hit = [f for f in rep["findings"]["stale"] if f["file"] == "dated.md"]
            self.assertTrue(hit, rep["findings"]["stale"])
            self.assertEqual(hit[0]["basis"], "frontmatter")

    def test_index_excluded_from_stale(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            os.utime(os.path.join(d, "MEMORY.md"), (NOW - 400 * DAY, NOW - 400 * DAY))
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            stale_files = [f["file"] for f in rep["findings"]["stale"]]
            self.assertNotIn("MEMORY.md", stale_files)


class OversizedTests(unittest.TestCase):
    def test_entry_over_max_lines(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            _write(os.path.join(d, "big.md"), _entry("big", extra_lines=80), mtime=NOW - DAY)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            hit = [f for f in rep["findings"]["oversized"] if f["file"] == "big.md"]
            self.assertTrue(hit, rep["findings"]["oversized"])
            self.assertEqual(rep["verdict"], "WARN")

    def test_index_over_max_bytes(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            big_index = "# Memory Index\n\n" + ("- [x](x.md) hook\n" * 4000)
            _make_vault(d, index_text=big_index)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            kinds = [(f["file"], f.get("kind")) for f in rep["findings"]["oversized"]]
            self.assertIn(("MEMORY.md", "index_bytes"), kinds, kinds)

    def test_index_long_line(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            long_line = "- [x](x.md) " + ("y" * 250) + "\n"
            _make_vault(d, index_text="# Memory Index\n\n" + long_line)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            kinds = [f.get("kind") for f in rep["findings"]["oversized"] if f["file"] == "MEMORY.md"]
            self.assertIn("index_line", kinds, rep["findings"]["oversized"])


class DuplicateSlugTests(unittest.TestCase):
    def test_duplicate_name_slug(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            _write(os.path.join(d, "dup-a.md"), _entry("samename"), mtime=NOW - DAY)
            _write(os.path.join(d, "dup-b.md"), _entry("samename"), mtime=NOW - DAY)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            dups = rep["findings"]["duplicate_slug"]
            self.assertTrue(any(x["slug"] == "samename" for x in dups), dups)
            files = sorted(next(x["files"] for x in dups if x["slug"] == "samename"))
            self.assertEqual(files, ["dup-a.md", "dup-b.md"])
            self.assertEqual(rep["verdict"], "WARN")


class DanglingLinkTests(unittest.TestCase):
    def test_dangling_link_reported_but_neutral(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            _write(os.path.join(d, "linky.md"),
                   _entry("linky", "go to [[nowhere]]\n"), mtime=NOW - DAY)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            links = [(x["file"], x["link"]) for x in rep["findings"]["dangling_links"]]
            self.assertIn(("linky.md", "nowhere"), links, links)
            # advisory: dangling links alone must NOT flip the verdict (vault convention)
            self.assertEqual(rep["verdict"], "PASS", rep)

    def test_strict_links_makes_dangling_actionable(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            _write(os.path.join(d, "linky.md"),
                   _entry("linky", "go to [[nowhere]]\n"), mtime=NOW - DAY)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge, strict_links=True)
            self.assertEqual(rep["verdict"], "WARN", rep)

    def test_link_resolves_by_filename_or_name(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            # filename stem 'gamma-file' but frontmatter name 'gamma'
            _write(os.path.join(d, "gamma-file.md"), _entry("gamma"), mtime=NOW - DAY)
            _write(os.path.join(d, "refs.md"),
                   _entry("refs", "via name [[gamma]] and via file [[gamma-file]]\n"),
                   mtime=NOW - DAY)
            badge = os.path.join(b, "badge.json")
            rep = _report(d, badge)
            dangling = [x["link"] for x in rep["findings"]["dangling_links"]]
            self.assertNotIn("gamma", dangling)
            self.assertNotIn("gamma-file", dangling)


class NoMutationTests(unittest.TestCase):
    def test_script_never_mutates_the_vault(self):
        """The hard invariant: a lint run must not add/remove/modify any vault file."""
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            # add a stale + oversized + dup + dangling so every code path runs
            _write(os.path.join(d, "old.md"), _entry("old", extra_lines=80),
                   mtime=NOW - 200 * DAY)
            _write(os.path.join(d, "dup1.md"), _entry("dd"), mtime=NOW - DAY)
            _write(os.path.join(d, "dup2.md"), _entry("dd"), mtime=NOW - DAY)
            _write(os.path.join(d, "dl.md"), _entry("dl", "[[ghost]]\n"), mtime=NOW - DAY)

            def snapshot():
                snap = {}
                for fn in sorted(os.listdir(d)):
                    p = os.path.join(d, fn)
                    with open(p, "rb") as f:
                        snap[fn] = (f.read(), os.stat(p).st_mtime_ns)
                return snap

            before = snapshot()
            _run(d, os.path.join(b, "badge.json"))
            after = snapshot()
            self.assertEqual(set(before), set(after), "no file added/removed")
            for fn in before:
                self.assertEqual(before[fn][0], after[fn][0], f"{fn} content changed")
                self.assertEqual(before[fn][1], after[fn][1], f"{fn} mtime changed")


class BadgeTests(unittest.TestCase):
    def test_badge_schema_pass(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            badge = os.path.join(b, "badge.json")
            _run(d, badge)
            self.assertTrue(os.path.exists(badge), "badge must be written")
            with open(badge, encoding="utf-8") as f:
                data = json.load(f)
            self.assertEqual(data["schemaVersion"], 1)
            self.assertEqual(data["label"], "memory-lint")
            self.assertEqual(data["verdict"], "PASS")
            self.assertEqual(data["color"], "brightgreen")
            self.assertIn("message", data)
            self.assertIsInstance(data["timestamp"], int)
            self.assertRegex(data["timestamp_iso"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
            self.assertIn("counts", data)

    def test_badge_schema_warn_color(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            _write(os.path.join(d, "old.md"), _entry("old"), mtime=NOW - 200 * DAY)
            badge = os.path.join(b, "badge.json")
            _run(d, badge)
            with open(badge, encoding="utf-8") as f:
                data = json.load(f)
            self.assertEqual(data["verdict"], "WARN")
            self.assertEqual(data["color"], "yellow")


class ExitCodeTests(unittest.TestCase):
    def test_exit_zero_on_pass_one_on_warn(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as b:
            _make_vault(d)
            badge = os.path.join(b, "badge.json")
            self.assertEqual(_run(d, badge).returncode, 0)
            _write(os.path.join(d, "old.md"), _entry("old"), mtime=NOW - 200 * DAY)
            self.assertEqual(_run(d, badge).returncode, 1)


if __name__ == "__main__":
    if not os.path.exists(SCRIPT):
        print(f"EXPECTED-FAIL (TDD red): {SCRIPT} not found")
        sys.exit(1)
    unittest.main(verbosity=2)
