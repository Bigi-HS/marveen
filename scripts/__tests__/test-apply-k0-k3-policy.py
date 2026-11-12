"""
Unit tests for scripts/apply-k0-k3-policy.py

Tests:
  T1  patch_standard inserts K-0+K-3 subsections into standard agent CLAUDE.md
  T2  patch_no_section appends a new section when none exists
  T3  already_patched detects the K-0 marker and returns True
  T4  idempotency: K-0 marker appears exactly once after first patch
  T5  inserted text contains both K-0 and K-3 markers
"""

import sys
import os
import importlib.util

SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "apply-k0-k3-policy.py",
)

# Load as module without executing the __main__ block
spec = importlib.util.spec_from_file_location("apply_k0_k3", SCRIPT)
mod = importlib.util.module_from_spec(spec)
# __name__ will be "apply_k0_k3", not "__main__", so the if __name__=="__main__" guard fires correctly
spec.loader.exec_module(mod)

patch_standard = mod.patch_standard
patch_no_section = mod.patch_no_section
already_patched = mod.already_patched
PATCH_MARKER = mod.PATCH_MARKER


SAMPLE_WITH_SECTION = """\
# Agent Foo

## Role
Foo is a test agent.

## Öntanulás és Skill rendszer

Te egy önfejlesztő ágens vagy.

### Skill-ek helye
- Globális: ~/.claude/skills/

### Mikor generálj skill-t?
- 5+ tool hívás: Generálj skill-t

## Következő szekció
Something else.
"""

SAMPLE_WITHOUT_SECTION = """\
# Agent Bar

## Role
Bar has no skill section.

## Something
Blah.
"""


def test_patch_standard_inserts_subsections():
    new_content, msg = patch_standard(SAMPLE_WITH_SECTION, "foo")
    assert new_content is not None, f"Expected content, got None: {msg}"
    assert PATCH_MARKER in new_content, "K-0 marker missing after patch"
    assert "Skill-aktiválás naplózása (K-3)" in new_content, "K-3 missing after patch"
    assert msg.startswith("PATCHED"), f"Unexpected msg: {msg}"


def test_patch_standard_inserts_before_next_section():
    new_content, _ = patch_standard(SAMPLE_WITH_SECTION, "foo")
    # K-0 must appear BEFORE "## Következő szekció"
    k0_pos = new_content.find(PATCH_MARKER)
    next_sec_pos = new_content.find("## Következő szekció")
    assert k0_pos < next_sec_pos, "K-0 must be inserted before the next ## section"


def test_patch_no_section_creates_section():
    new_content, msg = patch_no_section(SAMPLE_WITHOUT_SECTION, "bar")
    assert PATCH_MARKER in new_content, "K-0 marker missing in appended section"
    assert "Öntanulás és Skill rendszer" in new_content, "Section header missing"
    assert msg.startswith("PATCHED"), f"Unexpected msg: {msg}"


def test_already_patched_true():
    patched, _ = patch_standard(SAMPLE_WITH_SECTION, "foo")
    assert already_patched(patched), "Should detect K-0 marker after first patch"


def test_already_patched_false_on_original():
    assert not already_patched(SAMPLE_WITH_SECTION), "Should not detect K-0 before patch"


def test_idempotent_single_marker():
    first, _ = patch_standard(SAMPLE_WITH_SECTION, "foo")
    assert first is not None
    assert first.count(PATCH_MARKER) == 1, "K-0 marker should appear exactly once"


def test_k3_instruction_present():
    patched, _ = patch_standard(SAMPLE_WITH_SECTION, "foo")
    assert "daily_log" in patched, "K-3 daily_log instruction missing"
    assert "[skill:" in patched, "K-3 example log format missing"


def run_all():
    tests = [
        test_patch_standard_inserts_subsections,
        test_patch_standard_inserts_before_next_section,
        test_patch_no_section_creates_section,
        test_already_patched_true,
        test_already_patched_false_on_original,
        test_idempotent_single_marker,
        test_k3_instruction_present,
    ]
    passed = failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print(f"\n{passed}/{passed+failed} tests passed")
    return failed == 0


if __name__ == "__main__":
    ok = run_all()
    sys.exit(0 if ok else 1)
