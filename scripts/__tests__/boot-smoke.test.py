#!/usr/bin/env python3
"""Acceptance tests for the CI boot-smoke gate (card 2e3779c5).

Two units under test:

  1. scripts/boot-smoke.sh -- boots a BUILT dist in an ISOLATED throwaway
     PROJECT_ROOT under NOA_BOOT_SMOKE (db + web listener only, no peer-kill,
     no schedulers/agents/watchers) against a COPY of noa.db, and asserts the
     process actually comes up and binds its port. Boot-only (no write probes)
     so it stays well under the ~40s budget. Exit codes:
        0 = PASS  (booted + bound)
        1 = BLOCK (process crashed / never bound == boot failure -- e.g. an
                   ESM default-vs-named import regression like the #972 outage)
        2 = SKIP  (precondition unmet: missing dist/db, or an unsafe port)

  2. pre-gate-bundle.sh wiring -- a PURE path-detector (pgb_boot_path_touched)
     plus check_boot_smoke, which AUTO-triggers the smoke when the PR diff
     touches the boot path (src/index.ts, src/web/**, package.json) and stays
     dormant otherwise. PGB_BOOT_SMOKE=1/0 is an explicit override/escape-hatch.

The ESM-crash -> BLOCK and clean -> PASS behaviours are exercised with FAKE
dist stubs (a tiny http server vs. a process that exits during boot) so the
test is hermetic and fast -- it does not depend on a real `npm run build`.

The ISOLATION asserts (never bind the live :3420, never write the live
noa.db, boot under SANDBOX_ISOLATION=1 against a copy) are mandatory: a
misconfigured env is exactly what would reproduce the outage this gate exists
to prevent.

Run: python3 scripts/__tests__/boot-smoke.test.py
"""
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BOOT_SMOKE = os.path.join(HERE, "..", "boot-smoke.sh")
BUNDLE_SCRIPT = os.path.join(HERE, "..", "pre-gate-bundle.sh")

# A high port unlikely to clash with the live :3420 or the dry-run :3499.
BASE_PORT = 34870


