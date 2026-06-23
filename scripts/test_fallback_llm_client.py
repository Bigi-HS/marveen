#!/usr/bin/env python3
"""Unit tests for the Layer-2 fallback LLM client (card 92f07145).

No pytest in the fleet env -> plain unittest. The cloud completion call and the
Telegram sender are injected, so the suite is network- and SDK-free (mirrors the
Layer-1 test approach). Run: python3 scripts/test_fallback_llm_client.py
"""
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("fallback_llm_client", os.path.join(_HERE, "fallback_llm_client.py"))
fl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fl)


# --------------------------------------------------------------------------- #
# Pure helpers: providers, routing, keys
# --------------------------------------------------------------------------- #
class TestLoadProviders(unittest.TestCase):
    YAML = """
max_calls_per_outage: 7
providers:
  - name: groq-fast
    base_url: "https://api.groq.com/openai/v1"
    model: m1
    api_key_env: GROQ_API_KEY
    sensitive_ok: true
  - name: rogue
    base_url: "https://evil.example.com/v1"
    model: m2
    api_key_env: ROGUE_KEY
    sensitive_ok: true
  - name: gemini
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai/"
    model: m3
    api_key_env: GEMINI_API_KEY
    sensitive_ok: false
"""

    def test_drops_non_allowlisted_base_url(self):
        providers, max_calls, dropped = fl.load_providers(self.YAML)
        names = [p["name"] for p in providers]
        self.assertEqual(names, ["groq-fast", "gemini"])  # rogue dropped (AC-7)
        self.assertEqual(dropped, ["rogue"])
        self.assertEqual(max_calls, 7)

    def test_malformed_yaml_is_empty(self):
        providers, max_calls, dropped = fl.load_providers("::: not yaml :::\n  - [")
        self.assertEqual(providers, [])
        self.assertEqual(max_calls, fl.DEFAULT_MAX_CALLS_PER_OUTAGE)

    def test_bad_max_calls_falls_back_to_default(self):
        _, max_calls, _ = fl.load_providers('max_calls_per_outage: -5\nproviders: []')
        self.assertEqual(max_calls, fl.DEFAULT_MAX_CALLS_PER_OUTAGE)


class TestSelectProviders(unittest.TestCase):
    def setUp(self):
        self.providers = [
            {"name": "groq", "sensitive_ok": True, "base_url": "", "model": "", "api_key_env": ""},
            {"name": "gemini", "sensitive_ok": False, "base_url": "", "model": "", "api_key_env": ""},
        ]

    def test_high_is_groq_only(self):
        self.assertEqual([p["name"] for p in fl.select_providers(self.providers, "high")], ["groq"])

    def test_medium_is_groq_only(self):  # F1 Option B
        self.assertEqual([p["name"] for p in fl.select_providers(self.providers, "medium")], ["groq"])

    def test_low_allows_gemini_in_order(self):
        self.assertEqual([p["name"] for p in fl.select_providers(self.providers, "low")], ["groq", "gemini"])


class TestResolveApiKey(unittest.TestCase):
    def test_present(self):
        os.environ["TEST_FL_KEY"] = "secret-value"
        try:
            self.assertEqual(fl.resolve_api_key({"api_key_env": "TEST_FL_KEY"}), "secret-value")
        finally:
            del os.environ["TEST_FL_KEY"]

    def test_absent_returns_none(self):
        os.environ.pop("TEST_FL_ABSENT", None)
        self.assertIsNone(fl.resolve_api_key({"api_key_env": "TEST_FL_ABSENT"}))

    def test_empty_name_returns_none(self):
        self.assertIsNone(fl.resolve_api_key({"api_key_env": ""}))


