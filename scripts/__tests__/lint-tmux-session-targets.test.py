#!/usr/bin/env python3
"""Tests for scripts/lint-tmux-session-targets.py (card OPS-106).

Run: python3 scripts/__tests__/lint-tmux-session-targets.test.py

Two halves:
  * check_line() unit cases, covering every call shape this tree actually uses
    (shell, TS arg array, TS template string, python list) in both directions --
    an unanchored SESSION target is a finding, and an anchored PANE target is
    also a finding, because that "hardening" silently stops measuring.
  * a whole-tree run, which is the assertion that keeps the lint honest: the
    fixes and the guard ship together, so the tree must be clean.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_LINT = _HERE.parent / "lint-tmux-session-targets.py"
_ROOT = _HERE.parent.parent

_spec = importlib.util.spec_from_file_location("lint_tmux", _LINT)
lint = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lint)


class SessionTargetTests(unittest.TestCase):
    def test_shell_unanchored_variable_is_flagged(self):
        p = lint.check_line('  if ! tmux has-session -t "$SESSION" 2>/dev/null; then')
        self.assertEqual(len(p), 1, p)
        self.assertIn("unanchored", p[0])

    def test_shell_unanchored_literal_is_flagged(self):
        p = lint.check_line('env -u TMUX "$TMUXB" kill-session -t marveen 2>/dev/null || true')
        self.assertEqual(len(p), 1, p)
        self.assertIn('-t "=marveen"', p[0])

    def test_shell_anchored_is_clean(self):
        self.assertEqual(lint.check_line('tmux kill-session -t "=$SESSION" 2>/dev/null || true'), [])
        self.assertEqual(lint.check_line("tmux has-session -t '=marveen'"), [])

    def test_ts_arg_array_is_flagged(self):
        p = lint.check_line("    execFileSync(TMUX, ['has-session', '-t', session], { timeout: 3000 })")
        self.assertEqual(len(p), 1, p)

    def test_ts_arg_array_anchored_is_clean(self):
        self.assertEqual(
            lint.check_line("    execFileSync(TMUX, ['has-session', '-t', `=${session}`], {})"), []
        )

    def test_ts_template_string_is_flagged(self):
        p = lint.check_line("      execSync(`${TMUX} kill-session -t ${session} 2>/dev/null`)")
        self.assertEqual(len(p), 1, p)

    def test_python_list_is_flagged(self):
        p = lint.check_line('    res = ctx.ex.run(["tmux", "has-session", "-t", session])')
        self.assertEqual(len(p), 1, p)

    def test_suffixed_literal_is_flagged_with_the_full_name(self):
        p = lint.check_line('tmux kill-session -t "${SLUG}-channels" 2>/dev/null || true')
        self.assertEqual(len(p), 1, p)
        self.assertIn("${SLUG}-channels", p[0])


class NeverAnchorTests(unittest.TestCase):
    """The anchor is not universal. Measured on tmux 3.6 against an EXISTING
    session: display-message returns rc=0 and '' (silent), capture-pane and
    send-keys return rc=1 with "can't find pane" (loud), while list-panes and
    list-windows resolve fine. The lint carries the measured table, not a
    category argument about pane vs session targets."""

    def test_anchored_display_message_is_flagged_as_silent(self):
        p = lint.check_line("""LIVE=$(tmux display-message -t "=marveen" -p '#{session_created}')""")
        self.assertEqual(len(p), 1, p)
        self.assertIn("must NOT be anchored", p[0])
        self.assertIn("exit 0", p[0], "the finding must name the SILENT failure mode")

    def test_unanchored_display_message_is_not_this_lints_business(self):
        self.assertEqual(
            lint.check_line("""tmux display-message -t marveen -p '#{session_created}'"""), []
        )

    def test_send_keys_anchored_is_flagged(self):
        p = lint.check_line("""tmux send-keys -t "=$SESSION" 'hello' Enter""")
        self.assertEqual(len(p), 1, p)

    def test_list_panes_accepts_the_anchor_either_way(self):
        # Measured to resolve, so neither form is a finding: over-reporting here
        # would push people to silence the lint.
        self.assertEqual(lint.check_line("""tmux list-panes -t "=$SESSION" """), [])
        self.assertEqual(lint.check_line("""tmux list-panes -t "$SESSION" """), [])

    def test_unmeasured_command_asks_for_a_human_instead_of_guessing(self):
        p = lint.check_line("""tmux switch-client -t "$SESSION" """)
        self.assertEqual(len(p), 1, p)
        self.assertIn("NOT measured", p[0])
        self.assertIn("Do not guess", p[0])


class ReadabilityTests(unittest.TestCase):
    def test_unreadable_target_is_reported_not_skipped(self):
        # A line the parser cannot resolve must fail loudly. A linter that
        # quietly passes what it could not read is the failure mode this whole
        # card is about.
        p = lint.check_line("tmux kill-session -t")
        self.assertEqual(len(p), 1, p)
        self.assertIn("could not read its target", p[0])

    def test_ignore_marker_exempts_a_line(self):
        self.assertEqual(
            lint.check_line('tmux kill-session -t "$S"   # tmux-anchor-lint: ignore'), []
        )

    def test_unrelated_line_is_clean(self):
        self.assertEqual(lint.check_line('echo "kill-session is how we stop it"'), [])
        self.assertEqual(lint.check_line("tmux list-sessions -F '#{session_name}'"), [])


class WholeTreeTests(unittest.TestCase):
    def test_the_tree_has_no_unanchored_session_targets(self):
        r = subprocess.run(
            [sys.executable, str(_LINT), "--root", str(_ROOT)],
            capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(
            r.returncode, 0,
            "tmux session-target lint found violations:\n" + r.stdout[-4000:],
        )

    def test_the_lint_actually_fails_on_a_bad_file(self):
        # Guards against a lint that passes because it scanned nothing.
        with tempfile.TemporaryDirectory() as d:
            bad = os.path.join(d, "bad.sh")
            with open(bad, "w") as f:
                f.write("#!/usr/bin/env bash\ntmux kill-session -t marveen\n")
            r = subprocess.run(
                [sys.executable, str(_LINT), "--root", d, bad],
                capture_output=True, text=True, timeout=60,
            )
            self.assertEqual(r.returncode, 1)
            self.assertIn("unanchored", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
