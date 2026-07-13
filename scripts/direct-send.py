#!/usr/bin/env python3
"""Model-free direct-send layer (token-outage survival, Layer 1).

Card 92f07145. Spec: store/spec-direct-send-layer.md (Quill, thor-gated v3).

When the shared Claude account hits its usage limit, every agent freezes on the
limit menu and all scheduled reminders go silent (the normal path injects a
prompt into the frozen tmux session, which never runs). This script is the
deterministic, LLM-free bypass: the schedule-runner invokes it directly for a
task marked `directSend: true` when `store/token-outage-state.json` says
`limited: true`. It sends ONE pre-written reminder over the Telegram Bot API and
logs the outcome -- no reasoning, no interpolation, no inbound handling.

stdlib only (AC-9). Run tests: python3 -m pytest scripts/test_direct_send.py

Exit codes (AC-10):
  0  sent successfully (incl. post-send DB/card-update failure -- delivery is what matters)
  1  config error before any send attempt (no template / no token / invalid chat_id) -- nothing sent
  2  send failed (network error or Telegram non-200) -- message NOT delivered
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# AC-3: chat_id must match a known operator chat id. Hardcoded whitelist (M4).
KNOWN_CHAT_IDS = {"8643929442"}
DEFAULT_CHAT_ID = "8643929442"

# AC-4: token is read from the .env by pointer, never hardcoded. The capture
# group strips optional surrounding single/double quotes; the raw value is never
# logged, printed, or stored (M1).
_TOKEN_RE = re.compile(r"""TELEGRAM_BOT_TOKEN\s*=\s*['"]?([^'"\n]+)['"]?""")

_SECTION_HEADER = "## Direct Message"


def extract_direct_message(skill_md):
    """AC-2 / 4.2 / M7: return the verbatim text of the `## Direct Message`
    section -- everything between that heading and the next `##`-prefixed line
    (or EOF), whitespace-stripped. Returns None when the section is absent or
    empty after stripping (caller treats that as no_template).
    """
    lines = skill_md.splitlines()
    out = []
    in_section = False
    for line in lines:
        if not in_section:
            if line.strip() == _SECTION_HEADER:
                in_section = True
            continue
        # The first `##`-prefixed line after the header ends the section (M7).
        if line.lstrip().startswith("##"):
            break
        out.append(line)
    if not in_section:
        return None
    text = "\n".join(out).strip()
    return text or None


def load_token(env_text):
    """AC-4: extract TELEGRAM_BOT_TOKEN from .env content. Returns None if absent."""
    m = _TOKEN_RE.search(env_text)
    if not m:
        return None
    token = m.group(1).strip()
    return token or None


def telegram_send(token, chat_id, text, opener=urllib.request.urlopen):
    """AC-3: single POST to sendMessage (plain text). Returns the HTTP status
    code (200 on success), or -1 on a network/transport error. Never returns or
    logs the token. The opener is injectable so tests need no network.
    """
    url = "https://api.telegram.org/bot{}/sendMessage".format(token)
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    try:
        resp = opener(req, timeout=15)
        try:
            return resp.getcode() or 200
        finally:
            close = getattr(resp, "close", None)
            if close:
                close()
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, OSError, TimeoutError):
        return -1


# resolve_default_db lives in the shared scripts/db_resolve.py (card c9a543b5, DRY).
# See that module for the noa.db-cutover / frozen-legacy rationale: defaulting to
# the frozen claudeclaw.db would (post-cutover) write direct_send_log rows + kanban
# updates into the dead legacy DB, invisible to the live board (card b793b2d8).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from db_resolve import resolve_default_db  # noqa: E402


def _connect(db_path):
    # Short busy timeout so a momentarily-locked DB does not hang the send path.
    return sqlite3.connect(db_path, timeout=5)


def log_row(db_path, task_name, agent, status, reason, warning, logged_at):
    """AC-5: append one row to direct_send_log (created on first use). All values
    bound as parameters (AC-8). Returns True on success, False on any DB error
    (the caller decides the exit code -- a failed log after a good send is exit 0).
    """
    try:
        con = _connect(db_path)
        try:
            con.execute(
                """CREATE TABLE IF NOT EXISTS direct_send_log (
                       id INTEGER PRIMARY KEY AUTOINCREMENT,
                       task_name TEXT,
                       agent TEXT,
                       status TEXT,
                       reason TEXT,
                       warning TEXT,
                       logged_at INTEGER
                   )"""
            )
            con.execute(
                "INSERT INTO direct_send_log (task_name, agent, status, reason, warning, logged_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (task_name, agent, status, reason, warning, logged_at),
            )
            con.commit()
            return True
        finally:
            con.close()
    except sqlite3.Error:
        return False


def update_card(db_path, card_id, now):
    """AC-6: mark the kanban card done after a successful send. Returns
    'updated' | 'not_found' | 'error'. Never fatal -- the send already succeeded.
    """
    try:
        con = _connect(db_path)
        try:
            cur = con.execute(
                "UPDATE kanban_cards SET status = 'done', updated_at = ? WHERE id = ?",
                (now, card_id),
            )
            con.commit()
            return "updated" if cur.rowcount > 0 else "not_found"
        finally:
            con.close()
    except sqlite3.Error:
        return "error"


def main(argv=None, sender=telegram_send, now=None):
    parser = argparse.ArgumentParser(description="Model-free direct-send (token-outage Layer 1)")
    parser.add_argument("--task-dir", required=True)
    parser.add_argument("--env-file", default="/home/domin/marveen/.env")
    parser.add_argument("--db-path", default=resolve_default_db())
    parser.add_argument("--chat-id", default=None)
    args = parser.parse_args(argv)

    if now is None:
        now = int(time.time())

    task_dir = args.task_dir
    task_name = os.path.basename(os.path.normpath(task_dir))

    # Task config: agent (log column), cardId (optional card update), chatId
    # (optional override). Malformed/absent config -> empty defaults.
    config = {}
    try:
        with open(os.path.join(task_dir, "task-config.json"), encoding="utf-8") as f:
            config = json.load(f)
    except (OSError, ValueError):
        config = {}
    if not isinstance(config, dict):
        config = {}
    agent = str(config.get("agent") or "unknown")
    card_id = str(config.get("cardId") or "").strip()

    def log(status, reason, warning):
        ok = log_row(args.db_path, task_name, agent, status, reason, warning, now)
        if not ok:
            sys.stderr.write("direct-send: WARN failed to write direct_send_log row\n")
        return ok

    # AC-2: template-only. Missing/empty section -> skipped, nothing sent.
    skill_md = ""
    try:
        with open(os.path.join(task_dir, "SKILL.md"), encoding="utf-8") as f:
            skill_md = f.read()
    except OSError:
        skill_md = ""
    template = extract_direct_message(skill_md)
    if not template:
        log("skipped", "no_template", None)
        return 1

    # AC-3: chat_id precedence arg > config > default, then whitelist check.
    chat_id = str(args.chat_id or config.get("chatId") or DEFAULT_CHAT_ID)
    if chat_id not in KNOWN_CHAT_IDS:
        log("error", "invalid_chat_id", None)
        return 1

    # AC-4: token by pointer. Absent file or missing key -> no_token.
    env_text = ""
    try:
        with open(args.env_file, encoding="utf-8") as f:
            env_text = f.read()
    except OSError:
        env_text = ""
    token = load_token(env_text)
    if not token:
        log("error", "no_token", None)
        return 1

    # AC-3: single send.
    status_code = sender(token, chat_id, template)
    if status_code != 200:
        reason = "telegram_network" if status_code == -1 else "telegram_{}".format(status_code)
        log("error", reason, None)
        return 2

    # Send succeeded. AC-6: optional card update is a non-fatal post-send op.
    warning = None
    if card_id:
        result = update_card(args.db_path, card_id, now)
        if result == "not_found":
            warning = "card_not_found:{}".format(card_id)
        elif result == "error":
            sys.stderr.write("direct-send: WARN card update DB error after successful send\n")
    log("sent", None, warning)
    return 0


if __name__ == "__main__":
    sys.exit(main())