def _free_port(preferred: int) -> int:
    """Return `preferred` if free, else an OS-assigned free port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _port_is_listening(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _write(path: str, content: str, executable: bool = False):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    if executable:
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP)


# A clean fake dist: binds the NOA_BOOT_SMOKE port with a minimal http server
# (responds 200 to anything, so boot-smoke's curl health-poll succeeds) and
# records the isolation-relevant env to FAKE_MARKER so the test can assert it.
_CLEAN_DIST = r"""
const http = require('http');
const fs = require('fs');
const port = parseInt(process.env.NOA_BOOT_SMOKE || '0', 10);
const marker = process.env.FAKE_MARKER;
if (marker) {
  try {
    fs.writeFileSync(marker, JSON.stringify({
      SANDBOX_ISOLATION: process.env.SANDBOX_ISOLATION || null,
      NOA_DB_PATH: process.env.NOA_DB_PATH || null,
      port: port,
      cwd: process.cwd(),
    }));
  } catch (e) {}
}
const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
srv.listen(port, '127.0.0.1');
"""

# A crash fake dist: exits during boot (stand-in for an ESM named-only default
# import that crashes under native ESM -- the #972 class). Never binds a port.
_CRASH_DIST = r"""
console.error('boot crash: cannot find default export (ESM named-only)');
process.exit(1);
"""


def _make_repo(d: str, dist_js: str | None) -> str:
    """Create a minimal fixture repo: dist/index.js (optional) + store/noa.db
    + an empty node_modules (boot-smoke symlinks it; the fakes need nothing)."""
    repo = os.path.join(d, "repo")
    os.makedirs(os.path.join(repo, "store"), exist_ok=True)
    os.makedirs(os.path.join(repo, "node_modules"), exist_ok=True)
    if dist_js is not None:
        os.makedirs(os.path.join(repo, "dist"), exist_ok=True)
        _write(os.path.join(repo, "dist", "index.js"), dist_js)
    _write(os.path.join(repo, "store", "noa.db"), "LIVE-DB-SENTINEL-DO-NOT-TOUCH\n")
    return repo


def _run_boot_smoke(repo: str, port: int, extra_env: dict | None = None):
    env = dict(os.environ, BOOT_SMOKE_PORT=str(port))
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["bash", BOOT_SMOKE, repo],
        capture_output=True, text=True, env=env, timeout=90,
    )


class BootSmokeScriptTests(unittest.TestCase):
    """scripts/boot-smoke.sh behaviour."""

    def test_clean_boot_passes(self):
        """A dist that boots and binds its port -> PASS (exit 0)."""
        with tempfile.TemporaryDirectory() as d:
            repo = _make_repo(d, _CLEAN_DIST)
            port = _free_port(BASE_PORT)
            marker = os.path.join(d, "marker.json")
            t0 = time.time()
            r = _run_boot_smoke(repo, port, {"FAKE_MARKER": marker})
            elapsed = time.time() - t0
            self.assertEqual(r.returncode, 0,
                f"clean boot must PASS (0); got {r.returncode}\n{r.stdout}\n{r.stderr}")
            # Budget: boot-only must stay well under 40s.
            self.assertLess(elapsed, 40, f"boot-smoke took {elapsed:.1f}s (budget 40s)")

    def test_crash_boot_blocks(self):
        """A dist that exits during boot -> BLOCK (exit 1). This is the #972 class."""
        with tempfile.TemporaryDirectory() as d:
            repo = _make_repo(d, _CRASH_DIST)
            port = _free_port(BASE_PORT + 1)
            r = _run_boot_smoke(repo, port)
            self.assertEqual(r.returncode, 1,
                f"a boot crash must BLOCK (1); got {r.returncode}\n{r.stdout}\n{r.stderr}")

    def test_missing_dist_skips(self):
        """No dist/index.js -> SKIP (exit 2), not a false green and not a BLOCK."""
        with tempfile.TemporaryDirectory() as d:
            repo = _make_repo(d, None)
            port = _free_port(BASE_PORT + 2)
            r = _run_boot_smoke(repo, port)
            self.assertEqual(r.returncode, 2,
                f"missing dist must SKIP (2); got {r.returncode}\n{r.stdout}\n{r.stderr}")

    def test_refuses_live_port_3420(self):
        """Must REFUSE the live dashboard port and never boot on it."""
        with tempfile.TemporaryDirectory() as d:
            repo = _make_repo(d, _CLEAN_DIST)
            marker = os.path.join(d, "marker.json")
            r = _run_boot_smoke(repo, 3420, {"FAKE_MARKER": marker})
            self.assertEqual(r.returncode, 2,
                f"port 3420 must be refused (SKIP 2); got {r.returncode}\n{r.stdout}\n{r.stderr}")
            self.assertFalse(os.path.exists(marker),
                "boot-smoke must NOT boot the dist when the live port is requested")

    def test_isolation_boots_under_sandbox_against_a_copy(self):
        """ISOLATION (mandatory): boots with SANDBOX_ISOLATION=1, NOA_DB_PATH
        points at a sandbox COPY (not the live path), the live noa.db is left
        byte-identical, and the live :3420 is never bound."""
        with tempfile.TemporaryDirectory() as d:
            repo = _make_repo(d, _CLEAN_DIST)
            live_db = os.path.join(repo, "store", "noa.db")
            with open(live_db, "rb") as f:
                before = f.read()
            port = _free_port(BASE_PORT + 3)
            marker = os.path.join(d, "marker.json")
            r = _run_boot_smoke(repo, port, {"FAKE_MARKER": marker})
            self.assertEqual(r.returncode, 0, f"{r.stdout}\n{r.stderr}")
            self.assertTrue(os.path.exists(marker), "fake dist did not record its env")
            with open(marker) as f:
                rec = json.loads(f.read())
            # SANDBOX_ISOLATION=1 must be set so the real dist aborts on a
            # misconfigured NOA_DB_PATH before touching the live DB.
            self.assertEqual(rec.get("SANDBOX_ISOLATION"), "1",
                "boot-smoke must set SANDBOX_ISOLATION=1")
            # The DB must be a sandbox copy, never the live store/noa.db.
            self.assertIsNotNone(rec.get("NOA_DB_PATH"))
            self.assertNotEqual(rec["NOA_DB_PATH"], "store/noa.db",
                "NOA_DB_PATH must point at a sandbox copy, not the canonical live DB")
            # The boot cwd is a throwaway dir, not the live repo.
            self.assertNotEqual(os.path.realpath(rec.get("cwd", "")),
                                os.path.realpath(repo),
                "boot-smoke must boot in an isolated throwaway root, not the live repo")
            # The live DB must be untouched.
            with open(live_db, "rb") as f:
                after = f.read()
            self.assertEqual(before, after, "boot-smoke must NOT write the live noa.db")


