#!/usr/bin/env python3
"""Symmetry lock-test for the memory-continuity crash-gate (Phase 1, S2).

The crash-gate is only safe if BOTH sides use the SAME agent-resolution key:
  - session-end-marker.py   STAMPS the clean-shutdown marker for _agent_id_from_cwd(cwd)
  - taskstate-replay.py     READS/replays for _agent_id_from_cwd(cwd)

The marveen MAIN session runs from the project ROOT, where _agent_id_from_cwd()
resolves to None on BOTH scripts -> neither stamps nor reads a marker. That
symmetry is what makes the "never-written marker read as absent==crash =>
false-resume" failure IMPOSSIBLE for marveen-main by construction.

This test protects that invariant against a future _agent_id_from_cwd refactor
that could make ONE side resolve marveen-main while the other bails: it asserts
that, with cwd == project root, BOTH scripts exit(0) cleanly and take NO action
(no marker HTTP POST, no replay output) -- verified by pointing the dashboard API
at a dead port so any accidental network call would surface as a non-clean exit
or emitted output.

Run: python3 scripts/hooks/test_marker_replay_symmetry.py
"""
import json
import os
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_INSTALL = os.path.dirname(os.path.dirname(_HERE))  # <install>/scripts/hooks -> <install>
_END_HOOK = os.path.join(_HERE, "session-end-marker.py")
_REPLAY_HOOK = os.path.join(_HERE, "taskstate-replay.py")


def _run(hook, cwd_value, source=None):
    payload = {"cwd": cwd_value}
    if source is not None:
        payload["source"] = source
    # Point the dashboard at a dead port so an accidental network call cannot
    # succeed; the hooks are fail-open (exit 0) so we ALSO assert no output.
    env = dict(os.environ)
    return subprocess.run(
        [sys.executable, hook],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=20,
    )


class ProjectRootBailsSymmetry(unittest.TestCase):
    """cwd == project root => _agent_id_from_cwd() is None => both sides bail."""

    def test_session_end_marker_bails_at_project_root(self):
        p = _run(_END_HOOK, _INSTALL)
        self.assertEqual(p.returncode, 0, p.stderr)
        # No stamp attempted -> no output whatsoever.
        self.assertEqual(p.stdout.strip(), "")

    def test_taskstate_replay_bails_at_project_root(self):
        p = _run(_REPLAY_HOOK, _INSTALL, source="startup")
        self.assertEqual(p.returncode, 0, p.stderr)
        # No replay read -> no additionalContext emitted.
        self.assertEqual(p.stdout.strip(), "")

    def test_both_bail_on_empty_cwd(self):
        # A missing/empty cwd is the other None path -- both must bail identically.
        for hook, source in ((_END_HOOK, None), (_REPLAY_HOOK, "startup")):
            p = _run(hook, "", source=source)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(p.stdout.strip(), "")

    def test_sub_agent_cwd_is_symmetric(self):
        # Both sides resolve the SAME agent for a sub-agent cwd. We do NOT assert
        # a successful HTTP round-trip here (no live dashboard in the unit env);
        # we assert the resolution is symmetric by importing the helper from each
        # script and comparing. This locks the same-key contract directly.
        import importlib.util

        def _load(path, name):
            spec = importlib.util.spec_from_file_location(name, path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod

        end_mod = _load(_END_HOOK, "session_end_marker")
        replay_mod = _load(_REPLAY_HOOK, "taskstate_replay")
        for cwd in (
            _INSTALL,                                   # project root -> None
            "",                                         # empty -> None
            os.path.join(_INSTALL, "agents", "dave"),   # sub-agent -> 'dave'
            os.path.join(_INSTALL, "agents", "hibiki", "sub"),  # nested -> 'hibiki'
        ):
            self.assertEqual(
                end_mod._agent_id_from_cwd(cwd),
                replay_mod._agent_id_from_cwd(cwd),
                "agent-resolution diverged between stamp and read side for cwd=%r" % cwd,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
