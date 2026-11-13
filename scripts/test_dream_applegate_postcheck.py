#!/usr/bin/env python3
"""
Smoke tests for dream-applegate-postcheck.sh.

Verifies the OK vs MISSING branch + exit code WITHOUT touching the live
daily-log endpoint: the script is copied into a throwaway repo layout (so its
BASH_SOURCE-derived REPO_ROOT resolves to the temp dir) and `curl` is stubbed
on PATH to succeed offline. The dangerous direction is covered on both sides:
present-section must exit 0/OK, absent-section must exit 1/MISSING.
"""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / 'dream-applegate-postcheck.sh'


def _today_budapest():
    """Match the script's own TODAY: TZ=Europe/Budapest date +%F."""
    env = dict(os.environ)
    env['TZ'] = 'Europe/Budapest'
    r = subprocess.run(['date', '+%F'], env=env, capture_output=True, text=True)
    return r.stdout.strip()


def _build_fake_repo(tmpdir, dream_body):
    """Lay out <tmp>/scripts/<script> + <tmp>/store/... and a curl stub on PATH."""
    root = Path(tmpdir)
    (root / 'scripts').mkdir()
    (root / 'store' / 'dreams').mkdir(parents=True)
    shutil.copy(SCRIPT, root / 'scripts' / SCRIPT.name)
    # Fake token so the script does not exit 2 on a missing token file.
    (root / 'store' / '.dashboard-token').write_text('test-token\n')
    if dream_body is not None:
        (root / 'store' / 'dreams' / 'applegate-dream.md').write_text(dream_body)
    # curl stub: swallow args/stdin, succeed offline (no network, no live POST).
    bindir = root / 'bin'
    bindir.mkdir()
    stub = bindir / 'curl'
    stub.write_text('#!/usr/bin/env bash\ncat >/dev/null 2>&1 || true\nexit 0\n')
    stub.chmod(0o755)
    return root, bindir


def _run(root, bindir):
    env = dict(os.environ)
    env['PATH'] = f"{bindir}:{env['PATH']}"
    return subprocess.run(
        ['bash', str(root / 'scripts' / SCRIPT.name)],
        capture_output=True, text=True, env=env
    )


def test_postcheck_ok_when_today_section_present():
    """Dream file has a '## <today>' section -> RC 0 + STATUS OK."""
    today = _today_budapest()
    with tempfile.TemporaryDirectory() as tmpdir:
        root, bindir = _build_fake_repo(tmpdir, f"## {today}\nsome dream content\n")
        r = _run(root, bindir)
        assert r.returncode == 0, f"expected RC 0, got {r.returncode} (stderr: {r.stderr})"
        assert 'OK' in r.stdout, f"expected STATUS OK in stdout, got: {r.stdout!r}"
    print("✓ postcheck OK (today section present) PASSED")


def test_postcheck_missing_when_no_today_section():
    """No dream output at all -> RC 1 + STATUS MISSING."""
    with tempfile.TemporaryDirectory() as tmpdir:
        root, bindir = _build_fake_repo(tmpdir, None)  # no dream file
        r = _run(root, bindir)
        assert r.returncode == 1, f"expected RC 1, got {r.returncode} (stderr: {r.stderr})"
        assert 'MISSING' in r.stdout, f"expected MISSING in stdout, got: {r.stdout!r}"
    print("✓ postcheck MISSING (no today section) PASSED")


def test_postcheck_missing_when_stale_section_only():
    """Dream file exists but only has a non-today section -> RC 1 + MISSING."""
    with tempfile.TemporaryDirectory() as tmpdir:
        root, bindir = _build_fake_repo(tmpdir, "## 2000-01-01\nstale dream\n")
        r = _run(root, bindir)
        assert r.returncode == 1, f"expected RC 1, got {r.returncode} (stderr: {r.stderr})"
        assert 'MISSING' in r.stdout, f"expected MISSING in stdout, got: {r.stdout!r}"
    print("✓ postcheck MISSING (stale section only) PASSED")


def run_all_tests():
    print("=" * 60)
    print("Running dream-applegate-postcheck.sh smoke tests")
    print("=" * 60)

    tests = [
        ("OK (today section present)", test_postcheck_ok_when_today_section_present),
        ("MISSING (no today section)", test_postcheck_missing_when_no_today_section),
        ("MISSING (stale section only)", test_postcheck_missing_when_stale_section_only),
    ]

    passed = 0
    failed = 0
    for name, fn in tests:
        try:
            fn()
            passed += 1
        except AssertionError as e:
            print(f"✗ {name} FAILED: {e}")
            failed += 1
        except Exception as e:
            print(f"✗ {name} ERROR: {e}")
            failed += 1

    print("=" * 60)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 60)
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    import sys
    sys.exit(run_all_tests())