# --------------------------------------------------------------------------- #
# Sensitivity classification (AC-2 / 5.5)
# --------------------------------------------------------------------------- #
class TestClassifySensitivity(unittest.TestCase):
    def test_absent_defaults_high(self):
        self.assertEqual(fl.classify_sensitivity(None, "reminder_parse", "x"), "high")

    def test_invalid_defaults_high(self):
        self.assertEqual(fl.classify_sensitivity("banana", "reminder_parse", "x"), "high")

    def test_valid_passthrough(self):
        self.assertEqual(fl.classify_sensitivity("low", "reminder_parse", "x"), "low")

    def test_coaching_health_keyword_forces_high_hu(self):
        self.assertEqual(fl.classify_sensitivity("low", "coaching_reply", "fáj a vércukrom ma"), "high")

    def test_coaching_finance_keyword_forces_high_en(self):
        self.assertEqual(fl.classify_sensitivity("low", "coaching_reply", "my bank invoice is late"), "high")

    def test_coaching_neutral_keeps_low(self):
        self.assertEqual(fl.classify_sensitivity("low", "coaching_reply", "feeling tired today"), "low")

    def test_health_keyword_only_reclassifies_coaching(self):
        # A non-coaching task is not reclassified by the keyword guard.
        self.assertEqual(fl.classify_sensitivity("low", "reminder_parse", "orvos 2026-01-01"), "low")


# --------------------------------------------------------------------------- #
# Redaction (AC-5)
# --------------------------------------------------------------------------- #
class TestRedaction(unittest.TestCase):
    def test_redacts_name_weight_date(self):
        text = "Dominik 82.5 kg on 2026-06-23"
        red, mapping = fl.redact(text)
        self.assertNotIn("Dominik", red)
        self.assertNotIn("82.5 kg", red)
        self.assertNotIn("2026-06-23", red)
        self.assertIn("[P1]", red)
        self.assertIn("[W1]", red)
        self.assertIn("[D1]", red)
        # round-trip restores the original exactly
        self.assertEqual(fl.restore(red, mapping), text)

    def test_empty_map_when_no_entities(self):
        red, mapping = fl.redact("the meeting is soon")
        self.assertEqual(mapping, {})
        self.assertEqual(red, "the meeting is soon")

    def test_restore_drops_unknown_placeholder(self):
        # A placeholder the model invented that is not in the map is dropped.
        self.assertEqual(fl.restore("hello [P9] world", {}), "hello  world")

    def test_restore_keeps_known_drops_unknown(self):
        red, mapping = fl.redact("Anna")
        ph = next(iter(mapping))
        self.assertEqual(fl.restore(ph + " and [P9]", mapping), "Anna and ")


# --------------------------------------------------------------------------- #
# Response validation (AC-8)
# --------------------------------------------------------------------------- #
class TestValidation(unittest.TestCase):
    def test_kanban_valid(self):
        card = fl.validate_kanban_card({"title": "Fix x", "description": "d", "priority": "high", "assignee": "dave"})
        self.assertEqual(card["title"], "Fix x")
        self.assertEqual(card["priority"], "high")

    def test_kanban_missing_title_raises(self):
        with self.assertRaises(ValueError):
            fl.validate_kanban_card({"description": "d"})

    def test_kanban_bad_priority_defaults_normal(self):
        card = fl.validate_kanban_card({"title": "t", "description": "", "priority": "ASAP", "assignee": ""})
        self.assertEqual(card["priority"], "normal")

    def test_reminder_valid(self):
        rem = fl.validate_reminder({"datetime_iso": "2026-06-23T10:00", "message": "call mom"})
        self.assertEqual(rem["message"], "call mom")

    def test_reminder_missing_field_raises(self):
        with self.assertRaises(ValueError):
            fl.validate_reminder({"datetime_iso": "2026-06-23T10:00"})


# --------------------------------------------------------------------------- #
# Task input extraction
# --------------------------------------------------------------------------- #
class TestExtractInput(unittest.TestCase):
    def test_prefers_section(self):
        md = "---\nname: x\n---\n# Title\n## Layer-2 Input\nparse this please\n## Other\nignore"
        self.assertEqual(fl.extract_task_input(md), "parse this please")

    def test_strips_frontmatter_when_no_section(self):
        md = "---\nname: x\nschedule: '0 9 * * *'\n---\nthe actual body text"
        self.assertEqual(fl.extract_task_input(md), "the actual body text")

    def test_empty(self):
        self.assertEqual(fl.extract_task_input("---\nonly: frontmatter\n---\n"), "")


