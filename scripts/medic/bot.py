#!/usr/bin/env python3
"""Medic Telegram long-poll loop + system executor (the security boundary).

This is the entry point. It is token-free in the OAuth sense: Medic has no Claude
model and no Anthropic credentials -- only its own Telegram bot token, loaded
from store/medic-bot.env (mode 0600, gitignored). The bot token is NEVER logged,
echoed, or sent in a reply; scrub() strips it from any string before output.

Flow per update:  authorize(chat_id) -> dispatch.parse(text) -> handler(ctx)
                  -> reply to Boss. Unauthorized chats are silently ignored.

Owned by the core (Dave): the env-loader, the chat_id gate, the poll loop, the
SystemExecutor, and the handler registry wiring. Handlers themselves live in
their own modules (some phantom-authored) and are imported here explicitly, so
no shared registry file can collide during parallel module work.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import List, Optional, Sequence

# Allow `python3 scripts/medic/bot.py` and `from medic import ...` both to work.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from medic import dispatch  # noqa: E402
from medic.types import Executor, ExecResult, HandlerContext, Reply  # noqa: E402

# Handler modules. Phantom-authored modules expose a `handle`/`collect` with the
# signatures in types.py; the credential core (actions_core) is Dave's.
from medic import actions_core  # noqa: E402
from medic import handlers_status  # noqa: E402
from medic import handlers_restart  # noqa: E402
from medic import handlers_telegram  # noqa: E402
from medic import health  # noqa: E402
from medic import patterns  # noqa: E402

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV_PATH = os.path.join(INSTALL_DIR, "store", "medic-bot.env")


# resolve_default_db lives in the shared scripts/db_resolve.py (card c9a543b5, DRY).
# scripts/ is already on sys.path (line 30). See that module for the noa.db-cutover
# rationale: defaulting to the frozen claudeclaw.db would make Medic's stuck-message
# probe read a stale/empty agent_messages table -> split-brain health signal.
from db_resolve import resolve_default_db  # noqa: E402

DB_PATH = resolve_default_db(project_root=INSTALL_DIR)

_BOT_TOKEN: Optional[str] = None  # cached; never logged


# --------------------------------------------------------------------------- #
# Bot-token loading + scrubbing                                                 #
# --------------------------------------------------------------------------- #
def load_bot_token(env_path: str = ENV_PATH) -> Optional[str]:
    """Read TELEGRAM_BOT_TOKEN from the env file. Returns None if absent. The
    value is never logged; callers must keep it out of output."""
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("TELEGRAM_BOT_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        return None
    return None


def scrub(text: str) -> str:
    """Remove the bot token from any string before it is logged or printed."""
    if _BOT_TOKEN and text:
        return text.replace(_BOT_TOKEN, "REDACTED")
    return text


def log(msg: str) -> None:
    sys.stderr.write(f"[medic] {scrub(msg)}\n")
    sys.stderr.flush()


# --------------------------------------------------------------------------- #
# SystemExecutor: the real Executor. argv lists only -- never shell=True.       #
# --------------------------------------------------------------------------- #
class SystemExecutor:
    def run(self, argv: Sequence[str], timeout: float = 30.0) -> ExecResult:
        try:
            p = subprocess.run(
                list(argv), capture_output=True, text=True,
                timeout=timeout, shell=False,  # shell=False is load-bearing
            )
            return ExecResult(p.returncode, p.stdout, p.stderr)
        except subprocess.TimeoutExpired:
            return ExecResult(124, "", "timeout")
        except (OSError, ValueError) as e:
            return ExecResult(127, "", str(e))

    def read_text(self, path: str) -> Optional[str]:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return None

    def write_text(self, path: str, content: str, mode: int = 0o600) -> bool:
        tmp = f"{path}.medic.{os.getpid()}"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.chmod(tmp, mode)
            os.replace(tmp, path)  # atomic within the same filesystem
            return True
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return False

    def path_mtime(self, path: str) -> Optional[float]:
        try:
            return os.stat(path).st_mtime
        except OSError:
            return None

    def query(self, sql: str, params: Sequence = ()) -> List[tuple]:
        try:
            con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5)
            try:
                return list(con.execute(sql, tuple(params)).fetchall())
            finally:
                con.close()
        except sqlite3.Error:
            return []

    def now(self) -> float:
        return time.time()


# --------------------------------------------------------------------------- #
# Command registry: command name -> handler. Wired explicitly here.            #
# `diagnose` is orchestrated in-core (collect health -> match patterns).       #
# --------------------------------------------------------------------------- #
def _handle_diagnose(ctx: HandlerContext) -> Reply:
    snap = health.collect(ctx.ex)
    dx = patterns.diagnose(snap)
    return Reply(
        f"diagnose: {dx.cause}\n{dx.detail}\n-> javaslat: {dx.fix_command}"
    )


HANDLERS = {
    "status": handlers_status.handle,
    "diagnose": _handle_diagnose,
    "restart": handlers_restart.handle,
    "restart-telegram": handlers_telegram.handle_restart_telegram,
    "mcp": handlers_telegram.handle_mcp,
    "token-refresh": actions_core.handle_token_refresh,
    "login-link": actions_core.handle_login_link,
}


def handle_update(text: str, ex: Executor) -> Reply:
    """Parse + dispatch a single authorized message into a Reply. Pure routing;
    the caller has already confirmed the sender is Boss."""
    parsed = dispatch.parse(text)
    if isinstance(parsed, dispatch.Reject):
        return Reply(parsed.message)
    handler = HANDLERS.get(parsed.name)
    if handler is None:  # registry/allowlist drift guard -- should be unreachable
        return Reply(dispatch.usage())
    try:
        return handler(HandlerContext(ex=ex, arg=parsed.arg))
    except Exception as e:  # a handler bug must never crash the poll loop
        log(f"handler '{parsed.name}' raised: {e!r}")
        return Reply(f"Belso hiba a '{parsed.name}' parancsban. A flotta nem serult.")


# --------------------------------------------------------------------------- #
# Telegram long-poll loop                                                      #
# --------------------------------------------------------------------------- #
def _api(method: str, params: dict, timeout: float) -> Optional[dict]:
    url = f"https://api.telegram.org/bot{_BOT_TOKEN}/{method}"
    data = json.dumps(params).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as e:
        log(f"telegram {method} failed: {scrub(str(e))}")
        return None


def send_reply(chat_id: int, text: str) -> None:
    _api("sendMessage", {"chat_id": chat_id, "text": scrub(text)}, timeout=15)


def poll_loop() -> None:
    ex = SystemExecutor()
    offset = 0
    log("Medic up (Boss-only break-glass operator).")
    while True:
        resp = _api("getUpdates", {"offset": offset, "timeout": 50}, timeout=60)
        if not resp or not resp.get("ok"):
            time.sleep(3)
            continue
        for upd in resp.get("result", []):
            offset = max(offset, upd.get("update_id", 0) + 1)
            msg = upd.get("message") or upd.get("edited_message")
            if not msg:
                continue
            chat_id = (msg.get("chat") or {}).get("id")
            # HARD GATE: only the Boss chat is ever served. Everything else is
            # silently dropped -- Medic does not reveal itself to strangers.
            if not dispatch.authorize(chat_id):
                continue
            reply = handle_update(msg.get("text", ""), ex)
            send_reply(chat_id, reply.text)


def main() -> int:
    global _BOT_TOKEN
    _BOT_TOKEN = load_bot_token()
    if not _BOT_TOKEN:
        log(f"no bot token at {ENV_PATH} -- cannot start")
        return 1
    try:
        poll_loop()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
