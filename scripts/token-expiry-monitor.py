#!/usr/bin/env python3
"""token-expiry-monitor.py -- proactive, token-free early warning for the fleet's
shared Claude auth setup-token.

Card 1493e3e8 (Auth-token resilience: zero-human OAuth, post-2026-06-08 outage).

WHY THIS EXISTS
---------------
The whole fleet authenticates off ONE static ~1-year `sk-ant-oat01-...` setup-token
at store/.claude-oauth-token. Re-minting it REQUIRES a human `claude setup-token`
browser flow -- no agent can do it unattended. So the only "zero human dependency"
guarantee against the token's eventual expiry is to warn the Boss FAR ENOUGH IN
ADVANCE that the re-login happens on a calm schedule, never as a fleet-down fire
(which is exactly what 2026-06-08 was). The Medic break-glass bot is REACTIVE
(Boss-only commands); nothing proactively watched expiry until this.

DESIGN PRINCIPLES
-----------------
* token-free / model-free: pure Python, no Claude model, no dashboard bearer. It must
  survive the very auth-death it guards (the Hibiki-survival lesson: a monitor must
  not depend on the thing it monitors).
* cron-driven, NOT a scheduled-task: scheduled-tasks only fire when the agent's tmux
  is alive; this has to run precisely when the fleet may be DOWN. Install via
  scripts/install-token-expiry-cron.sh (a separate deploy step; merging this file is
  inert).
* idempotent / escalating: alerts ONCE per severity level crossed (21 -> 14 -> 7 ->
  3 -> 1 day -> expired -> missing), never daily spam. State in
  store/token-expiry-alert-state.json. A re-minted token resets the ladder.
* reuse, never reinvent: expiry math is medic.actions_core._token_status (the single
  source of truth, age-based off the file mtime, EXPIRY_DAYS / WARN_BEFORE_DAYS); the
  Telegram path is medic.bot's token-free Bot API send. No parallel credential or
  send mechanism.

CLI
---
  --once       run one check; alert + update state if a new severity level crossed
  --dry-run    compute + print the decision; never send, never write state
  --status     print the token status (no secrets) as JSON and exit
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Callable, Optional, Tuple

# Repo root: scripts/ -> up one. Lets the medic package import resolve.
INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, INSTALL_DIR)

STATE_PATH = os.path.join(INSTALL_DIR, "store", "token-expiry-alert-state.json")
BOSS_CHAT_ID = 8643929442  # Dominik's Telegram chat (per CLAUDE.md)
DAY_SEC = 86400.0

# Severity ladder. Higher = more urgent. 0 = healthy (no alert). The day-thresholds
# mirror the warning window; -expired / -missing are the terminal states. Kept here
# (not in medic) because escalation policy is this monitor's concern, while the raw
# expiry math stays the single source of truth in medic.actions_core.
THRESHOLD_DAYS = [21, 14, 7, 3, 1]  # descending; each crossed downward = a new alert
LEVEL_HEALTHY = 0
LEVEL_EXPIRED = len(THRESHOLD_DAYS) + 1   # 6
LEVEL_MISSING = len(THRESHOLD_DAYS) + 2   # 7


def classify(status: dict) -> Tuple[int, str]:
    """Map a medic _token_status dict to (severity_level, label).

    Pure: no IO, no clock. `status` keys used: present, valid_shape,
    expires_in_days, expired.
    """
    if not status.get("present") or not status.get("valid_shape"):
        return LEVEL_MISSING, "missing"
    remaining = status.get("expires_in_days")
    if remaining is None:
        # Present + well-formed but age unknown (no mtime). Cannot judge expiry; do
        # not cry wolf -- treat as healthy for escalation purposes.
        return LEVEL_HEALTHY, "healthy"
    if remaining <= 0 or status.get("expired"):
        return LEVEL_EXPIRED, "expired"
    # Most-severe threshold the remaining time has dropped to/under.
    for idx, days in enumerate(THRESHOLD_DAYS):
        if remaining <= days:
            # idx 0 (21d) -> level 1, idx 4 (1d) -> level 5.
            level = idx + 1
            # Re-derive the label from the deepest threshold crossed.
            deepest = days
            for d in THRESHOLD_DAYS:
                if remaining <= d:
                    deepest = d
                    level = THRESHOLD_DAYS.index(d) + 1
            return level, f"{deepest}d"
    return LEVEL_HEALTHY, "healthy"


def _expiry_date_str(remaining_days: Optional[float], now: float) -> str:
    if remaining_days is None:
        return "ismeretlen"
    ts = now + remaining_days * DAY_SEC
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def build_message(level: int, status: dict, now: float) -> str:
    """Boss-facing Hungarian alert text. No secrets, no em-dash."""
    remaining = status.get("expires_in_days")
    if level == LEVEL_MISSING:
        return (
            "KRITIKUS auth-riasztas: a kozos Claude OAuth setup-token "
            "(store/.claude-oauth-token) HIANYZIK vagy hibas formatumu. A flotta "
            "shared-auth agensei nem tudnak hitelesiteni. Azonnali re-mint kell: "
            "futtasd a 'claude setup-token' folyamatot es ird be az erteket a "
            "store/.claude-oauth-token fajlba (chmod 600)."
        )
    if level == LEVEL_EXPIRED:
        return (
            "KRITIKUS auth-riasztas: a kozos Claude OAuth setup-token LEJART. A "
            "flotta tobbsege auth-dead lehet (ez tortent 2026-06-08-an). Azonnali "
            "re-mint kell: 'claude setup-token' + store/.claude-oauth-token frissites."
        )
    days = int(remaining) if remaining is not None else "?"
    date = _expiry_date_str(remaining, now)
    return (
        f"Auth-token figyelmeztetes: a kozos Claude OAuth setup-token kb {days} nap "
        f"mulva lejar (becsult lejarat: {date}). A re-mint EMBERI lepest igenyel, "
        f"ezert idoben szolok. Futtasd nyugodt idoben a 'claude setup-token' "
        f"folyamatot es frissitsd a store/.claude-oauth-token fajlt. A flotta addig "
        f"a meglevo tokennel mukodik."
    )


def build_reset_message(now: float, status: dict) -> str:
    date = _expiry_date_str(status.get("expires_in_days"), now)
    return (
        "Auth-token all-clear: a kozos Claude OAuth setup-token frissult, a lejarat "
        f"ujra tavol (becsult lejarat: {date}). A figyelmezteto-kuszob nullazva."
    )


def should_alert(current_level: int, last_level: int) -> bool:
    """Alert only when severity ESCALATED to a new, deeper level than last time.
    Idempotent: same or lower severity than already-alerted -> no re-send."""
    return current_level > LEVEL_HEALTHY and current_level > last_level


def should_reset(current_level: int, last_level: int) -> bool:
    """The token went back to healthy after we had alerted -> reset the ladder
    (and send one all-clear)."""
    return current_level == LEVEL_HEALTHY and last_level > LEVEL_HEALTHY


def load_state(path: str = STATE_PATH) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            if isinstance(data, dict):
                return data
    except (OSError, ValueError):
        pass
    return {"level": LEVEL_HEALTHY}


def save_state(level: int, label: str, now: float, path: str = STATE_PATH) -> None:
    tmp = path + ".tmp"
    payload = {"level": level, "label": label, "updated_at": now}
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.replace(tmp, path)  # atomic
    except OSError as exc:
        sys.stderr.write(f"[token-expiry-monitor] state write failed: {exc}\n")


def decide(
    status: dict,
    state: dict,
    now: float,
    sender: Callable[[str], bool],
    persist: Callable[[int, str, float], None],
) -> str:
    """Pure-ish orchestration: classify -> compare to last level -> maybe send +
    persist. Returns one of 'alerted' | 'reset' | 'noop'. `sender` and `persist` are
    injected so this is unit-testable without Telegram or disk."""
    level, label = classify(status)
    last_level = int(state.get("level", LEVEL_HEALTHY))

    # Persist ONLY after a successful send, so a failed alert (e.g. Telegram down
    # during the very outage we are warning about) retries on the next cron run
    # instead of being silently marked done.
    if should_alert(level, last_level):
        if sender(build_message(level, status, now)):
            persist(level, label, now)
            return "alerted"
        return "alert-failed"
    if should_reset(level, last_level):
        if sender(build_reset_message(now, status)):
            persist(LEVEL_HEALTHY, "healthy", now)
            return "reset"
        return "reset-failed"
    return "noop"


# --------------------------------------------------------------------------- #
# Real-environment wiring (lazy imports so unit tests stay light + send-free)   #
# --------------------------------------------------------------------------- #
def _real_status() -> dict:
    from medic import actions_core
    from medic.bot import SystemExecutor
    from medic.types import HandlerContext

    ctx = HandlerContext(ex=SystemExecutor(), arg=None)
    return actions_core._token_status(ctx)


def _real_sender(text: str) -> bool:
    """Token-free Telegram send to the Boss, reusing medic.bot's Bot API path."""
    from medic import bot

    token = bot.load_bot_token()
    if not token:
        sys.stderr.write("[token-expiry-monitor] no bot token; cannot alert\n")
        return False
    bot._BOT_TOKEN = token  # _api() reads this module global
    try:
        bot.send_reply(BOSS_CHAT_ID, text)
        return True
    except Exception as exc:  # never let a send error crash the cron run
        sys.stderr.write(f"[token-expiry-monitor] send failed: {bot.scrub(str(exc))}\n")
        return False


def main(argv: Optional[list] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    dry_run = "--dry-run" in argv
    status_only = "--status" in argv

    try:
        status = _real_status()
    except Exception as exc:  # fail-safe: cron must never see a crash loop
        sys.stderr.write(f"[token-expiry-monitor] status read failed: {exc}\n")
        return 0

    if status_only:
        print(json.dumps(status, indent=2))
        return 0

    now = time.time()
    level, label = classify(status)

    if dry_run:
        state = load_state()
        last = int(state.get("level", LEVEL_HEALTHY))
        action = (
            "alerted" if should_alert(level, last)
            else "reset" if should_reset(level, last)
            else "noop"
        )
        print(json.dumps({
            "level": level, "label": label, "last_level": last,
            "action": action, "expires_in_days": status.get("expires_in_days"),
        }, indent=2))
        return 0

    state = load_state()
    result = decide(status, state, now, _real_sender, save_state)
    sys.stderr.write(f"[token-expiry-monitor] level={level} ({label}) -> {result}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