# --------------------------------------------------------------------------- #
# DB: log table + budget (AC-9) + no-key-column (AC-6/I3)
# --------------------------------------------------------------------------- #
class TestLogAndBudget(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")

    def _rows(self):
        con = sqlite3.connect(self.db)
        try:
            return con.execute("SELECT task_name, provider, status, reason, outage_started_at FROM layer2_call_log").fetchall()
        finally:
            con.close()

    def test_log_row_creates_table_and_inserts(self):
        ok = fl.log_row(self.db, task_name="t", agent="dave", provider="groq", model="m",
                        task_type="reminder_parse", status="sent", reason=None, warning=None,
                        outage_started_at=111, logged_at=222)
        self.assertTrue(ok)
        self.assertEqual(len(self._rows()), 1)

    def test_log_table_has_no_key_or_prompt_column(self):
        fl.log_row(self.db, task_name="t", status="sent", logged_at=1)
        con = sqlite3.connect(self.db)
        try:
            cols = {r[1].lower() for r in con.execute("PRAGMA table_info(layer2_call_log)")}
        finally:
            con.close()
        for forbidden in ("api_key", "key", "prompt", "input", "groq_api_key", "gemini_api_key"):
            self.assertNotIn(forbidden, cols)

    def test_budget_counts_only_real_calls(self):
        # provider-null skip + a sent + an error in window 100; a sent in window 200.
        fl.log_row(self.db, task_name="t", provider=None, status="skipped", outage_started_at=100, logged_at=1)
        fl.log_row(self.db, task_name="t", provider="groq", status="sent", outage_started_at=100, logged_at=1)
        fl.log_row(self.db, task_name="t", provider="groq", status="error", outage_started_at=100, logged_at=1)
        fl.log_row(self.db, task_name="t", provider="groq", status="sent", outage_started_at=200, logged_at=1)
        self.assertEqual(fl.count_budget(self.db, 100), 2)
        self.assertEqual(fl.count_budget(self.db, 200), 1)


# --------------------------------------------------------------------------- #
# main() end-to-end (DI: completion + sender + token + id + now)
# --------------------------------------------------------------------------- #
class TestMainE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "claudeclaw.db")
        # The script assumes the core kanban_cards table already exists (it never
        # creates it, to avoid schema drift); mirror the real schema here.
        _con = sqlite3.connect(self.db)
        _con.execute(
            "CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, "
            "status TEXT NOT NULL DEFAULT 'planned', assignee TEXT, "
            "priority TEXT NOT NULL DEFAULT 'normal', project TEXT, parent_id TEXT, due_date INTEGER, "
            "sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, "
            "archived_at INTEGER, dispatched_at INTEGER)"
        )
        _con.commit()
        _con.close()
        self.task_dir = os.path.join(self.tmp, "mytask-0900")
        os.makedirs(self.task_dir)
        self.providers_yaml = os.path.join(self.tmp, "providers.yaml")
        with open(self.providers_yaml, "w") as f:
            f.write(
                "max_calls_per_outage: 3\n"
                "providers:\n"
                "  - name: groq-fast\n"
                '    base_url: "https://api.groq.com/openai/v1"\n'
                "    model: llama\n"
                "    api_key_env: TEST_GROQ\n"
                "    sensitive_ok: true\n"
                "  - name: gemini\n"
                '    base_url: "https://generativelanguage.googleapis.com/v1beta/openai/"\n'
                "    model: gem\n"
                "    api_key_env: TEST_GEMINI\n"
                "    sensitive_ok: false\n"
            )
        self.state = os.path.join(self.tmp, "state.json")
        self._write_state(True, 555)
        self.env_file = os.path.join(self.tmp, ".env")
        with open(self.env_file, "w") as f:
            f.write("TELEGRAM_BOT_TOKEN=123:abc\n")
        os.environ["TEST_GROQ"] = "gk"
        os.environ.pop("TEST_GEMINI", None)
        self.sent = []

    def tearDown(self):
        os.environ.pop("TEST_GROQ", None)
        os.environ.pop("TEST_GEMINI", None)

    def _write_state(self, limited, started):
        with open(self.state, "w") as f:
            json.dump({"limited": limited, "enteredAtMs": started}, f)

    def _write_task(self, task_type, body, sensitivity=None, extra=None):
        cfg = {"agent": "dave", "layer2": True, "layer2_task_type": task_type}
        if sensitivity is not None:
            cfg["sensitivity"] = sensitivity
        if extra:
            cfg.update(extra)
        with open(os.path.join(self.task_dir, "task-config.json"), "w") as f:
            json.dump(cfg, f)
        with open(os.path.join(self.task_dir, "SKILL.md"), "w") as f:
            f.write("---\nname: x\n---\n## Layer-2 Input\n" + body + "\n")

    def _argv(self):
        return ["--task-dir", self.task_dir, "--providers-yaml", self.providers_yaml,
                "--db-path", self.db, "--state-file", self.state, "--env-file", self.env_file]

    def _fake_sender(self, code=200):
        def send(token, chat_id, text):
            self.sent.append((token, chat_id, text))
            return code
        return send

    def _rows(self):
        con = sqlite3.connect(self.db)
        try:
            return con.execute(
                "SELECT status, reason, provider, warning, task_type, outage_started_at FROM layer2_call_log ORDER BY id"
            ).fetchall()
        finally:
            con.close()

    # ----- routing / guards ------------------------------------------------ #
    def test_not_limited_skips(self):
        self._write_state(False, 555)
        self._write_task("reminder_parse", "tomorrow 9am dentist")
        rc = fl.main(self._argv(), completion=lambda *a: "x", sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:2], ("skipped", "not_limited"))

    def test_unknown_task_type_rejected_no_api(self):
        self._write_task("translate_text", "hello")
        called = []
        rc = fl.main(self._argv(), completion=lambda *a: called.append(1) or "x",
                     sender=self._fake_sender(), token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:2], ("error", "unknown_task_type"))
        self.assertEqual(called, [])  # no completion call
        self.assertEqual(fl.count_budget(self.db, 555), 0)  # F8: does not count

    def test_missing_outage_ts_skips_before_api(self):  # S1
        self._write_state(True, None)
        self._write_task("reminder_parse", "x", sensitivity="low")
        called = []
        rc = fl.main(self._argv(), completion=lambda *a: called.append(1) or "x",
                     sender=self._fake_sender(), token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:2], ("skipped", "missing_outage_ts"))
        self.assertEqual(called, [])

    def test_provider_config_missing(self):  # M1
        with open(self.providers_yaml, "w") as f:
            f.write("max_calls_per_outage: 3\nproviders: []\n")
        self._write_task("reminder_parse", "x", sensitivity="low")
        rc = fl.main(self._argv(), completion=lambda *a: "x", sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:2], ("skipped", "provider_config_missing"))

    def test_all_providers_url_dropped_yields_url_not_allowed(self):  # M1 / S2
        with open(self.providers_yaml, "w") as f:
            f.write('providers:\n  - name: rogue\n    base_url: "https://evil.example.com/v1"\n'
                    "    model: m\n    api_key_env: X\n    sensitive_ok: true\n")
        self._write_task("reminder_parse", "x", sensitivity="low")
        rc = fl.main(self._argv(), completion=lambda *a: "x", sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:2], ("skipped", "url_not_allowed"))

    def test_no_input_skips(self):
        with open(os.path.join(self.task_dir, "task-config.json"), "w") as f:
            json.dump({"agent": "dave", "layer2": True, "layer2_task_type": "reminder_parse"}, f)
        with open(os.path.join(self.task_dir, "SKILL.md"), "w") as f:
            f.write("---\nname: x\n---\n")
        rc = fl.main(self._argv(), completion=lambda *a: "x", sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:2], ("skipped", "no_input"))

    # ----- reminder_parse -------------------------------------------------- #
    def test_reminder_sent_with_fallback_label(self):
        self._write_task("reminder_parse", "dentist tomorrow", sensitivity="low")
        raw = json.dumps({"datetime_iso": "2026-06-24T09:00", "message": "dentist"})
        rc = fl.main(self._argv(), completion=lambda *a: raw, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 0)
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(self.sent[0][2].startswith(fl.FALLBACK_MSG_PREFIX))  # AC-10
        self.assertIn("dentist", self.sent[0][2])
        self.assertEqual(self._rows()[0][0], "sent")

    def test_reminder_schema_mismatch(self):
        self._write_task("reminder_parse", "dentist tomorrow", sensitivity="low")
        rc = fl.main(self._argv(), completion=lambda *a: json.dumps({"message": "no datetime"}),
                     sender=self._fake_sender(), token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:3], ("error", "schema_mismatch", "groq-fast"))
        self.assertEqual(fl.count_budget(self.db, 555), 1)  # error w/ provider counts

    def test_reminder_invalid_json(self):
        self._write_task("reminder_parse", "dentist tomorrow", sensitivity="low")
        rc = fl.main(self._argv(), completion=lambda *a: "not json at all",
                     sender=self._fake_sender(), token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:2], ("error", "invalid_response"))

    def test_reminder_telegram_network_is_transient(self):
        self._write_task("reminder_parse", "dentist tomorrow", sensitivity="low")
        raw = json.dumps({"datetime_iso": "2026-06-24T09:00", "message": "dentist"})
        rc = fl.main(self._argv(), completion=lambda *a: raw, sender=self._fake_sender(code=-1),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 2)
        self.assertEqual(self._rows()[0][:2], ("error", "telegram_network"))

    # ----- kanban_card_from_text ------------------------------------------ #
    def test_kanban_card_created_with_label(self):
        self._write_task("kanban_card_from_text", "remember to renew the domain", sensitivity="low")
        raw = json.dumps({"title": "Renew domain", "description": "before it expires",
                          "priority": "high", "assignee": "dave"})
        rc = fl.main(self._argv(), completion=lambda *a: raw, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=42, id_factory=lambda: "deadbeef")
        self.assertEqual(rc, 0)
        con = sqlite3.connect(self.db)
        try:
            row = con.execute("SELECT id, title, description, status, priority FROM kanban_cards WHERE id='deadbeef'").fetchone()
        finally:
            con.close()
        self.assertIsNotNone(row)
        self.assertEqual(row[1], "Renew domain")
        self.assertTrue(row[2].startswith(fl.FALLBACK_CARD_PREFIX))  # AC-10
        self.assertEqual(row[3], "planned")
        self.assertEqual(self._rows()[0][0], "sent")

    def test_kanban_invalid_response(self):
        self._write_task("kanban_card_from_text", "x", sensitivity="low")
        rc = fl.main(self._argv(), completion=lambda *a: "garbage", sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][1], "invalid_response")

    # ----- coaching_reply -------------------------------------------------- #
    def test_coaching_sent_and_labelled(self):
        self._write_task("coaching_reply", "I am stressed about work", sensitivity="low")
        rc = fl.main(self._argv(), completion=lambda *a: "Take a short walk, you've got this.",
                     sender=self._fake_sender(), token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 0)
        self.assertTrue(self.sent[0][2].startswith(fl.FALLBACK_MSG_PREFIX))

    def test_coaching_truncated(self):
        self._write_task("coaching_reply", "talk to me", sensitivity="low")
        long = "a" * 600
        rc = fl.main(self._argv(), completion=lambda *a: long, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 0)
        body = self.sent[0][2][len(fl.FALLBACK_MSG_PREFIX):]
        self.assertEqual(len(body), fl.COACHING_MAX_CHARS)
        self.assertEqual(self._rows()[0][3], "truncated")  # warning column

    # ----- provider selection / availability ------------------------------ #
    def test_high_sensitivity_never_uses_gemini(self):
        # GROQ key absent, only Gemini key present, high sensitivity -> skip, no Gemini.
        os.environ.pop("TEST_GROQ", None)
        os.environ["TEST_GEMINI"] = "gem-key"
        self._write_task("reminder_parse", "secret thing", sensitivity="high")
        providers_used = []
        def comp(base_url, key, model, msgs, tools):
            providers_used.append(base_url)
            return json.dumps({"datetime_iso": "x", "message": "y"})
        rc = fl.main(self._argv(), completion=comp, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(providers_used, [])  # Gemini never called for high
        self.assertEqual(self._rows()[0][:2], ("skipped", "no_api_key"))

    def test_low_falls_back_to_gemini(self):
        os.environ.pop("TEST_GROQ", None)  # groq unusable (no key)
        os.environ["TEST_GEMINI"] = "gem-key"
        self._write_task("reminder_parse", "public thing", sensitivity="low")
        used = []
        def comp(base_url, key, model, msgs, tools):
            used.append(base_url)
            return json.dumps({"datetime_iso": "x", "message": "y"})
        rc = fl.main(self._argv(), completion=comp, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 0)
        self.assertEqual(used, ["https://generativelanguage.googleapis.com/v1beta/openai/"])
        self.assertEqual(self._rows()[0][2], "gemini")

    def test_all_rate_limited(self):
        self._write_task("reminder_parse", "x", sensitivity="high")
        def comp(*a):
            raise fl.ProviderRateLimited("429")
        rc = fl.main(self._argv(), completion=comp, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:2], ("skipped", "all_providers_rate_limited"))

    def test_provider_unavailable_skips(self):
        self._write_task("reminder_parse", "x", sensitivity="high")
        def comp(*a):
            raise fl.ProviderUnavailable("boom")
        rc = fl.main(self._argv(), completion=comp, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[0][:2], ("skipped", "groq_unavailable"))

    # ----- budget exhaustion N-1 / N / N+1 (AC-9) ------------------------- #
    def test_budget_boundary(self):
        # max_calls=3. Pre-seed the log; assert behaviour at 2, 3, 4 existing calls.
        self._write_task("reminder_parse", "x", sensitivity="low")
        raw = json.dumps({"datetime_iso": "d", "message": "m"})

        def seed(n):
            con = sqlite3.connect(self.db)
            fl.ensure_log_table(con)
            con.executemany(
                "INSERT INTO layer2_call_log (task_name, provider, status, outage_started_at, logged_at) VALUES (?,?,?,?,?)",
                [("old", "groq", "sent", 555, 1)] * n,
            )
            con.commit()
            con.close()

        # N-1 = 2 existing -> still allowed (fires)
        seed(2)
        rc = fl.main(self._argv(), completion=lambda *a: raw, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 0)
        # now 3 existing (== max) -> exhausted
        rc = fl.main(self._argv(), completion=lambda *a: raw, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 1)
        self.assertEqual(self._rows()[-1][:2], ("skipped", "budget_exhausted"))

    # ----- redaction round-trip through main (high sensitivity) ----------- #
    def test_high_sensitivity_redacts_before_send_and_restores(self):
        self._write_task("reminder_parse", "Dominik dentist on 2026-06-24", sensitivity="high")
        seen = {}
        def comp(base_url, key, model, msgs, tools):
            seen["user"] = msgs[-1]["content"]
            # echo a placeholder back inside the message to prove restore runs
            return json.dumps({"datetime_iso": "2026-06-24T09:00", "message": "remind [P1]"})
        rc = fl.main(self._argv(), completion=comp, sender=self._fake_sender(),
                     token_loader=lambda t: "tok", now=1)
        self.assertEqual(rc, 0)
        # The name + date were redacted in the outgoing prompt...
        self.assertNotIn("Dominik", seen["user"])
        self.assertNotIn("2026-06-24", seen["user"])
        # ...and restored in the delivered message.
        self.assertIn("Dominik", self.sent[0][2])


