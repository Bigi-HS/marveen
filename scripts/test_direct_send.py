#!/usr/bin/env python3
"""Unit tests for scripts/direct-send.py (card 92f07145, model-free Layer 1).

Pure: no network (sender is injected), no real Telegram, fixed clock. Each AC of
store/spec-direct-send-layer.md is exercised. The DB is a throwaway temp file so
direct_send_log / kanban_cards writes are verified for real.

Run: python3 -m pytest scripts/test_direct_send.py
 or: python3 scripts/test_direct_send.py   (unittest runner)
"""
import importlib.util
import os
import sqlite3
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, "direct-send.py")
_spec = importlib.util.spec_from_file_location("direct_send", _MOD_PATH)
ds = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ds)

NOW = 1_780_000_000


# --- A recording sender so tests assert what would have gone to Telegram ---
class FakeSender:
    def __init__(self, status=200):
        self.status = status
        self.calls = []

    def __call__(self, token, chat_id, text):
        self.calls.append({"token": token, "chat_id": chat_id, "text": text})
        return self.status


def _write(path, content):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def make_task(tmp, *, template="Csomagautomatahoz menni!", config_extra=None, with_skill=True):
    """Create a scheduled-task dir with SKILL.md (+ ## Direct Message) and config."""
    task_dir = os.path.join(tmp, "csomagautomata-2200")
    os.makedirs(task_dir, exist_ok=True)
    if with_skill:
        skill = "---\nname: csomagautomata-2200\ndescription: t\n---\n\nbody prompt for the normal path\n"
        if template is not None:
            skill += "\n## Direct Message\n{}\n".format(template)
        _write(os.path.join(task_dir, "SKILL.md"), skill)
    config = {"agent": "claudia", "schedule": "0 22 * * *", "enabled": True}
    if config_extra:
        config.update(config_extra)
    import json
    _write(os.path.join(task_dir, "task-config.json"), json.dumps(config))
    return task_dir


def fetch_log(db_path):
    con = sqlite3.connect(db_path)
    try:
        rows = con.execute(
            "SELECT task_name, agent, status, reason, warning, logged_at FROM direct_send_log ORDER BY id"
        ).fetchall()
    finally:
        con.close()
    return [
        {"task_name": r[0], "agent": r[1], "status": r[2], "reason": r[3], "warning": r[4], "logged_at": r[5]}
        for r in rows
    ]


# --- AC-2 / 4.2 / M7: template extraction ---
class ExtractTemplateTests(unittest.TestCase):
    def test_present(self):
        skill = "---\nname: x\n---\n\nbody\n\n## Direct Message\nHello there\n"
        self.assertEqual(ds.extract_direct_message(skill), "Hello there")

    def test_absent_section_returns_none(self):
        self.assertIsNone(ds.extract_direct_message("---\nname: x\n---\n\njust a body\n"))

    def test_empty_section_returns_none(self):
        self.assertIsNone(ds.extract_direct_message("## Direct Message\n   \n\n"))

    def test_stops_at_next_heading_M7(self):
        skill = "## Direct Message\nLine one\nLine two\n## Other Section\nNOT part of message\n"
        self.assertEqual(ds.extract_direct_message(skill), "Line one\nLine two")

    def test_strips_surrounding_whitespace(self):
        self.assertEqual(ds.extract_direct_message("## Direct Message\n\n  padded  \n\n"), "padded")

    def test_multiline_body_preserved(self):
        skill = "## Direct Message\nfirst\nsecond\n"
        self.assertEqual(ds.extract_direct_message(skill), "first\nsecond")


