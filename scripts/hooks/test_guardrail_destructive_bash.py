#!/usr/bin/env python3
"""Tests for the PreToolUse destructive-Bash hard-block guardrail hook.

Run: python3 scripts/hooks/test_guardrail_destructive_bash.py

Covers the four narrow deny rules (rm -rf root/home, force-push to a protected
branch, SQL DROP/TRUNCATE through a client, raw print of the PAT cred file), the
pure classifier, and an end-to-end subprocess pass (stdin JSON -> exit code +
stderr reason). The adversarial fixture set is the load-bearing half: for every
rule there are must-DENY (false-negative guard) AND must-ALLOW including a
similar-but-harmless "opposing" case (false-positive / self-DoS guard).

Fail-safe invariants pinned: matched-Bash-only, default-ALLOW, fail-OPEN on every
error/ambiguity, HARD-DENY (exit 2) only on a positively-matched destructive rule.

See store/destructive-bash-guard-threat-model.md (card dd48afb6).
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_HOOK = os.path.join(_HERE, "guardrail-destructive-bash.py")

_spec = importlib.util.spec_from_file_location("guardrail_destructive_bash", _HOOK)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)


# --- R1: rm -rf of a root / home -------------------------------------------
class RmRfRootTests(unittest.TestCase):
    DENY = [
        "rm -rf /",
        "rm -fr /",
        "rm -r -f /",
        "rm --recursive --force /",
        "rm -rf ~",
        "rm -rf ~/",
        "rm -rf $HOME",
        "rm -rf ${HOME}",
        "rm -rf /home/domin",
        "rm -rf /home/domin/",
        "sudo rm -rf /",
        "rm -rf --no-preserve-root /",
        "rm -rfv /home/domin",
        "echo cleaning && rm -rf ~",
    ]
    ALLOW = [
        "rm -rf /home/domin/marveen-wt/ack-main-special",  # worktree cleanup
        "rm -rf node_modules",
        "rm -rf ./dist",
        "rm -rf /tmp/build-xyz",
        "rm -rf /home/domin/marveen/store/tmp",
        "rm file.txt",                 # not recursive+force
        "rm -r somedir",               # recursive but not force, non-root
        "rm -f single",                # force but not recursive
        "rmdir /home/domin",           # not rm
        "echo rm -rf /",               # printing the string, not running it
    ]

    def test_deny(self):
        for c in self.DENY:
            self.assertTrue(guard.match_rm_rf_root(c), f"should DENY: {c}")

    def test_allow(self):
        for c in self.ALLOW:
            self.assertFalse(guard.match_rm_rf_root(c), f"should ALLOW: {c}")


# --- R2: force-push to a protected branch ----------------------------------
class ForcePushProtectedTests(unittest.TestCase):
    DENY = [
        "git push --force origin main",
        "git push -f origin develop",
        "git push --force-with-lease origin main",
        "git push origin +main",
        "git push origin +develop",
        "git push --force origin HEAD:main",
        "git push -f origin HEAD:develop",
        "git push origin +HEAD:main",
    ]
    ALLOW = [
        "git push --force origin eng/destructive-bash-guard",  # feature branch
        "git push -f origin eng/my-feature",
        "git push origin main",          # non-force push to main
        "git push origin develop",       # non-force
        "git push origin feature-branch",
        "git pull origin main",          # not a push
        "git push --force-with-lease origin eng/foo",
        "echo git push --force origin main",  # printed string
    ]

    def test_deny(self):
        for c in self.DENY:
            self.assertTrue(guard.match_force_push_protected(c), f"should DENY: {c}")

    def test_allow(self):
        for c in self.ALLOW:
            self.assertFalse(guard.match_force_push_protected(c), f"should ALLOW: {c}")


# --- R3: SQL DROP/TRUNCATE through a client --------------------------------
class SqlDropTests(unittest.TestCase):
    DENY = [
        'sqlite3 store/claudeclaw.db "DROP TABLE kanban_cards"',
        'sqlite3 store/claudeclaw.db "drop table memories"',
        'sqlite3 db "TRUNCATE TABLE agent_messages"',
        'psql -c "DROP DATABASE prod"',
        'mysql -e "DROP TABLE users"',
        'sqlite3 db "DROP   TABLE x"',
    ]
    ALLOW = [
        'grep "DROP TABLE" schema.sql',          # searching, not executing
        'echo "drop table notes"',               # printing
        'sqlite3 store/claudeclaw.db "SELECT * FROM kanban_cards"',
        'sqlite3 db "CREATE TABLE x (id INT)"',
        'cat migration.sql | grep -i truncate',  # no client invocation
    ]

    def test_deny(self):
        for c in self.DENY:
            self.assertTrue(guard.match_sql_drop(c), f"should DENY: {c}")

    def test_allow(self):
        for c in self.ALLOW:
            self.assertFalse(guard.match_sql_drop(c), f"should ALLOW: {c}")


# --- R4: raw print of the PAT credential file ------------------------------
class CredFilePrintTests(unittest.TestCase):
    DENY = [
        "cat /home/fakeuser/.git-credentials",
        "cat $HOME/.git-credentials",
        "cat ${HOME}/.git-credentials",
        "cat /home/fakeuser/.git-credentials",
        "echo $(cat /home/fakeuser/.git-credentials)",
        "base64 /home/fakeuser/.git-credentials",
        "head -1 /home/fakeuser/.git-credentials",
        "strings /home/fakeuser/.git-credentials",
        "tac /home/fakeuser/.git-credentials",                     # reverse-cat exfil (card 6f5af73d)
        "od -c /home/fakeuser/.git-credentials",         # octal-dump exfil (card 6f5af73d)
    ]
    ALLOW = [
        "cat store/.dashboard-token",                 # CRITICAL: legit fleet-ops idiom
        "TOKEN=$(cat /home/fakeuser/marveen/store/.dashboard-token)",
        'git config credential.helper store',         # not a print of the file
        "ls -la /home/fakeuser/.git-credentials",                  # listing metadata, not content
        'echo "cat /home/fakeuser/.git-credentials"',              # printing the literal string
    ]

    def test_deny(self):
        for c in self.DENY:
            self.assertTrue(guard.match_cred_file_print(c), f"should DENY: {c}")

    def test_allow(self):
        for c in self.ALLOW:
            self.assertFalse(guard.match_cred_file_print(c), f"should ALLOW: {c}")


# --- R4-enum: print of a closed set of sensitive files (card 48d3c0f9) -------
class SensitiveFilePrintTests(unittest.TestCase):
    DENY = [
        "cat /home/fakeuser/.ssh/id_rsa",                                   # SSH private key
        "cat /home/fakeuser/.ssh/id_ed25519",
        "base64 /home/fakeuser/.netrc",
        "cat $HOME/.aws/credentials",
        "cat /home/fakeuser/.ssh/id_rsa",
        "cat store/.session-secret",
        "echo $(cat store/.dashboard-session-secret)",
        "cat /home/fakeuser/marveen/store/.dashboard-session-secret",
        "cat store/.claude-session",                                        # claude.ai full-account credential (card 7fe5662f)
        "echo $(cat store/.claude-session)",
        "base64 /home/fakeuser/marveen/store/.claude-session",
        "cat agents/claudia/.claude/channels/google/oauth-tokens.json",
        "strings /home/fakeuser/.ssh/id_ecdsa",
    ]
    ALLOW = [
        "cat store/.dashboard-token",          # fleet-ops idiom (NOT in scope)
        "cat /home/fakeuser/.ssh/id_rsa.pub",               # public key is not sensitive
        "cat $HOME/.ssh/id_ed25519.pub",
        "cat /home/fakeuser/.aws/config",                   # config (not credentials) -- out of scope
        "ls -la /home/fakeuser/.ssh/id_rsa",                # listing metadata, not content
        'echo "cat /home/fakeuser/.ssh/id_rsa"',            # printing the literal string
        "cat .env",                            # .env handled by permission-ruleset R2, not here
        "cat /home/fakeuser/.ssh/known_hosts",              # not a private key
    ]

    def test_deny(self):
        for c in self.DENY:
            self.assertTrue(guard.match_sensitive_file_print(c), f"should DENY: {c}")

    def test_allow(self):
        for c in self.ALLOW:
            self.assertFalse(guard.match_sensitive_file_print(c), f"should ALLOW: {c}")


# --- classifier (pure) ------------------------------------------------------
class ClassifyTests(unittest.TestCase):
    def test_sensitive_file_print_denies_with_rule_name(self):
        denied, name, _ = guard.classify(
            {"tool_name": "Bash", "tool_input": {"command": "cat /home/fakeuser/.ssh/id_rsa"}}
        )
        self.assertTrue(denied)
        self.assertEqual(name, "sensitive-file-print")

    def test_non_bash_tool_passes(self):
        denied, name, _ = guard.classify({"tool_name": "Read", "tool_input": {"file_path": "/x"}})
        self.assertFalse(denied)
        self.assertEqual(name, "")

    def test_non_dict_payload_fails_open(self):
        denied, _, _ = guard.classify("nope")
        self.assertFalse(denied)

    def test_non_dict_input_fails_open(self):
        denied, _, _ = guard.classify({"tool_name": "Bash", "tool_input": None})
        self.assertFalse(denied)

    def test_missing_command_fails_open(self):
        denied, _, _ = guard.classify({"tool_name": "Bash", "tool_input": {}})
        self.assertFalse(denied)

    def test_non_string_command_fails_open(self):
        denied, _, _ = guard.classify({"tool_name": "Bash", "tool_input": {"command": 42}})
        self.assertFalse(denied)

    def test_benign_command_allows(self):
        denied, name, _ = guard.classify({"tool_name": "Bash", "tool_input": {"command": "ls -la"}})
        self.assertFalse(denied)
        self.assertEqual(name, "")

    def test_destructive_command_denies_with_rule_name(self):
        denied, name, reason = guard.classify(
            {"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}
        )
        self.assertTrue(denied)
        self.assertEqual(name, "rm-rf-root")
        self.assertIn("rm", reason.lower())

    def test_first_match_wins(self):
        rule = guard.first_match("git push --force origin main")
        self.assertIsNotNone(rule)
        self.assertEqual(rule.name, "force-push-protected")


# --- end-to-end (subprocess, full IO path) ---------------------------------
class EndToEndTests(unittest.TestCase):
    def _run(self, payload, raw=None):
        data = raw if raw is not None else json.dumps(payload)
        return subprocess.run(
            [sys.executable, _HOOK], input=data,
            capture_output=True, text=True,
        )

    def test_destructive_blocks_exit_2_with_reason(self):
        r = self._run({"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}})
        self.assertEqual(r.returncode, 2)
        self.assertIn("DESTRUCTIVE", r.stderr.upper())

    def test_benign_allows_exit_0(self):
        r = self._run({"tool_name": "Bash", "tool_input": {"command": "git status"}})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stderr, "")

    def test_non_bash_allows_exit_0(self):
        r = self._run({"tool_name": "Edit", "tool_input": {"file_path": "/x"}})
        self.assertEqual(r.returncode, 0)

    def test_malformed_stdin_fails_open(self):
        r = self._run(None, raw="{ broken")
        self.assertEqual(r.returncode, 0)

    def test_empty_stdin_fails_open(self):
        r = self._run(None, raw="")
        self.assertEqual(r.returncode, 0)

    def test_worktree_rm_allows_exit_0(self):
        # The load-bearing FP guard end-to-end: a real worktree cleanup must pass.
        r = self._run(
            {"tool_name": "Bash",
             "tool_input": {"command": "rm -rf /home/domin/marveen-wt/destructive-bash"}}
        )
        self.assertEqual(r.returncode, 0)


# --- port-regression guard for this file's splitter (card 2cb1ed6e, DA-62-E) --
class QuotedNestedCommandTests(unittest.TestCase):
    """This guard's splitter is quote-BLIND, and that is currently why it is safe.

    The sibling guard (guardrail-permission-rules.py) was given quote-awareness
    on 2026-07-01 to remove a set of false positives. That narrowing silently
    created card 2cb1ed6e: a command nested inside DOUBLE quotes stopped
    becoming its own piece, so every rule downstream classified it by the OUTER
    word. It took two commits to close, on the open side and then the close side.

    THIS file never received that change, so it still splits inside quotes and
    the nested command always becomes its own piece. The bug was created by the
    narrowing; the un-narrowed copy never had it.

    The forward hazard is a tidy-up. Porting the modern splitter here to make the
    two siblings consistent is an obvious refactor, and a re-derivation of the
    07-01 quote-awareness WITHOUT the two follow-up fixes re-creates 2cb1ed6e
    inside this guard, where the rules are cred-file-print and
    sensitive-file-print. The refactor is the regression vector and it will look
    like cleaning up.

    So the property is asserted here as behaviour rather than left resting on the
    absence of a change: whatever splitter this file uses, these four shapes must
    isolate the nested command. Port anything you like; this must stay green.
    """

    NESTED = "rm -rf /"
    SHAPES = [
        ("plain", "rm -rf /"),
        ("unquoted substitution", "echo $(rm -rf /)"),
        ("double-quoted substitution", 'echo "$(rm -rf /)"'),
        # the 2cb1ed6e close-side shape: a close paren inside quotes inside the
        # substitution must not end it early (measured against bash: the second
        # command runs)
        ("crafted, close paren inside single quotes",
         "echo \"$(echo 'x)' ; rm -rf /)\""),
        ("crafted, backtick form", "echo \"`echo 'x)' ; rm -rf /`\""),
    ]

    def test_nested_destructive_command_is_isolated_in_every_shape(self):
        for name, cmd in self.SHAPES:
            with self.subTest(shape=name):
                pieces = [p.strip() for p in guard._split_subcommands(cmd)]
                self.assertIn(self.NESTED, pieces, f"{name}: got {pieces!r}")

    def test_nested_destructive_command_is_denied_in_every_shape(self):
        """End of the chain: isolation is only interesting if the verdict follows."""
        for name, cmd in self.SHAPES:
            with self.subTest(shape=name):
                denied, rule, _ = guard.classify(
                    {"tool_name": "Bash", "tool_input": {"command": cmd}})
                self.assertTrue(denied, f"{name}: not denied")
                self.assertEqual(rule, "rm-rf-root", f"{name}: denied by {rule!r}")

    def test_the_port_happened_and_took_the_fixes_with_it(self):
        """This assertion was inverted by the port, on purpose, and it fired.

        Until card 151a0756 it read `assertGreater(len(pieces), 1)` and pinned
        the quote-BLIND behaviour, with a docstring predicting that a future port
        would flip it. That is what happened: `grep "foo|bar" file` is now one
        piece, this test went red, and the four shapes above stayed green -- the
        port took the quote-awareness AND the two follow-up fixes.

        What the old pin got wrong is worth keeping. It reasoned that
        quote-blindness only ever splits MORE, so it could only over-block, so
        the un-ported copy was the safe one. Splitting more is not the whole
        effect: the injected separator also lands inside a quoted string, which
        makes the piece unparseable, and an unparseable piece is DROPPED. The
        same blindness was over-blocking on one side and fail-open on the other,
        and the pin measured only the side that made the file look safe.
        """
        pieces = [p for p in guard._split_subcommands('grep "foo|bar" file') if p.strip()]
        self.assertEqual(len(pieces), 1, f"a quoted pipe is one command: {pieces!r}")


class CommandWordPrefixTests(unittest.TestCase):
    """A word standing before the command hid EVERY rule in this file.

    `_command_word` returned the first token, so the piece `do rm -rf /` had
    command word `do` and no rule applied. Measured through the real hook
    invocation before the fix: 55 cells, 50 allowed, only the bare column
    blocked -- `for x in 1; do rm -rf /; done` passed.

    The sibling guard blocked the paren form, because card ec7754d7 landed
    there. It never reached this copy, although the sibling header calls these
    helpers shared. So the paren row below is not decoration: it is the row that
    measures whether the two copies still agree.
    """

    WRAPPERS = [
        "{0}",
        "for x in 1; do {0}; done",
        "if true; then {0}; fi",
        "while read l; do {0}; done",
        "until false; do {0}; done",
        "{{ {0}; }}",
        "time {0}",
        "( {0} )",
        "command {0}",
        "env {0}",
        "timeout 5 {0}",
        "! {0}",
    ]
    PAYLOADS = [
        ("rm-rf-root", "rm -rf /"),
        ("rm-rf-root", "rm -rf /home/domin"),
        ("force-push-protected", "git push --force origin main"),
    ]

    def test_a_prefix_does_not_disable_the_rules(self):
        for expected_rule, payload in self.PAYLOADS:
            for wrapper in self.WRAPPERS:
                cmd = wrapper.format(payload)
                with self.subTest(cmd=cmd):
                    denied, rule, _ = guard.classify(
                        {"tool_name": "Bash", "tool_input": {"command": cmd}})
                    self.assertTrue(denied, f"a prefix must not turn the rule off: {cmd!r}")
                    self.assertEqual(rule, expected_rule)

    def test_the_skip_list_did_not_become_too_broad(self):
        """Skipping is for words that CANNOT be the command, plus a wrapper's own
        argument. Widening it to any unrecognised word would turn text that
        merely mentions a command into a block."""
        for cmd in [
            "echo rm -rf /",
            "git commit -m 'mention of rm -rf / in a message'",
            "grep do scripts/deploy.sh",
            "rm -rf /home/domin/marveen-wt/scratch",   # a deep path is allowed
        ]:
            with self.subTest(cmd=cmd):
                denied, rule, _ = guard.classify(
                    {"tool_name": "Bash", "tool_input": {"command": cmd}})
                self.assertFalse(denied, f"must not become a false positive: {cmd!r} ({rule})")

    def test_the_two_guards_share_the_same_prefix_model(self):
        """The sibling guard holds a COPY of this helper, and copies drift.

        They already had: the paren handling of card ec7754d7 landed in the
        sibling and never arrived here, so one guard blocked `( rm -rf / )` and
        the other did not -- while the sibling header described the helpers as
        shared. This asserts the agreement instead of describing it, so the next
        divergence fails a test rather than waiting to be measured.
        """
        import importlib.util
        sibling_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "guardrail-permission-rules.py")
        spec = importlib.util.spec_from_file_location("sibling_guard", sibling_path)
        sibling = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sibling)

        self.assertEqual(guard._SHELL_KEYWORDS, sibling._SHELL_KEYWORDS)
        self.assertEqual(guard._COMMAND_PREFIXES, sibling._COMMAND_PREFIXES)
        self.assertEqual(guard._PREFIX_ARG_RE.pattern, sibling._PREFIX_ARG_RE.pattern)
        # And the same tokens must resolve to the same command word in both.
        for tokens in (["do", "rm", "-rf", "/"], ["timeout", "5", "cat", ".env"],
                       ["!", "git", "push"], ["(rm", "-rf", "/"],
                       ["echo", "rm"], ["FOO=bar", "sudo", "cat", "f"]):
            with self.subTest(tokens=tokens):
                self.assertEqual(guard._command_word(tokens),
                                 sibling._command_word(tokens))


class QuotedSeparatorFailOpenTests(unittest.TestCase):
    """One quoted character after the command word turned all five rules off.

    Measured by rackham (N family) and reproduced here through the real hook
    invocation: five rules x four quoted forms, 20 cells, every one allowed --
    on the live file AND on the branch that had just closed the command-word
    gap. The two defects are orthogonal, so 55/55 on that axis said nothing
    about this one.

    Mechanism, and it is the pre-pass rather than any rule: `_CMD_SUBST_RE.sub`
    rewrote `)` `` ` `` `$(` to ';' in the RAW string, blind to quoting. Inside a
    quoted argument that injected separator cuts the piece in half, both halves
    are left with an unbalanced quote, `_tokenize` raises and returns None, and
    every rule reads `if not tokens: continue`. The dangerous piece is not
    misclassified -- it is never examined. Fail-open.

        rm -rf /            -> ['rm -rf /']              BLOCK
        rm -rf / "note )"   -> ['rm -rf / "note ', '"']  allow

    QuotedNestedCommandTests above states the opposite property, and it was
    green throughout: quote-blindness splits MORE, which is the safe direction.
    That is true and it is not the whole axis -- the same blindness also breaks
    quoting, and pieces that fail to parse are dropped. A test that asserts the
    safe half of a two-sided property reads as coverage.
    """

    PAYLOADS = [
        ("rm-rf-root", "rm -rf /"),
        ("force-push-protected", "git push --force origin main"),
        ("sql-drop", 'sqlite3 store/noa.db "DROP TABLE kanban_cards"'),
        ("cred-file-print", "cat ~/.git-credentials"),
        ("sensitive-file-print", "cat ~/.ssh/id_rsa"),
    ]
    # The split matters, and I asserted it wrongly before measuring it. All four
    # forms were allowed, so all four read as the same finding -- but only the
    # two paren forms are VALID bash. The other two cannot run, so allowing them
    # costs nothing: they are cell count, not danger. Ten dangerous cells, not
    # twenty. Both sets are pinned, for opposite reasons.
    RUNNABLE_FORMS = [
        ("double-quoted close paren", '{0} "note )"'),
        ("single-quoted close paren", "{0} 'note )'"),
    ]
    UNRUNNABLE_FORMS = [
        ("double-quoted backtick", '{0} "note `"'),
        ("double-quoted dollar-paren", '{0} "note $("'),
    ]
    QUOTED_FORMS = RUNNABLE_FORMS + UNRUNNABLE_FORMS

    def test_a_quoted_separator_does_not_disable_the_rules(self):
        for expected_rule, payload in self.PAYLOADS:
            for name, form in self.QUOTED_FORMS:
                cmd = form.format(payload)
                with self.subTest(rule=expected_rule, form=name):
                    denied, rule, _ = guard.classify(
                        {"tool_name": "Bash", "tool_input": {"command": cmd}})
                    self.assertTrue(denied, f"quoted separator turned the rule off: {cmd!r}")
                    self.assertEqual(rule, expected_rule)

    def test_which_bypass_forms_are_actually_runnable(self):
        """What separates a bypass from a curiosity, measured rather than counted.

        A form bash refuses to parse cannot be run, so allowing it costs nothing.
        `bash -n` parses without executing, which is what makes the distinction
        assertable at all -- and it is the distinction a raw cell count hides:
        twenty allowed cells, ten of them reachable.

        Pinned in both directions, because the unrunnable pair is what a future
        reader would otherwise re-measure to find out whether the fix is
        over-broad.
        """
        payload = self.PAYLOADS[0][1]
        for name, form in self.RUNNABLE_FORMS:
            with self.subTest(form=name, expect="valid"):
                cmd = form.format(payload)
                rc = subprocess.run(["bash", "-n"], input=cmd, text=True,
                                    capture_output=True).returncode
                self.assertEqual(rc, 0, f"expected runnable: {cmd!r}")
        for name, form in self.UNRUNNABLE_FORMS:
            with self.subTest(form=name, expect="syntax error"):
                cmd = form.format(payload)
                rc = subprocess.run(["bash", "-n"], input=cmd, text=True,
                                    capture_output=True).returncode
                self.assertNotEqual(rc, 0, f"expected unrunnable: {cmd!r}")

    def test_an_unparseable_piece_is_only_ever_unrunnable(self):
        """What the per-piece fail-open is allowed to cost, stated as a property.

        The rules skip a piece they cannot tokenize. That is safe only while an
        unparseable piece implies an unrunnable command -- which is true for a
        genuinely unbalanced quote and was FALSE for an injected separator,
        because the pre-pass manufactured the imbalance out of a valid command.
        With the split done during a quote-aware scan the imbalance can only
        come from the operator, so this asserts the implication rather than the
        symptom: any command whose pieces do not all tokenize must be rejected
        by bash itself.
        """
        commands = [form.format(p) for _, p in self.PAYLOADS
                    for _, form in self.QUOTED_FORMS]
        commands += ['echo "a )" && rm -rf /', "rm -rf / 'note'",
                     'grep "foo|bar" file', "(rm -rf /)", "rm -rf /"]
        for cmd in commands:
            with self.subTest(cmd=cmd):
                pieces = guard._split_subcommands(cmd)
                unparseable = [p for p in pieces
                               if p.strip() and guard._tokenize(p) is guard._PARSE_FAIL]
                if unparseable:
                    rc = subprocess.run(["bash", "-n"], input=cmd, text=True,
                                        capture_output=True).returncode
                    self.assertNotEqual(
                        rc, 0,
                        f"dropped {unparseable!r} from a command bash accepts: {cmd!r}")

    def test_the_rows_that_must_not_move(self):
        """The edges that rule out the plausible over-broad fixes.

        Named by rackham against the M/N corpus, and each one kills a different
        shortcut: a fix aimed at double quotes only, at parens only, or at "any
        command containing a paren" breaks one of these.
        """
        cases = [
            # (command, denied)
            ("myfunc rm -rf /", False),          # M9: bash runs a function, nothing is deleted
            ("rm -rf ./build", False),           # M10: the rule is scoped to roots on purpose
            ('git commit -m "do not rm -rf / here"', False),
            ('grep "foo|bar" file', False),      # a quoted pipe is an argument
            ("echo rm -rf /", False),
            ('echo "a )" && rm -rf /', True),    # N6: the class is position-dependent
            ('rm -rf / "note"', True),           # N7: the quote is not the trigger
            ("(rm -rf /)", True),                # unspaced subshell, card ec7754d7
            ("( rm -rf / )", True),
            ("for x in 1; do rm -rf /; done", True),
        ]
        for cmd, want_denied in cases:
            with self.subTest(cmd=cmd):
                denied, rule, _ = guard.classify(
                    {"tool_name": "Bash", "tool_input": {"command": cmd}})
                self.assertEqual(denied, want_denied,
                                 f"{cmd!r} -> denied={denied} ({rule})")