# --------------------------------------------------------------------------- #
# pre-gate-bundle.sh wiring                                                    #
# --------------------------------------------------------------------------- #

def _source_and_call(func_call: str, stdin: str = "") -> subprocess.CompletedProcess:
    """Source pre-gate-bundle.sh (defines functions, does not run main) and
    invoke a single pure helper, feeding `stdin`."""
    script = f'source "{BUNDLE_SCRIPT}" >/dev/null 2>&1 || true\n{func_call}\n'
    return subprocess.run(["bash", "-c", script], input=stdin,
                          capture_output=True, text=True)


class BootPathDetectorTests(unittest.TestCase):
    """pgb_boot_path_touched: PURE name-only diff classifier."""

    def _touched(self, names: str) -> str:
        r = _source_and_call("pgb_boot_path_touched", stdin=names)
        return r.stdout.strip()

    def test_index_ts_matches(self):
        self.assertIn("src/index.ts", self._touched("src/index.ts\n"))

    def test_web_route_matches(self):
        self.assertIn("src/web/routes/push.ts",
                      self._touched("src/web/routes/push.ts\n"))

    def test_package_json_matches(self):
        self.assertIn("package.json", self._touched("package.json\n"))

    def test_unrelated_paths_do_not_match(self):
        out = self._touched("docs/readme.md\nscripts/foo.py\nsrc/lib/util.ts\n")
        self.assertEqual(out, "", f"non-boot-path diff must be empty, got: {out!r}")


def _make_boot_smoke_stub(d: str, exit_code: int) -> tuple[str, str]:
    """A boot-smoke.sh stub that records it was invoked (via a marker file) and
    exits with exit_code. Returns (stub_path, marker_path)."""
    marker = os.path.join(d, "bs_invoked")
    stub = os.path.join(d, "boot-smoke-stub.sh")
    _write(stub, f'#!/bin/bash\ntouch "{marker}"\nexit {exit_code}\n', executable=True)
    return stub, marker


def _make_bundle_git_stub(d: str, name_only: str) -> None:
    """git stub: --name-only yields the controlled file list (for boot-path
    detection); --numstat small; every other diff/grep empty."""
    content = (
        'if [[ "$*" == *"--name-only"* ]]; then\n'
        f'  printf "%s\\n" "{name_only}"\n'
        'elif [[ "$*" == *"--numstat"* ]]; then\n'
        '  echo "5\t0\tsrc/fake.ts"\n'
        'elif [[ "$*" == *"diff"* ]] || [[ "$*" == *"grep"* ]]; then\n'
        '  echo ""\n'
        'else\n'
        '  exec /usr/bin/git "$@"\n'
        'fi\n'
    )
    _write(os.path.join(d, "git"), "#!/bin/bash\n" + content, executable=True)


def _make_npx_stub(d: str) -> None:
    _write(os.path.join(d, "npx"),
           '#!/bin/bash\ncase "$1" in\n'
           '  tsc) exit 0 ;;\n'
           '  vitest) echo "Tests 1 passed"; exit 0 ;;\n'
           '  *) exec /usr/bin/npx "$@" ;;\nesac\n', executable=True)


def _scoped_pytests(d: str) -> str:
    py_dir = os.path.join(d, "pytests")
    os.makedirs(py_dir, exist_ok=True)
    _write(os.path.join(py_dir, "noop.test.py"), "import sys\nsys.exit(0)\n")
    return py_dir