# --------------------------------------------------------------------------- #
# Stdlib HTTP completion (Thor B1: no openai SDK, urllib only)
# --------------------------------------------------------------------------- #
class _FakeResp:
    def __init__(self, body):
        self._body = body.encode("utf-8")
    def read(self):
        return self._body
    def close(self):
        pass


class TestHttpCompletion(unittest.TestCase):
    def test_no_openai_dependency(self):
        # The module must import and run its real completion without openai.
        import sys as _sys
        self.assertNotIn("openai", _sys.modules)
        self.assertTrue(callable(fl._http_completion))

    def test_builds_request_and_returns_content(self):
        captured = {}
        def opener(req, timeout=None):
            captured["url"] = req.full_url
            captured["auth"] = req.headers.get("Authorization")
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _FakeResp(json.dumps({"choices": [{"message": {"content": "hi there"}}]}))
        out = fl._http_completion("https://api.groq.com/openai/v1", "secret-key", "llama",
                                  [{"role": "user", "content": "x"}], None, opener=opener)
        self.assertEqual(out, "hi there")
        self.assertEqual(captured["url"], "https://api.groq.com/openai/v1/chat/completions")
        self.assertEqual(captured["auth"], "Bearer secret-key")
        self.assertEqual(captured["body"]["model"], "llama")
        self.assertNotIn("tools", captured["body"])

    def test_tool_call_returns_arguments(self):
        args_json = json.dumps({"title": "t", "description": "d", "priority": "normal", "assignee": ""})
        def opener(req, timeout=None):
            self.assertEqual(json.loads(req.data.decode())["tool_choice"], "required")
            return _FakeResp(json.dumps({"choices": [{"message": {
                "tool_calls": [{"function": {"name": "create_kanban_card", "arguments": args_json}}]}}]}))
        out = fl._http_completion("https://api.groq.com/openai/v1", "k", "m",
                                  [{"role": "user", "content": "x"}], [fl._KANBAN_TOOL], opener=opener)
        self.assertEqual(json.loads(out)["title"], "t")

    def test_429_maps_to_rate_limited(self):
        import urllib.error
        def opener(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many", {}, None)
        with self.assertRaises(fl.ProviderRateLimited):
            fl._http_completion("https://api.groq.com/openai/v1", "k", "m", [], None, opener=opener)

    def test_500_maps_to_unavailable(self):
        import urllib.error
        def opener(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 500, "Server", {}, None)
        with self.assertRaises(fl.ProviderUnavailable):
            fl._http_completion("https://api.groq.com/openai/v1", "k", "m", [], None, opener=opener)

    def test_network_error_maps_to_unavailable(self):
        import urllib.error
        def opener(req, timeout=None):
            raise urllib.error.URLError("connection refused")
        with self.assertRaises(fl.ProviderUnavailable):
            fl._http_completion("https://api.groq.com/openai/v1", "k", "m", [], None, opener=opener)

    def test_malformed_response_maps_to_unavailable(self):
        def opener(req, timeout=None):
            return _FakeResp("not json")
        with self.assertRaises(fl.ProviderUnavailable):
            fl._http_completion("https://api.groq.com/openai/v1", "k", "m", [], None, opener=opener)

    def test_gemini_trailing_slash_base_url(self):
        captured = {}
        def opener(req, timeout=None):
            captured["url"] = req.full_url
            return _FakeResp(json.dumps({"choices": [{"message": {"content": "ok"}}]}))
        fl._http_completion("https://generativelanguage.googleapis.com/v1beta/openai/", "k", "m",
                            [], None, opener=opener)
        self.assertEqual(captured["url"],
                         "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")


# --------------------------------------------------------------------------- #
# Layer-1 send-path reuse (OQ-1)
# --------------------------------------------------------------------------- #
class TestDirectSendReuse(unittest.TestCase):
    def test_loads_layer1_sender_and_token_loader(self):
        mod = fl._direct_send()
        self.assertTrue(callable(mod.telegram_send))
        self.assertTrue(callable(mod.load_token))


if __name__ == "__main__":
    unittest.main(verbosity=2)
