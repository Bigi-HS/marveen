#!/usr/bin/env python3
"""Acceptance tests for scripts/mcp-policy-check.py.

Covers the three verdict paths (PASS / CONDITIONAL / BLOCK) at both the
importable-function level and the CLI level (stdin descriptor, --attrs,
--json, and exit codes).

Run: python3 scripts/__tests__/mcp-policy-check.test.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import unittest

_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "mcp-policy-check.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("mcp_policy_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mpc = _load_module()


def _run_cli(args, stdin=None):
    return subprocess.run(
        [sys.executable, _SCRIPT] + args,
        input=stdin,
        capture_output=True,
        text=True,
    )


class EvaluatePassTests(unittest.TestCase):
    """A trusted, hooked, no-risk server clears the gate."""

    def test_clean_descriptor_passes(self):
        r = mpc.evaluate(
            "context7",
            {
                "maintainer_trust": "trusted",
                "has_pretooluse_hook": True,
                "reads_secrets": False,
                "external_egress": False,
                "requested_by": "scout",
            },
        )
        self.assertEqual(r["verdict"], mpc.PASS)
        self.assertEqual(r["conditions"], [])

    def test_pass_exit_code_zero(self):
        desc = json.dumps(
            {
                "name": "context7",
                "maintainer_trust": "trusted",
                "has_pretooluse_hook": True,
                "requested_by": "scout",
            }
        )
        r = _run_cli([], stdin=desc)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("verdict: PASS", r.stdout)


class EvaluateConditionalTests(unittest.TestCase):
    """Hook-first precondition + community/unknown trust => CONDITIONAL."""

    def test_no_pretooluse_hook_is_conditional(self):
        r = mpc.evaluate(
            "somemcp",
            {
                "maintainer_trust": "trusted",
                "has_pretooluse_hook": False,
                "requested_by": "dave",
            },
        )
        self.assertEqual(r["verdict"], mpc.CONDITIONAL)
        self.assertTrue(any("PreToolUse" in c for c in r["conditions"]))

    def test_community_maintainer_local_only_conditional(self):
        r = mpc.evaluate(
            "somemcp",
            {
                "maintainer_trust": "community",
                "has_pretooluse_hook": True,
                "external_egress": False,
                "requested_by": "dave",
            },
        )
        self.assertEqual(r["verdict"], mpc.CONDITIONAL)

    def test_secrets_plus_egress_but_justified_is_conditional(self):
        """reads_secrets + external_egress WITH a requester is downgraded to
        CONDITIONAL (scoped creds + egress logging), never an auto-PASS."""
        r = mpc.evaluate(
            "vault-bridge",
            {
                "maintainer_trust": "trusted",
                "has_pretooluse_hook": True,
                "reads_secrets": True,
                "external_egress": True,
                "requested_by": "chad",
            },
        )
        self.assertEqual(r["verdict"], mpc.CONDITIONAL)

    def test_conditional_exit_code_one(self):
        r = _run_cli(
            ["--name", "somemcp", "--attrs",
             json.dumps({"has_pretooluse_hook": False,
                         "maintainer_trust": "trusted",
                         "requested_by": "dave"})],
        )
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("verdict: CONDITIONAL", r.stdout)


class EvaluateBlockTests(unittest.TestCase):
    """Exfiltration-shaped / unvetted-egress descriptors are blocked."""

    def test_secrets_plus_egress_unjustified_blocks(self):
        r = mpc.evaluate(
            "sketchy",
            {
                "maintainer_trust": "community",
                "has_pretooluse_hook": True,
                "reads_secrets": True,
                "external_egress": True,
                "requested_by": "",
            },
        )
        self.assertEqual(r["verdict"], mpc.BLOCK)
        self.assertTrue(any("exfiltration" in r2 for r2 in r["reasons"]))

    def test_unknown_maintainer_with_egress_blocks(self):
        r = mpc.evaluate(
            "randomthing",
            {
                "maintainer_trust": "unknown",
                "has_pretooluse_hook": True,
                "external_egress": True,
                "requested_by": "dave",
            },
        )
        self.assertEqual(r["verdict"], mpc.BLOCK)

    def test_block_exit_code_two(self):
        desc = json.dumps(
            {
                "name": "sketchy",
                "maintainer_trust": "community",
                "has_pretooluse_hook": True,
                "reads_secrets": True,
                "external_egress": True,
            }
        )
        r = _run_cli(["--json"], stdin=desc)
        self.assertEqual(r.returncode, 2, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["verdict"], "BLOCK")


class InputHandlingTests(unittest.TestCase):
    """Defaults, coercion, and bad-input handling."""

    def test_empty_attrs_defaults_to_conditional(self):
        # no hook by default => CONDITIONAL, never a silent PASS
        r = mpc.evaluate("bare", {})
        self.assertEqual(r["verdict"], mpc.CONDITIONAL)

    def test_string_booleans_coerced(self):
        r = mpc.evaluate(
            "x",
            {
                "maintainer_trust": "trusted",
                "has_pretooluse_hook": "true",
                "requested_by": "dave",
            },
        )
        self.assertEqual(r["verdict"], mpc.PASS)

    def test_unknown_trust_value_falls_back_to_unknown(self):
        r = mpc.evaluate(
            "x",
            {"maintainer_trust": "bogus", "has_pretooluse_hook": True,
             "external_egress": False, "requested_by": "dave"},
        )
        self.assertEqual(r["attributes"]["maintainer_trust"], "unknown")

    def test_bad_json_stdin_exit_three(self):
        r = _run_cli([], stdin="{not json")
        self.assertEqual(r.returncode, 3)
        self.assertIn("invalid descriptor", r.stderr)


if __name__ == "__main__":
    if not os.path.exists(_SCRIPT):
        print(f"SKIP: {_SCRIPT} not found")
        sys.exit(0)
    unittest.main(verbosity=2)