class DollarPrefixedQuotingTests(unittest.TestCase):
    """`$'...'` and `$"..."` hid a credential path from every anchored rule here.

    Found by rackham (O family) while attacking the scanner rather than the port,
    and it is not in the scanner: both guards tokenize this identically. shlex
    does not implement ANSI-C (`$'...'`) or locale (`$"..."`) quoting, so it
    leaves the dollar attached to the path:

        cat $'~/.git-credentials'  ->  ['cat', '$~/.git-credentials']

    bash strips it and reads the file (measured below, not argued). The rules in
    THIS file anchor the path to the whole token on purpose (card 48d3c0f9), so
    the stray dollar defeats them; the sibling happens to substring-search and
    blocks. Same helper, same tokens, opposite verdict -- one layer BELOW the
    identity assertion, which is exactly what that assertion cannot see.

    So the fix is tokenizer fidelity, not looser anchors: the anchors are the
    documented intent, and loosening them to match the sibling would trade a
    false negative for a class of false positives.

    O4/O5 are why "quoting disables the guard" is the wrong generalization. An
    escaped path and a concatenated-quote path normalize on their own and have
    always blocked, so a fix aimed at quoting in general would be aimed at the
    wrong thing.
    """

    MARKER = "DAVE-O-FAMILY-MARKER"
    CRED = "~/.git-credentials"
    KEY = "~/.ssh/id_rsa"

    BYPASS_FORMS = [
        ("dollar-single (ANSI-C)", "cat $'{0}'"),
        ("dollar-double (locale)", 'cat $"{0}"'),
    ]
    ALREADY_BLOCKED_FORMS = [
        ("bare", "cat {0}"),
        ("single-quoted", "cat '{0}'"),
        ("double-quoted", 'cat "{0}"'),
    ]

    def _reads_a_real_file(self, template):
        """Ground truth by execution, against a decoy -- never a real credential.

        Whether a form actually reads is the only thing that separates a bypass
        from a curiosity, and reasoning about bash quoting is precisely where the
        author of a scanner goes wrong. So the test measures it instead.
        """
        with tempfile.TemporaryDirectory() as td:
            decoy = os.path.join(td, "decoy-credentials")
            with open(decoy, "w") as fh:
                fh.write(self.MARKER + "\n")
            out = subprocess.run(["bash", "-c", template.format(decoy)],
                                 capture_output=True, text=True, timeout=10)
            return self.MARKER in (out.stdout or "")

    def test_the_bypass_forms_really_read_the_file(self):
        for name, template in self.BYPASS_FORMS:
            with self.subTest(form=name):
                self.assertTrue(self._reads_a_real_file(template),
                                f"{name} does not read, so it is not a bypass")

    def test_the_control_can_tell_reading_from_not_reading(self):
        self.assertTrue(self._reads_a_real_file("cat {0}"))
        self.assertFalse(self._reads_a_real_file("echo {0}"))

    def test_dollar_quoting_does_not_hide_a_credential_path(self):
        for path, expected in ((self.CRED, "cred-file-print"),
                               (self.KEY, "sensitive-file-print")):
            for name, template in self.BYPASS_FORMS + self.ALREADY_BLOCKED_FORMS:
                cmd = template.format(path)
                with self.subTest(form=name, path=path):
                    denied, rule, _ = guard.classify(
                        {"tool_name": "Bash", "tool_input": {"command": cmd}})
                    self.assertTrue(denied, f"dollar quoting hid the path: {cmd!r}")
                    self.assertEqual(rule, expected)

    def test_normalisation_is_quote_aware_and_narrow(self):
        """The edges that separate this fix from `strip every leading dollar`.

        Inside double or single quotes bash does NOT apply ANSI-C quoting, so a
        literal `$'` there must survive untouched -- otherwise a commit message
        or an echo becomes a block. And a real variable expansion must keep its
        dollar, or `$HOME/.ssh/id_rsa` stops resolving the way the rules expect.
        """
        must_allow = [
            "echo \"price is $'5'\"",
            "git commit -m \"note about $'quoting'\"",
            "echo 'literal $\\'x\\''",
        ]
        for cmd in must_allow:
            with self.subTest(cmd=cmd, expect="allow"):
                denied, rule, _ = guard.classify(
                    {"tool_name": "Bash", "tool_input": {"command": cmd}})
                self.assertFalse(denied, f"over-block from normalisation: {cmd!r} ({rule})")

        must_block = ["cat $HOME/.ssh/id_rsa", "cat ${HOME}/.git-credentials"]
        for cmd in must_block:
            with self.subTest(cmd=cmd, expect="block"):
                denied, _, _ = guard.classify(
                    {"tool_name": "Bash", "tool_input": {"command": cmd}})
                self.assertTrue(denied, f"variable expansion stopped resolving: {cmd!r}")

    def test_the_pin_on_escape_expansion_was_inverted_not_deleted(self):
        """This method used to assert that the escape gap was OPEN, correctly.

        A stated limit records what happens today. It does not say whether what
        happens today is reachable, and that is a different measurement -- one
        the pin quietly reads as if it had already been taken. rackham took it
        (P family): the escape expands, the expanded word is looked up AS a
        command, the read happens, and the shape parses. So the limit became a
        defect, and a wider one than the pin described.

        The pin fired on the day the axis moved, which is the whole reason to
        write one down. See AnsiCEscapeExpansionTests for the closure.
        """
        cmd = "$'\\x63at' ~/.git-credentials"
        self.assertTrue(self._reads_a_real_file("$'\\x63at' {0}"),
                        "bash no longer reads this -- the premise changed")
        denied, rule, _ = guard.classify(
            {"tool_name": "Bash", "tool_input": {"command": cmd}})
        self.assertTrue(denied, "the escape gap reopened")
        self.assertEqual(rule, "cred-file-print")


