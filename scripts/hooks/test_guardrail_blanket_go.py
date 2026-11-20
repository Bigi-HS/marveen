#!/usr/bin/env python3
"""Tests for the blanket-GO engedelykero-warn hook (card f8e81574).

Adversarial fixture classes:
  DANGEROUS path  -- engedelykero szoveg Boss-facing Telegramon = SHOULD warn (exit 2)
  SAFE path       -- legitim Boss-tajekozatas / dontes-jelentes = must NOT warn (exit 0)
  BOUNDARY        -- pontosan a kivetelezett esetek hatarain (hol szabad meg kerdezni)
  FAIL-OPEN       -- hiba/edge-case -> soha ne brickelje az agenst
  DATE-GATE       -- blanket-GO lejarta utan inaktiv
"""

import importlib.util
import os
import sys
import io
import unittest
from datetime import date
from unittest.mock import patch

# Load hook module without running main()
_HOOK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guardrail-blanket-go.py")
_spec = importlib.util.spec_from_file_location("guardrail_blanket_go", _HOOK_PATH)
_hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hook)


def _payload(tool_name, **tool_input):
    return {"tool_name": tool_name, "tool_input": tool_input}


REPLY = "mcp__plugin_telegram_telegram__reply"
EDIT = "mcp__plugin_telegram_telegram__edit_message"


# ---------------------------------------------------------------------------
# blanket_go_active date-gate
# ---------------------------------------------------------------------------
class TestBlanketGoActive(unittest.TestCase):

    def test_active_before_expiry(self):
        # 2026-11-20 < 2027-02-01 -> active
        self.assertTrue(_hook.blanket_go_active(today=date(2026, 11, 20)))

    def test_active_on_day_before_expiry(self):
        # 2027-01-31 < 2027-02-01 -> active
        self.assertTrue(_hook.blanket_go_active(today=date(2027, 1, 31)))

    def test_inactive_on_expiry_day(self):
        # 2027-02-01 is NOT < 2027-02-01 -> inactive
        self.assertFalse(_hook.blanket_go_active(today=date(2027, 2, 1)))

    def test_inactive_after_expiry(self):
        self.assertFalse(_hook.blanket_go_active(today=date(2027, 6, 1)))

    def test_fail_open_on_none_date(self):
        # None uses date.today(); should not raise
        result = _hook.blanket_go_active(today=None)
        self.assertIsInstance(result, bool)


# ---------------------------------------------------------------------------
# extract_text: tool scope
# ---------------------------------------------------------------------------
class TestExtractText(unittest.TestCase):

    def test_reply_tool_guarded(self):
        p = _payload(REPLY, chat_id="123", text="GO-dra varok")
        text, is_guarded = _hook.extract_text(p)
        self.assertTrue(is_guarded)
        self.assertEqual(text, "GO-dra varok")

    def test_edit_message_tool_guarded(self):
        p = _payload(EDIT, chat_id="123", message_id=1, text="elesithed?")
        text, is_guarded = _hook.extract_text(p)
        self.assertTrue(is_guarded)
        self.assertEqual(text, "elesithed?")

    def test_bash_not_guarded(self):
        p = _payload("Bash", command="curl localhost/api/kanban")
        _, is_guarded = _hook.extract_text(p)
        self.assertFalse(is_guarded)

    def test_write_not_guarded(self):
        p = _payload("Write", file_path="out.txt", content="jovahagyod?")
        _, is_guarded = _hook.extract_text(p)
        self.assertFalse(is_guarded)

    def test_read_not_guarded(self):
        p = _payload("Read", file_path="notes.txt")
        _, is_guarded = _hook.extract_text(p)
        self.assertFalse(is_guarded)

    def test_empty_text_returns_none(self):
        p = _payload(REPLY, chat_id="1", text="")
        text, is_guarded = _hook.extract_text(p)
        self.assertTrue(is_guarded)
        self.assertIsNone(text)

    def test_missing_text_field_returns_none(self):
        p = _payload(REPLY, chat_id="1")
        text, is_guarded = _hook.extract_text(p)
        self.assertTrue(is_guarded)
        self.assertIsNone(text)

    def test_non_dict_payload_returns_not_guarded(self):
        for bad in (None, "string", 42, [], b"bytes"):
            with self.subTest(payload=bad):
                text, is_guarded = _hook.extract_text(bad)
                self.assertFalse(is_guarded)

    def test_non_dict_tool_input_not_guarded(self):
        p = {"tool_name": REPLY, "tool_input": "not-a-dict"}
        text, is_guarded = _hook.extract_text(p)
        self.assertFalse(is_guarded)


