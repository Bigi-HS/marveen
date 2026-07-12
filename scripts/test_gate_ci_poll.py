#!/usr/bin/env python3
"""Unit tests for gate-ci-poll.py selection logic (card d44c9c75).

Run: python3 scripts/test_gate_ci_poll.py
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("gate_ci_poll", os.path.join(_HERE, "gate-ci-poll.py"))
g = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(g)


class NeedsCi(unittest.TestCase):
    def test_none_needs_ci(self):
        self.assertTrue(g.needs_ci({"ci_status": "none"}))

    def test_pass_does_not_need_ci(self):
        self.assertFalse(g.needs_ci({"ci_status": "pass"}))

    def test_fail_does_not_need_ci(self):
        # A recorded FAIL is still a result for this head -- don't re-run it every tick.
        self.assertFalse(g.needs_ci({"ci_status": "fail"}))

    def test_missing_key_is_not_needs(self):
        self.assertFalse(g.needs_ci({}))


class SelectTarget(unittest.TestCase):
    def _check_of(self, mapping):
        return lambda n: mapping[n]

    def test_picks_oldest_pr_needing_ci(self):
        prs = [{"number": 380}, {"number": 344}, {"number": 350}]
        checks = {344: {"ci_status": "pass"}, 350: {"ci_status": "none"}, 380: {"ci_status": "none"}}
        target = g.select_target(prs, self._check_of(checks))
        self.assertEqual(target["number"], 350)  # 344 has CI, next oldest is 350

    def test_none_when_all_have_ci(self):
        prs = [{"number": 1}, {"number": 2}]
        checks = {1: {"ci_status": "pass"}, 2: {"ci_status": "fail"}}
        self.assertIsNone(g.select_target(prs, self._check_of(checks)))

    def test_skips_pr_whose_check_raises(self):
        prs = [{"number": 5}, {"number": 9}]

        def check_of(n):
            if n == 5:
                raise RuntimeError("gate-check 502")
            return {"ci_status": "none"}

        target = g.select_target(prs, check_of)
        self.assertEqual(target["number"], 9)  # 5 errored -> skipped, 9 selected

    def test_empty_pr_list(self):
        self.assertIsNone(g.select_target([], lambda n: {"ci_status": "none"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