def _run_bundle(d: str, env_extra: dict) -> subprocess.CompletedProcess:
    env = dict(os.environ, PATH=d + ":" + os.environ.get("PATH", ""))
    env.update(env_extra)
    return subprocess.run(["bash", BUNDLE_SCRIPT, "develop", "HEAD"],
                          capture_output=True, text=True, cwd=d, env=env)


class CheckBootSmokeWiringTests(unittest.TestCase):
    """check_boot_smoke: auto-trigger on boot-path diff, dormant otherwise,
    PGB_BOOT_SMOKE=1/0 as explicit override."""

    def _base_env(self, d: str, extra: dict) -> dict:
        env = {"PGB_PYTEST_DIR": _scoped_pytests(d)}
        env.update(extra)
        return env

    def test_boot_path_diff_crash_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_bundle_git_stub(d, "src/index.ts")
            stub, marker = _make_boot_smoke_stub(d, exit_code=1)
            r = _run_bundle(d, self._base_env(d, {"PGB_BOOT_SMOKE_BIN": stub}))
            self.assertTrue(os.path.exists(marker),
                "boot-smoke must AUTO-run when the diff touches the boot path")
            self.assertEqual(r.returncode, 1, f"boot crash must BLOCK\n{r.stdout}")
            bs = next((l for l in r.stdout.splitlines() if "] boot-smoke" in l), "")
            self.assertIn("BLOCK", bs, f"got: {bs}")

    def test_boot_path_diff_clean_passes(self):
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_bundle_git_stub(d, "src/web/routes/push.ts")
            stub, marker = _make_boot_smoke_stub(d, exit_code=0)
            r = _run_bundle(d, self._base_env(d, {"PGB_BOOT_SMOKE_BIN": stub}))
            self.assertTrue(os.path.exists(marker))
            self.assertNotIn("BLOCK", r.stdout, r.stdout)
            bs = next((l for l in r.stdout.splitlines() if "] boot-smoke" in l), "")
            self.assertIn("PASS", bs, f"got: {bs}")

    def test_non_boot_path_diff_is_dormant(self):
        """No boot-path file changed -> boot-smoke must NOT run (zero cost)."""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_bundle_git_stub(d, "docs/readme.md")
            stub, marker = _make_boot_smoke_stub(d, exit_code=1)  # would BLOCK if run
            r = _run_bundle(d, self._base_env(d, {"PGB_BOOT_SMOKE_BIN": stub}))
            self.assertFalse(os.path.exists(marker),
                "boot-smoke must stay dormant on a non-boot-path diff")
            self.assertNotIn("BLOCK", r.stdout, r.stdout)

    def test_override_off_skips_on_boot_path(self):
        """PGB_BOOT_SMOKE=0 is an explicit escape-hatch even on a boot-path diff."""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_bundle_git_stub(d, "src/index.ts")
            stub, marker = _make_boot_smoke_stub(d, exit_code=1)  # would BLOCK if run
            r = _run_bundle(d, self._base_env(d, {"PGB_BOOT_SMOKE_BIN": stub,
                                                  "PGB_BOOT_SMOKE": "0"}))
            self.assertFalse(os.path.exists(marker),
                "PGB_BOOT_SMOKE=0 must force-skip the smoke")
            self.assertNotIn("BLOCK", r.stdout, r.stdout)

    def test_override_on_runs_without_boot_path(self):
        """PGB_BOOT_SMOKE=1 forces the smoke even when no boot-path file changed."""
        with tempfile.TemporaryDirectory() as d:
            _make_npx_stub(d)
            _make_bundle_git_stub(d, "docs/readme.md")
            stub, marker = _make_boot_smoke_stub(d, exit_code=0)
            r = _run_bundle(d, self._base_env(d, {"PGB_BOOT_SMOKE_BIN": stub,
                                                  "PGB_BOOT_SMOKE": "1"}))
            self.assertTrue(os.path.exists(marker),
                "PGB_BOOT_SMOKE=1 must force-run the smoke")


if __name__ == "__main__":
    missing = [p for p in (BOOT_SMOKE, BUNDLE_SCRIPT) if not os.path.exists(p)]
    if missing:
        print(f"SKIP: not yet implemented (expected -- scaffold test): {missing}")
        sys.exit(0)
    unittest.main(verbosity=2)