# ---------------------------------------------------------------------------
# contains_permission_request: DANGEROUS fixtures (must return True)
# ---------------------------------------------------------------------------
class TestContainsPermissionRequestDangerous(unittest.TestCase):
    """DANGEROUS path: ezek az engedelykero mondatok -> warn KELL (True)."""

    # A kartyaban explicit emlitett mintak
    def test_go_dra_var(self):
        self.assertTrue(_hook.contains_permission_request("A te GO-dra varok ehhez."))

    def test_elesithet(self):
        self.assertTrue(_hook.contains_permission_request("Elesithed ezt a deploymentet?"))

    def test_jovahagyod(self):
        self.assertTrue(_hook.contains_permission_request("Jovahagyod, hogy kuldjuk?"))

    def test_jovahagysz(self):
        self.assertTrue(_hook.contains_permission_request("Jovahagysz engem?"))

    def test_engedelyezed(self):
        self.assertTrue(_hook.contains_permission_request("Engedelyezed ezt a muveletet?"))

    def test_kerdezlek(self):
        self.assertTrue(_hook.contains_permission_request("Kerdezlek: szabad-e?"))

    def test_szabad_e(self):
        self.assertTrue(_hook.contains_permission_request("Szabad-e elkuldeni?"))

    def test_szabad_e_space(self):
        self.assertTrue(_hook.contains_permission_request("Szabad e folytatni?"))

    # Tovabbi valtozatok
    def test_varod_a_go(self):
        self.assertTrue(_hook.contains_permission_request("Varod a GO-t?"))

    def test_megkerlek(self):
        self.assertTrue(_hook.contains_permission_request("Megkerlek, engedeld."))

    def test_beleegyezel(self):
        self.assertTrue(_hook.contains_permission_request("Beleegyezel ebbe?"))

    def test_jovahagyasodra(self):
        self.assertTrue(_hook.contains_permission_request("A jovahagyasodra van szuksegem."))

    # English variants (az agent keveri)
    def test_en_await_approval(self):
        self.assertTrue(_hook.contains_permission_request("Awaiting your approval before I proceed."))

    def test_en_waiting_for_go(self):
        self.assertTrue(_hook.contains_permission_request("Waiting for your go-ahead."))

    def test_en_please_approve(self):
        self.assertTrue(_hook.contains_permission_request("Please approve this deployment."))

    def test_en_should_i_proceed(self):
        self.assertTrue(_hook.contains_permission_request("Should I proceed with the merge?"))

    def test_en_is_it_ok(self):
        self.assertTrue(_hook.contains_permission_request("Is it ok if I deploy now?"))

    def test_en_can_i_go_ahead(self):
        self.assertTrue(_hook.contains_permission_request("Can I go ahead with the release?"))

    def test_en_do_i_have_permission(self):
        self.assertTrue(_hook.contains_permission_request("Do I have your permission to delete?"))


# ---------------------------------------------------------------------------
# contains_permission_request: SAFE fixtures (must return False)
# ---------------------------------------------------------------------------
class TestContainsPermissionRequestSafe(unittest.TestCase):
    """SAFE path: legitim Boss-tajekozatas/dontes-jelentes -> NO warn (False)."""

    def test_reporting_done(self):
        self.assertFalse(_hook.contains_permission_request(
            "Kesz. A deploy sikeres volt, 3 szerviz elindult."
        ))

    def test_reporting_error(self):
        self.assertFalse(_hook.contains_permission_request(
            "Hiba tortent a build soran: exit code 1. Javitom."
        ))

    def test_decision_already_made(self):
        self.assertFalse(_hook.contains_permission_request(
            "Dontottem: a production deployt elhalasztjuk holnapra."
        ))

    def test_status_update(self):
        self.assertFalse(_hook.contains_permission_request(
            "Az egesz pipeline zold, merge folyamatban."
        ))

    def test_asking_for_info_not_permission(self):
        # Informacio-keres != engedelykeres
        self.assertFalse(_hook.contains_permission_request(
            "Melyik branch-et szeretned mergeni?"
        ))

    def test_asking_preference_no_go_wait(self):
        # Preferencia-keres (kivetelezett eset 1) -- de NEM a GO-ra var formaja
        self.assertFalse(_hook.contains_permission_request(
            "Melyik szint preferalod: dark vagy light?"
        ))

    def test_english_reporting_done(self):
        self.assertFalse(_hook.contains_permission_request(
            "Done. The build passed all tests and was deployed."
        ))

    def test_english_informational_question(self):
        self.assertFalse(_hook.contains_permission_request(
            "Which environment do you want to target?"
        ))

    def test_empty_string(self):
        self.assertFalse(_hook.contains_permission_request(""))

    def test_whitespace_only(self):
        self.assertFalse(_hook.contains_permission_request("   "))

    def test_unrelated_text(self):
        self.assertFalse(_hook.contains_permission_request(
            "Az idojaras ma Budapest felett borult, 12 fok."
        ))


