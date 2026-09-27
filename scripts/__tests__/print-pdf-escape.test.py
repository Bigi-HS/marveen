#!/usr/bin/env python3
"""
Test: html.escape in print-pdf.py frontmatter and info_rows.
Run from repo root: python3 scripts/__tests__/print-pdf-escape.test.py
"""
import subprocess
import sys
import tempfile
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = REPO_ROOT / "scripts" / "print-pdf.py"

PASS = 0
FAIL = 0


def check(label: str, condition: bool) -> None:
    global PASS, FAIL
    if condition:
        print(f"  PASS  {label}")
        PASS += 1
    else:
        print(f"  FAIL  {label}")
        FAIL += 1


def run_demo(template: str, out: Path) -> bool:
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--demo", template, "--out", str(out)],
        capture_output=True, text=True
    )
    return r.returncode == 0


def run_md(md_text: str, template: str, out: Path) -> tuple[bool, str]:
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write(md_text)
        src = f.name
    r = subprocess.run(
        [sys.executable, str(SCRIPT), src, "--template", template, "--out", str(out)],
        capture_output=True, text=True
    )
    os.unlink(src)
    return r.returncode == 0, r.stderr


def test_demo_renders():
    with tempfile.TemporaryDirectory() as td:
        for tmpl in ("flyer-a4", "prospectus-a5"):
            out = Path(td) / f"{tmpl}.pdf"
            ok = run_demo(tmpl, out)
            check(f"demo {tmpl} renders without error", ok)
            check(f"demo {tmpl} produces non-empty PDF", ok and out.stat().st_size > 0)


def test_xss_frontmatter_does_not_crash():
    """Frontmatter with HTML-special chars must render (not crash WeasyPrint)."""
    md = """\
---
title: "Test <script>alert(1)</script>"
subtitle: "A & B > C"
lead: "O'Reilly's guide to <em>escaping</em>"
organizer: "Flotta & Co"
date: "2026-09-26"
location: "Budapest"
cta_text: "Click <here>"
contact_web: "example.com"
---
Normal body.
"""
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "xss.pdf"
        ok, err = run_md(md, "flyer-a4", out)
        check("XSS-like frontmatter renders without crash", ok)
        check("XSS-like frontmatter produces non-empty PDF", ok and out.stat().st_size > 0)


def test_ampersand_apostrophe_frontmatter():
    """& and ' in frontmatter values must not produce malformed HTML."""
    md = """\
---
title: "Dominik & Friends"
subtitle: "It's a trap"
organizer: "Test Corp"
contact_web: "test.com"
---
Body here.
"""
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "amp.pdf"
        ok, err = run_md(md, "flyer-a4", out)
        check("Ampersand/apostrophe frontmatter renders", ok)


if __name__ == "__main__":
    print("=== print-pdf html.escape fixture tests ===")
    test_demo_renders()
    test_xss_frontmatter_does_not_crash()
    test_ampersand_apostrophe_frontmatter()
    total = PASS + FAIL
    print(f"\n{PASS}/{total} passed")
    sys.exit(0 if FAIL == 0 else 1)
