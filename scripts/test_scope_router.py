#!/usr/bin/env python3
"""TDD tests for scope_router.py (card 99a535d4, spec §2.3 / AC-S6).

Covers:
  - route(): accept / redirect / escalate decisions
  - AC-S6: out-of-scope domain triggers redirectTo suggestion (not silent swallow)
  - log_redirect_event(): writes one redirect log line to daily-log API
"""

import importlib.util
import json
import pathlib
import unittest

_SCRIPT = pathlib.Path(__file__).parent / "scope_router.py"


def load_router():
    spec = importlib.util.spec_from_file_location("scope_router", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _cfg(owns=None, excludes=None, redirect_to=None):
    """Build a minimal agent config with a scope block."""
    return {
        "scope": {
            "charter": "DRAFT: placeholder.",
            "owns": owns or [],
            "excludes": excludes or [],
            "redirectTo": redirect_to or {},
        }
    }


# ---------------------------------------------------------------------------
# route() unit tests
# ---------------------------------------------------------------------------

class TestRoute(unittest.TestCase):

    def test_owned_domain_accepted(self):
        r = load_router()
        cfg = _cfg(owns=["core-eng"])
        result = r.route("kidd", "core-eng", cfg)
        self.assertEqual(result["action"], "accept")

    def test_excluded_domain_with_redirect(self):
        """AC-S6 core: exclude + redirectTo -> redirect action."""
        r = load_router()
        cfg = _cfg(excludes=["security-audit"], redirect_to={"security-audit": "chad"})
        result = r.route("kidd", "security-audit", cfg)
        self.assertEqual(result["action"], "redirect")
        self.assertEqual(result["to"], "chad")

    def test_excluded_domain_no_redirect_escalates_to_marveen(self):
        """Exclude without redirectTo -> escalate to marveen (default §1.4)."""
        r = load_router()
        cfg = _cfg(excludes=["deploy-sre"], redirect_to={})
        result = r.route("kidd", "deploy-sre", cfg)
        self.assertEqual(result["action"], "escalate")
        self.assertEqual(result["to"], "marveen")

    def test_unknown_domain_pass_through(self):
        """Domain not in owns or excludes -> accept (not explicitly restricted)."""
        r = load_router()
        cfg = _cfg(owns=["core-eng"], excludes=["security-audit"])
        result = r.route("kidd", "research", cfg)
        self.assertEqual(result["action"], "accept")

    def test_empty_scope_accepts_all(self):
        """No scope block at all -> accept (graceful default)."""
        r = load_router()
        result = r.route("kidd", "core-eng", {})
        self.assertEqual(result["action"], "accept")

    def test_multiple_excludes_each_redirect_independently(self):
        r = load_router()
        cfg = _cfg(
            excludes=["security-audit", "deploy-sre"],
            redirect_to={"security-audit": "chad", "deploy-sre": "forge"},
        )
        self.assertEqual(r.route("kidd", "security-audit", cfg)["to"], "chad")
        self.assertEqual(r.route("kidd", "deploy-sre", cfg)["to"], "forge")

    def test_domain_in_both_owns_and_excludes_prefers_accept(self):
        """owns takes priority over excludes (AC-S2 should prevent this in prod,
        but the router must not crash or escalate when it happens)."""
        r = load_router()
        cfg = _cfg(owns=["core-eng"], excludes=["core-eng"])
        result = r.route("kidd", "core-eng", cfg)
        self.assertEqual(result["action"], "accept")


# ---------------------------------------------------------------------------
# AC-S6: redirect-fixture (functional, 1 documented log line)
# ---------------------------------------------------------------------------

class TestACS6RedirectFixture(unittest.TestCase):
    """AC-S6: out-of-scope request triggers redirectTo suggestion, not silent swallow.

    Fixture: kidd receives a 'security-audit' request.
    kidd.scope.excludes=['security-audit'], redirectTo={'security-audit':'chad'}.
    Expected: route() returns redirect->chad; log_redirect_event() writes daily-log entry.
    """

    FIXTURE_AGENT = "kidd"
    FIXTURE_DOMAIN = "security-audit"
    FIXTURE_CFG = _cfg(
        owns=["core-eng"],
        excludes=["security-audit"],
        redirect_to={"security-audit": "chad"},
    )

    def test_ac_s6_route_returns_redirect_not_swallow(self):
        """Core AC-S6 assertion: decision is redirect, NOT accept (silent swallow)."""
        r = load_router()
        result = r.route(self.FIXTURE_AGENT, self.FIXTURE_DOMAIN, self.FIXTURE_CFG)
        self.assertNotEqual(result["action"], "accept",
                            "AC-S6 FAIL: out-of-scope domain was silently accepted")
        self.assertEqual(result["action"], "redirect",
                         f"expected redirect, got: {result}")
        self.assertEqual(result["to"], "chad",
                         f"expected redirect target=chad, got: {result}")

    def test_ac_s6_log_redirect_event_writes_daily_log(self):
        """AC-S6 integration: log_redirect_event() POSTs one line to daily-log API.

        This test writes the documented redirect-naplósor required by AC-S6.
        Skipped if API is unavailable (routing logic tested above is the primary AC).
        """
        r = load_router()
        api_base = "http://localhost:3420"
        # store/ is gitignored; check worktree-relative path first, then main repo
        candidates = [
            pathlib.Path(__file__).parent.parent / "store" / ".dashboard-token",
            pathlib.Path("/home/domin/marveen/store/.dashboard-token"),
        ]
        token_path = next((p for p in candidates if p.exists()), None)
        if token_path is None:
            self.skipTest("dashboard token not available")
        token = token_path.read_text().strip()
        decision = r.route(self.FIXTURE_AGENT, self.FIXTURE_DOMAIN, self.FIXTURE_CFG)
        ok = r.log_redirect_event(
            self.FIXTURE_AGENT, self.FIXTURE_DOMAIN, decision, api_base, token
        )
        self.assertTrue(ok, "log_redirect_event() returned False -- API call failed")


# ---------------------------------------------------------------------------
# log_redirect_event() unit test (mocked)
# ---------------------------------------------------------------------------

class TestLogRedirectEvent(unittest.TestCase):

    def test_log_redirect_event_builds_correct_content(self):
        """log_redirect_event calls the API with agent_id, domain, action info."""
        import unittest.mock as mock
        r = load_router()
        captured = []

        class _FakeResponse:
            def read(self): return b"{}"
            def __enter__(self): return self
            def __exit__(self, *a): pass

        with mock.patch("urllib.request.urlopen", return_value=_FakeResponse()) as m:
            ok = r.log_redirect_event("kidd", "security-audit",
                                      {"action": "redirect", "to": "chad"},
                                      "http://localhost:3420", "test-token")
        self.assertTrue(ok)
        call_args = m.call_args
        req = call_args[0][0]
        body = json.loads(req.data.decode())
        self.assertEqual(body["agent_id"], "kidd")
        self.assertIn("security-audit", body["content"])
        self.assertIn("chad", body["content"])
        self.assertIn("scope-redirect", body["content"])


if __name__ == "__main__":
    unittest.main()