# ---------------------------------------------------------------------------
# Fail-open: edge/error inputs must never raise
# ---------------------------------------------------------------------------
class TestFailOpen(unittest.TestCase):

    def test_non_string_text_does_not_raise(self):
        for bad in (None, 42, [], {}, b"bytes"):
            with self.subTest(text=bad):
                try:
                    result = _hook.contains_permission_request(bad)
                    self.assertIsInstance(result, bool)
                except Exception as exc:
                    self.fail(
                        "contains_permission_request raised {} on {!r}: {}".format(
                            type(exc).__name__, bad, exc
                        )
                    )

    def test_blanket_go_active_does_not_raise_on_bad_date(self):
        # Should not raise even with weird input; we can't pass non-date to the
        # real function but the internal try/except handles it
        try:
            _hook.blanket_go_active(today=None)
        except Exception as exc:
            self.fail("blanket_go_active raised {}: {}".format(type(exc).__name__, exc))


# ---------------------------------------------------------------------------
# DATE-GATE: a lejart blanket-GO utan a hook inaktiv kell legyen
# ---------------------------------------------------------------------------
class TestDateGate(unittest.TestCase):

    def test_hook_inactive_after_expiry_reply_tool(self):
        """A lejart (2027-02-01+) datum-gate utan a hook exit 0-t ad, meg ha az
        engedelykero minta megis benne van a szovegben."""
        # Patch blanket_go_active to return False (expired), then run main() with
        # a dangerous payload -> should exit 0, not 2.
        import json

        payload = json.dumps({
            "tool_name": REPLY,
            "tool_input": {"chat_id": "123", "text": "jovahagyod-e a deployt?"}
        })

        # Temporarily patch blanket_go_active
        original = _hook.blanket_go_active

        def _expired(today=None):
            return False  # simulate post-expiry

        _hook.blanket_go_active = _expired
        try:
            with patch("sys.stdin", io.StringIO(payload)):
                try:
                    _hook.main()
                    # If main() returns normally it effectively exited 0
                    exited = 0
                except SystemExit as e:
                    exited = e.code
            self.assertEqual(exited, 0,
                             "Post-expiry: should allow (exit 0) even for permission-asking text")
        finally:
            _hook.blanket_go_active = original

    def test_hook_active_before_expiry_blocks_permission_request(self):
        """Lejarat elott: engedelykero szoveg -> exit 2 (soft-block)."""
        import json

        payload = json.dumps({
            "tool_name": REPLY,
            "tool_input": {"chat_id": "123", "text": "GO-dra varok, elesithed?"}
        })

        original = _hook.blanket_go_active

        def _active(today=None):
            return True  # simulate pre-expiry

        _hook.blanket_go_active = _active
        try:
            with patch("sys.stdin", io.StringIO(payload)):
                try:
                    _hook.main()
                    exited = 0
                except SystemExit as e:
                    exited = e.code
            self.assertEqual(exited, 2,
                             "Pre-expiry: permission-asking text must soft-block (exit 2)")
        finally:
            _hook.blanket_go_active = original

    def test_hook_active_safe_text_allows(self):
        """Lejarat elott: legitim jelentes-szoveg -> exit 0 (allow)."""
        import json

        payload = json.dumps({
            "tool_name": REPLY,
            "tool_input": {"chat_id": "123", "text": "Kesz. A deploy sikeres volt."}
        })

        original = _hook.blanket_go_active

        def _active(today=None):
            return True

        _hook.blanket_go_active = _active
        try:
            with patch("sys.stdin", io.StringIO(payload)):
                try:
                    _hook.main()
                    exited = 0
                except SystemExit as e:
                    exited = e.code
            self.assertEqual(exited, 0,
                             "Safe reporting text must always allow (exit 0)")
        finally:
            _hook.blanket_go_active = original


# ---------------------------------------------------------------------------
# Integration: main() end-to-end with real date (today is in active window)
# ---------------------------------------------------------------------------
class TestMainIntegration(unittest.TestCase):

    def _run_main(self, payload_dict):
        import json
        payload_str = json.dumps(payload_dict)
        with patch("sys.stdin", io.StringIO(payload_str)):
            try:
                _hook.main()
                return 0
            except SystemExit as e:
                return e.code

    def test_non_guarded_tool_always_allows(self):
        p = {"tool_name": "Bash", "tool_input": {"command": "echo GO-dra varok"}}
        self.assertEqual(self._run_main(p), 0)

    def test_malformed_input_allows(self):
        with patch("sys.stdin", io.StringIO("NOT JSON")):
            try:
                _hook.main()
                exited = 0
            except SystemExit as e:
                exited = e.code
        self.assertEqual(exited, 0, "Malformed JSON must fail open (exit 0)")

    def test_empty_input_allows(self):
        with patch("sys.stdin", io.StringIO("")):
            try:
                _hook.main()
                exited = 0
            except SystemExit as e:
                exited = e.code
        self.assertEqual(exited, 0, "Empty input must fail open (exit 0)")

    def test_safe_reporting_text_allows(self):
        p = {
            "tool_name": REPLY,
            "tool_input": {"chat_id": "123", "text": "Kesz. Minden zold."}
        }
        self.assertEqual(self._run_main(p), 0)

    def test_today_is_in_active_window(self):
        # Sanity: today (2026-11-20) is before 2027-02-01
        self.assertTrue(_hook.blanket_go_active())


if __name__ == "__main__":
    unittest.main()