# --- AC-4 / M1: token loading by pointer ---
class LoadTokenTests(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(ds.load_token("TELEGRAM_BOT_TOKEN=123:abc\nOTHER=x\n"), "123:abc")

    def test_double_quoted(self):
        self.assertEqual(ds.load_token('TELEGRAM_BOT_TOKEN="123:abc"\n'), "123:abc")

    def test_single_quoted(self):
        self.assertEqual(ds.load_token("TELEGRAM_BOT_TOKEN='123:abc'\n"), "123:abc")

    def test_spaces_around_equals(self):
        self.assertEqual(ds.load_token("TELEGRAM_BOT_TOKEN = 123:abc\n"), "123:abc")

    def test_absent_returns_none(self):
        self.assertIsNone(ds.load_token("SOMETHING_ELSE=1\n"))

    def test_empty_value_returns_none(self):
        self.assertIsNone(ds.load_token("TELEGRAM_BOT_TOKEN=\n"))


# --- AC-3: chat_id whitelist constant ---
class ChatIdWhitelistTests(unittest.TestCase):
    def test_default_is_whitelisted(self):
        self.assertIn(ds.DEFAULT_CHAT_ID, ds.KNOWN_CHAT_IDS)

    def test_known_set_value(self):
        self.assertEqual(ds.KNOWN_CHAT_IDS, {"8643929442"})


# --- AC-3: telegram_send status mapping (injected opener, no network) ---
class TelegramSendTests(unittest.TestCase):
    def test_200_on_success(self):
        class Resp:
            def getcode(self):
                return 200
            def close(self):
                pass
        self.assertEqual(ds.telegram_send("tok", "8643929442", "hi", opener=lambda req, timeout=0: Resp()), 200)

    def test_network_error_returns_minus_one(self):
        import urllib.error
        def boom(req, timeout=0):
            raise urllib.error.URLError("down")
        self.assertEqual(ds.telegram_send("tok", "8643929442", "hi", opener=boom), -1)

    def test_http_error_propagates_code(self):
        import urllib.error
        def boom(req, timeout=0):
            raise urllib.error.HTTPError("u", 500, "err", {}, None)
        self.assertEqual(ds.telegram_send("tok", "8643929442", "hi", opener=boom), 500)

    def test_token_in_url_not_in_return(self):
        # Defense for M1: the function must never return the token.
        class Resp:
            def getcode(self):
                return 200
            def close(self):
                pass
        out = ds.telegram_send("SECRET", "8643929442", "hi", opener=lambda req, timeout=0: Resp())
        self.assertNotIn("SECRET", str(out))


# --- AC-1..AC-10: end-to-end main() with temp dirs + fake sender ---
class MainEndToEndTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "claudeclaw.db")
        self.env = os.path.join(self.tmp, ".env")
        _write(self.env, "TELEGRAM_BOT_TOKEN=999:secret\n")

    def _args(self, task_dir, chat_id=None):
        a = ["--task-dir", task_dir, "--env-file", self.env, "--db-path", self.db]
        if chat_id is not None:
            a += ["--chat-id", chat_id]
        return a

    def test_happy_path_sends_verbatim_and_exits_0(self):
        task = make_task(self.tmp, template="Csomagautomatahoz menni!")
        sender = FakeSender(200)
        code = ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(code, 0)
        self.assertEqual(len(sender.calls), 1)
        self.assertEqual(sender.calls[0]["text"], "Csomagautomatahoz menni!")
        self.assertEqual(sender.calls[0]["chat_id"], "8643929442")
        self.assertEqual(sender.calls[0]["token"], "999:secret")
        rows = fetch_log(self.db)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "sent")
        self.assertIsNone(rows[0]["reason"])
        self.assertIsNone(rows[0]["warning"])
        self.assertEqual(rows[0]["agent"], "claudia")
        self.assertEqual(rows[0]["task_name"], "csomagautomata-2200")
        self.assertEqual(rows[0]["logged_at"], NOW)

    def test_no_template_skipped_exit_1_no_send(self):
        task = make_task(self.tmp, template=None)  # SKILL.md without the section
        sender = FakeSender(200)
        code = ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(code, 1)
        self.assertEqual(sender.calls, [])
        rows = fetch_log(self.db)
        self.assertEqual(rows[0]["status"], "skipped")
        self.assertEqual(rows[0]["reason"], "no_template")

    def test_no_token_error_exit_1_no_send(self):
        _write(self.env, "NOTHING_HERE=1\n")
        task = make_task(self.tmp)
        sender = FakeSender(200)
        code = ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(code, 1)
        self.assertEqual(sender.calls, [])
        self.assertEqual(fetch_log(self.db)[0]["reason"], "no_token")

    def test_missing_env_file_error_exit_1(self):
        task = make_task(self.tmp)
        sender = FakeSender(200)
        code = ds.main(["--task-dir", task, "--env-file", "/no/such/.env", "--db-path", self.db],
                       sender=sender, now=NOW)
        self.assertEqual(code, 1)
        self.assertEqual(fetch_log(self.db)[0]["reason"], "no_token")

    def test_invalid_chat_id_exit_1_no_send(self):
        task = make_task(self.tmp, config_extra={"chatId": "111"})
        sender = FakeSender(200)
        code = ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(code, 1)
        self.assertEqual(sender.calls, [])
        self.assertEqual(fetch_log(self.db)[0]["reason"], "invalid_chat_id")

    def test_config_chat_id_when_whitelisted(self):
        task = make_task(self.tmp, config_extra={"chatId": "8643929442"})
        sender = FakeSender(200)
        code = ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(code, 0)
        self.assertEqual(sender.calls[0]["chat_id"], "8643929442")

    def test_telegram_non_200_exit_2(self):
        task = make_task(self.tmp)
        sender = FakeSender(500)
        code = ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(code, 2)
        self.assertEqual(fetch_log(self.db)[0]["reason"], "telegram_500")

    def test_telegram_network_error_exit_2(self):
        task = make_task(self.tmp)
        sender = FakeSender(-1)
        code = ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(code, 2)
        self.assertEqual(fetch_log(self.db)[0]["reason"], "telegram_network")

    def test_no_card_update_on_send_failure(self):
        # AC-6 edge: a failed send must NOT touch the card.
        self._seed_card("be1f0001", "planned")
        task = make_task(self.tmp, config_extra={"cardId": "be1f0001"})
        sender = FakeSender(500)
        ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(self._card_status("be1f0001"), "planned")

    def test_card_update_found_sets_done(self):
        self._seed_card("be1f1234", "in_progress")
        task = make_task(self.tmp, config_extra={"cardId": "be1f1234"})
        sender = FakeSender(200)
        code = ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(code, 0)
        self.assertEqual(self._card_status("be1f1234"), "done")
        row = fetch_log(self.db)[0]
        self.assertEqual(row["status"], "sent")
        self.assertIsNone(row["warning"])

    def test_card_not_found_warning_reason_null_still_exit_0(self):
        # No kanban_cards table at all -> update_card sees a missing card path.
        self._seed_card("other", "planned")  # table exists, target id absent
        task = make_task(self.tmp, config_extra={"cardId": "ghost9999"})
        sender = FakeSender(200)
        code = ds.main(self._args(task), sender=sender, now=NOW)
        self.assertEqual(code, 0)
        row = fetch_log(self.db)[0]
        self.assertEqual(row["status"], "sent")
        self.assertIsNone(row["reason"])
        self.assertEqual(row["warning"], "card_not_found:ghost9999")

    def test_db_unwritable_after_send_exits_0(self):
        # AC-5 / F3: a good send followed by a DB write failure is exit 0.
        task = make_task(self.tmp)
        sender = FakeSender(200)
        code = ds.main(["--task-dir", task, "--env-file", self.env, "--db-path", "/no/such/dir/x.db"],
                       sender=sender, now=NOW)
        self.assertEqual(code, 0)
        self.assertEqual(len(sender.calls), 1)

    def test_chat_id_arg_overrides_config(self):
        task = make_task(self.tmp, config_extra={"chatId": "8643929442"})
        sender = FakeSender(200)
        code = ds.main(self._args(task, chat_id="8643929442"), sender=sender, now=NOW)
        self.assertEqual(code, 0)

    # --- helpers ---
    def _seed_card(self, card_id, status):
        con = sqlite3.connect(self.db)
        try:
            con.execute(
                "CREATE TABLE IF NOT EXISTS kanban_cards (id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER)"
            )
            con.execute(
                "INSERT OR REPLACE INTO kanban_cards (id, status, updated_at) VALUES (?, ?, ?)",
                (card_id, status, 0),
            )
            con.commit()
        finally:
            con.close()

    def _card_status(self, card_id):
        con = sqlite3.connect(self.db)
        try:
            row = con.execute("SELECT status FROM kanban_cards WHERE id = ?", (card_id,)).fetchone()
        finally:
            con.close()
        return row[0] if row else None


if __name__ == "__main__":
    unittest.main()