class AnsiCEscapeExpansionTests(unittest.TestCase):
    """`$'\\x72m' -rf /` runs rm, and neither guard saw a command word at all.

    The O family hid a PATH from rules that anchor it. This hides the VERB, so
    it is not confined to the credential rules: one layer further up, no rule
    even reaches its subject. `_expand_dollar_quoting` was written knowing the
    escape axis existed and deliberately did not implement it; the axis was
    pinned instead. Pinning is not covering.

    The direction of the fix is set by the control, not by the bypasses. Plain
    `'\\x72m'` carries the same escape text and bash never expands it -- it is a
    command-not-found, and allowing it is CORRECT. So "expand escapes" is the
    wrong generalization in exactly the way "quoting disables the guard" was for
    the O family. What bash expands is `$'...'`, and that is what this expands.
    """

    MARKER = "DAVE-P-FAMILY-MARKER"
    STYLES = ("hex", "octal", "unicode", "first-char-only")
    CRED = "~/.git-credentials"
    KEY = "~/.ssh/id_rsa"

    @staticmethod
    def _escape_body(word, style):
        """The word as bash escape text, without the quoting that activates it."""
        if style == "hex":
            return "".join("\\x%02x" % ord(c) for c in word)
        if style == "octal":
            return "".join("\\%03o" % ord(c) for c in word)
        if style == "unicode":
            return "".join("\\u%04x" % ord(c) for c in word)
        if style == "first-char-only":
            return "\\x%02x" % ord(word[0]) + word[1:]
        raise AssertionError("unknown style %r" % style)

    def _ansi_c(self, word, style):
        return "$'%s'" % self._escape_body(word, style)

    def _plain(self, word, style):
        """The same escape text with no dollar: bash leaves it literal."""
        return "'%s'" % self._escape_body(word, style)

    def _verdict(self, cmd):
        return guard.classify({"tool_name": "Bash", "tool_input": {"command": cmd}})

    def test_the_escape_expands_and_the_word_is_looked_up_as_a_command(self):
        """Two links, and the second is the one worth measuring.

        That `$'\\x65cho'` is the string `echo` says nothing on its own; the
        question is whether bash then RESOLVES it. Run against the harmless twin
        so the answer comes from execution rather than from reasoning about
        quoting, which is where the author of a scanner goes wrong.
        """
        for style in self.STYLES:
            with self.subTest(style=style):
                out = subprocess.run(
                    ["bash", "-c", "%s %s" % (self._ansi_c("echo", style), self.MARKER)],
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(out.returncode, 0, out.stderr)
                self.assertIn(self.MARKER, out.stdout,
                              "the hidden verb did not resolve, so it is not a bypass")

    def test_the_plain_quoted_control_does_not_resolve(self):
        """The row that keeps the fix off the tokenizer as a whole.

        Same escape text, no dollar, and bash does not expand it. Nothing runs,
        so allowing it is right -- and any fix that blocked it would be blocking
        a string.
        """
        for style in self.STYLES:
            if style == "first-char-only":
                continue  # the tail is a real word; only the escape must stay dead
            with self.subTest(style=style):
                out = subprocess.run(
                    ["bash", "-c", "%s %s" % (self._plain("echo", style), self.MARKER)],
                    capture_output=True, text=True, timeout=10)
                self.assertNotEqual(out.returncode, 0)
                self.assertNotIn(self.MARKER, out.stdout)
                denied, rule, _ = self._verdict("%s -rf /" % self._plain("rm", style))
                self.assertFalse(denied, "blocked a literal string: %s" % rule)

    def test_a_hidden_verb_does_not_disable_the_rules(self):
        for style in self.STYLES:
            for word, rest, expected in (
                ("rm", " -rf /", "rm-rf-root"),
                ("cat", " ~/.git-credentials", "cred-file-print"),
                ("cat", " ~/.ssh/id_rsa", "sensitive-file-print"),
            ):
                cmd = self._ansi_c(word, style) + rest
                with self.subTest(style=style, cmd=cmd):
                    denied, rule, _ = self._verdict(cmd)
                    self.assertTrue(denied, "hidden verb defeated the rules: %r" % cmd)
                    self.assertEqual(rule, expected)

    def test_a_hidden_path_is_still_a_path(self):
        """The O family axis again, this time reached through the escapes."""
        for style in self.STYLES:
            for path, expected in ((self.CRED, "cred-file-print"),
                                   (self.KEY, "sensitive-file-print")):
                for cmd in ("cat " + self._ansi_c(path, style),
                            self._ansi_c("cat", style) + " " + self._ansi_c(path, style)):
                    with self.subTest(style=style, cmd=cmd):
                        denied, rule, _ = self._verdict(cmd)
                        self.assertTrue(denied, "hidden path defeated the rules: %r" % cmd)
                        self.assertEqual(rule, expected)

    def test_the_expansion_is_scoped_the_way_bash_scopes_it(self):
        """Where an over-eager expander would start blocking ordinary work.

        bash applies ANSI-C quoting only to `$'...'` standing on its own: not
        inside double quotes, not inside single quotes, and never to a variable
        expansion. Each of these carries escape text that a blind expander would
        happily turn into something else.
        """
        must_allow = [
            r"""echo "an escape $'\x72m' inside double quotes" """,
            r"""echo 'an escape $'\''\x72m'\'' inside single quotes'""",
            r"""awk '{print $1}' /tmp/x""",
            r"""grep -P '\x41' /tmp/x""",
            r"""git commit -m 'mentions \x72m -rf / in prose'""",
        ]
        for cmd in must_allow:
            with self.subTest(cmd=cmd, expect="allow"):
                denied, rule, _ = self._verdict(cmd)
                self.assertFalse(denied, "over-block from expansion: %r (%s)" % (cmd, rule))

        must_block = ["cat $HOME/.ssh/id_rsa", "cat ${HOME}/.git-credentials",
                      "rm -rf /", "cat ~/.git-credentials"]
        for cmd in must_block:
            with self.subTest(cmd=cmd, expect="block"):
                denied, _, _ = self._verdict(cmd)
                self.assertTrue(denied, "expansion broke an existing rule: %r" % cmd)

    BENIGN_ANSI_C = [
        r"IFS=$'\n' read -r line",
        r"sort -t $'\t' -k2 /tmp/x",
        r"awk -F $'\t' '{print $1}' /tmp/x",
        r"cut -d $'\t' -f1 /tmp/x",
        r"git log --format=$'%h\t%s' -n 5",
        r"printf $'%s\n' hello",
        r"echo $'line1\nline2'",
        r"grep -P $'\t' /tmp/x",
        r"tmux send-keys -t '=agent-dave:' $'\x03'",
        r"git commit -m $'first line\n\nbody text'",
        r"cat $'/tmp/my file.txt'",
        r"rm -rf $'/tmp/scratch dir'",
        r"sed -i $'s/\t/ /g' /tmp/x",
        r"find . -name $'*.log' -newer /tmp/x",
    ]

    def test_ordinary_ansi_c_quoting_is_not_a_block(self):
        r"""Hand-built, and it has to be, which is the honest part.

        The 879-command fleet differential that cleared the O family fix contains
        zero occurrences of `$'`. Re-running it here returns zero differences and
        means nothing: it never reaches the changed code. Reporting that zero on
        its own would read as coverage of a surface nobody measured.

        The guard does not read the repository, it reads what a model types, and
        `IFS=$'\n'` and `-t $'\t'` are the ordinary way to write a delimiter. So
        the false-positive side is measured on rows written for it. Each one
        parses, so a row cannot pass by being a typo the rules ignore.
        """
        for cmd in self.BENIGN_ANSI_C:
            with self.subTest(cmd=cmd):
                syntax = subprocess.run(["bash", "-n", "-c", cmd],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(syntax.returncode, 0,
                                 "row is not valid bash, so it proves nothing")
                denied, rule, _ = self._verdict(cmd)
                self.assertFalse(denied, "expansion blocked ordinary work: %r (%s)"
                                         % (cmd, rule))

    def test_an_unterminated_quote_is_not_made_runnable(self):
        """The scanner must not invent a token bash would never build."""
        for cmd in (r"echo $'\x72m", r"cat $'~/.git-credentials"):
            with self.subTest(cmd=cmd):
                syntax = subprocess.run(["bash", "-n", "-c", cmd],
                                        capture_output=True, text=True, timeout=10)
                self.assertNotEqual(syntax.returncode, 0,
                                    "this parses now -- it needs a real verdict")
                self._verdict(cmd)  # must not raise

    def test_both_guards_deny_this_family_not_just_this_file(self):
        """The answer to what the identity assertion cannot say.

        Comparing two copies at the helper layer reads like agreement about
        behaviour and is not. So this asks the layer the verdict actually comes
        out of, on the same inputs, in both files -- the credential rows, which
        are the ones both rulesets claim.
        """
        import importlib.util

        sibling_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "guardrail-permission-rules.py")
        spec = importlib.util.spec_from_file_location("sibling_for_ansi_c", sibling_path)
        sibling = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sibling)

        for style in self.STYLES:
            for cmd in (self._ansi_c("cat", style) + " " + self.CRED,
                        "cat " + self._ansi_c(self.CRED, style)):
                with self.subTest(style=style, cmd=cmd):
                    self.assertTrue(self._verdict(cmd)[0], "destructive allowed %r" % cmd)
                    self.assertTrue(
                        sibling.classify({"tool_name": "Bash",
                                          "tool_input": {"command": cmd},
                                          "cwd": "/home/domin/marveen"})[0],
                        "permission guard allowed %r" % cmd)


