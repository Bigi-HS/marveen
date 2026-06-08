#!/usr/bin/env python3
"""Handler: `status`.

Contract:
  handle(ctx: HandlerContext) -> Reply        (ctx.arg is None for status)

Read-only summary for Boss: which sessions are alive (reuses probe_tmux.collect)
plus the main OAuth token expiry in human terms (reuses probe_token.collect),
rendered as a Europe/Budapest local time with the remaining hours. Plain text,
short. NEVER prints the token value -- only the numeric expiry probe_token owns.

Both probes are read-only and degrade to {} on failure (and on eng/medic-base
they are still stubs), so this handler must stay readable even with no sessions
and an unknown token expiry. It calls the probes directly with ctx.ex; it does
NOT run health.collect() (that would pull in unrelated probes for a plain
status) and it never mutates anything.
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from medic import probe_tmux, probe_token
from medic.types import HandlerContext, Reply

# Local time zone for human-facing timestamps (Boss is in Budapest).
_TZ = ZoneInfo("Europe/Budapest")


def _summarize_sessions(sessions: dict) -> str:
    """'<alive>/<total> session el' or a plain note when nothing is known."""
    if not sessions:
        return "session-allapot ismeretlen"
    total = len(sessions)
    alive = sum(1 for ok in sessions.values() if ok)
    summary = f"{alive}/{total} session el"
    if alive < total:
        dead = sorted(name for name, ok in sessions.items() if not ok)
        summary += " (halott: " + ", ".join(dead) + ")"
    return summary


def _summarize_token(expires_at, now: float) -> str:
    """'Fo token lejar: 2026-06-08 20:57 (~7.8h)' in Europe/Budapest, or an
    unknown/expired note. Only the numeric expiry is touched -- never the value."""
    if expires_at is None:
        return "Fo token lejarat ismeretlen"
    when = datetime.fromtimestamp(expires_at, _TZ).strftime("%Y-%m-%d %H:%M")
    remaining_h = (expires_at - now) / 3600.0
    if remaining_h <= 0:
        return f"Fo token LEJART: {when}"
    return f"Fo token lejar: {when} (~{remaining_h:.1f}h)"


def handle(ctx: HandlerContext) -> Reply:
    ex = ctx.ex
    now = ex.now()

    # Reuse the read-only probes; tolerate a probe that returns {} (stub/failure).
    tmux = probe_tmux.collect(ex) or {}
    token = probe_token.collect(ex) or {}

    sessions = tmux.get("sessions") or {}
    expires_at = token.get("token_expires_at")

    text = "status: " + _summarize_sessions(sessions) + ". " + _summarize_token(expires_at, now) + "."
    return Reply(text)
