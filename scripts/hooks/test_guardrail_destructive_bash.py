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


if __name__ == "__main__":
    unittest.main(verbosity=2)