class SiblingSourceIdentityTests(unittest.TestCase):
    """`# helpers (shared with destructive-bash)` in the sibling header was false.

    The two files hold copies, they had already drifted on the paren row, and the
    comment is what kept anyone from measuring the second copy -- it asserted a
    property nobody had checked, and read like a finished measurement.

    Behavioural agreement is not enough to catch this class: the two copies
    agreed on almost every command-word input while their SPLITTERS disagreed on
    a bypass. So the three helpers are now compared as SOURCE. If a fix has to be
    made twice, a test should be the thing that says so.
    """

    SHARED = ("_split_subcommands", "_tokenize", "_command_word",
              "_expand_dollar_quoting", "_expand_ansi_c")

    def setUp(self):
        import importlib.util
        sibling_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "guardrail-permission-rules.py")
        spec = importlib.util.spec_from_file_location("sibling_guard", sibling_path)
        self.sibling = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.sibling)

    @staticmethod
    def _code_shape(fn):
        """The function as CODE: parsed, docstring dropped, positions dropped.

        Comparing raw text would force one file to carry the other prose, and
        each guard has to be able to explain itself in terms of its own rules.
        Comment drift is not the hazard here -- a fix landing in one copy is,
        and that always shows up in the tree.
        """
        import ast
        import inspect
        import textwrap

        tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
        node = tree.body[0]
        if (node.body and isinstance(node.body[0], ast.Expr)
                and isinstance(node.body[0].value, ast.Constant)
                and isinstance(node.body[0].value.value, str)):
            node.body = node.body[1:]
        return ast.dump(node)

    def test_the_shared_helpers_have_identical_code(self):
        for name in self.SHARED:
            with self.subTest(helper=name):
                self.assertEqual(
                    self._code_shape(getattr(guard, name)),
                    self._code_shape(getattr(self.sibling, name)),
                    f"{name} has drifted between the two guards; a fix landing "
                    f"in one copy only is how card 151a0756 happened")

    def test_the_comparison_can_actually_fail(self):
        """A green identity test proves nothing if the comparison is degenerate.

        `ast.dump` on two different functions must differ, or the test above
        would pass on any pair -- including the pre-fix pair it exists to catch.
        """
        self.assertNotEqual(self._code_shape(guard._command_word),
                            self._code_shape(guard._tokenize))


if __name__ == "__main__":
    unittest.main(verbosity=2)
