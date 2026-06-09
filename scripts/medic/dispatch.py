#!/usr/bin/env python3
"""Medic command dispatch -- pure, deterministic, injection-proof.

This module is Medic's security linchpin. It decides WHETHER a Telegram update
is an authorized command and WHICH pre-programmed action it maps to. It does NO
IO and runs NO shell: it only turns text into a validated `Command` (or a
`Reject`). Every side effect lives in actions.py behind an injected executor, so
a parsing mistake here can never execute anything.

Hard rules (Boss spec, card fc252db2; Chad audits this file):
  * Only BOSS_CHAT_ID may command Medic. Any other chat_id is Unauthorized and
    is never even parsed.
  * Fixed command allowlist. An unknown verb is rejected with a usage hint.
  * Arguments are validated against CLOSED enums (known agent ids / restart
    targets). No free-form argument ever reaches an action -- so a payload like
    "dave; rm -rf /" cannot match AGENTS and is rejected outright.
  * No eval, no shell, no string-built commands. This module returns data only.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Union

# The single Telegram chat allowed to command Medic (Dominik / Boss).
BOSS_CHAT_ID = 8643929442

# The 14 supervised sub-agents. Their tmux session is "agent-<id>".
AGENTS = (
    "applegate", "bigben", "buster", "chad", "claudia", "dave", "forge",
    "gauge", "heartbeat", "hibiki", "quill", "radar", "scout", "thor",
)
AGENT_SET = frozenset(AGENTS)

# `restart` accepts the agents plus two orchestrator-level aliases and "all".
# "genesis" -> the orchestrator sessions (marveen / marveen-channels). "all" is
# the 14 sub-agents only and deliberately EXCLUDES the orchestrator, so a single
# typo can never bounce the brain of the fleet (open question to Boss; if Boss
# wants orchestrator included, flip ALL_INCLUDES_ORCHESTRATOR in actions.py).
RESTART_TARGETS = AGENTS + ("genesis", "all")
RESTART_TARGET_SET = frozenset(RESTART_TARGETS)

# Argument policies a command may declare.
ARG_NONE = "none"
ARG_AGENT = "agent"
ARG_RESTART_TARGET = "restart_target"


@dataclass(frozen=True)
class CommandSpec:
    name: str
    arg: str  # one of ARG_NONE / ARG_AGENT / ARG_RESTART_TARGET
    help: str


# The complete, fixed command allowlist (v1). Order here is the order shown in
# the usage/help reply.
COMMANDS = {
    "status": CommandSpec(
        "status", ARG_NONE,
        "status -- ki el (tmux) + a fo OAuth token lejarata"),
    "diagnose": CommandSpec(
        "diagnose", ARG_NONE,
        "diagnose -- determinisztikus health-triazs: legvaloszinubb ok + javito-parancs"),
    "restart": CommandSpec(
        "restart", ARG_RESTART_TARGET,
        "restart <" + "|".join(RESTART_TARGETS) + ">"),
    "restart-telegram": CommandSpec(
        "restart-telegram", ARG_AGENT,
        "restart-telegram <agent> -- /mcp, majd melyebb channel/MCP ujrahuzas"),
    "mcp": CommandSpec(
        "mcp", ARG_AGENT,
        "mcp <agent> -- Telegram-pipe helyreallitas (/mcp send-keys)"),
    "token-refresh": CommandSpec(
        "token-refresh", ARG_NONE,
        "token-refresh -- fo OAuth refresh + behelyezes + propagalas minden agenshez"),
    "login-link": CommandSpec(
        "login-link", ARG_NONE,
        "login-link -- bongeszos re-login link (ha a refresh-token halott)"),
}


@dataclass(frozen=True)
class Command:
    """An authorized, fully validated command ready for actions.py."""
    name: str
    arg: Optional[str] = None


@dataclass(frozen=True)
class Reject:
    """A rejected update. `reason` is a stable code; `message` is a safe reply."""
    reason: str   # unauthorized | empty | unknown | missing_arg | bad_arg | extra_arg
    message: str


Parsed = Union[Command, Reject]


def authorize(chat_id) -> bool:
    """True iff the update came from the one Boss chat. Fails closed."""
    try:
        return int(chat_id) == BOSS_CHAT_ID
    except (TypeError, ValueError):
        return False


def usage() -> str:
    return "Medic parancsok:\n" + "\n".join(f"  {c.help}" for c in COMMANDS.values())


def _safe_verb(token: str) -> str:
    """A short, sanitised echo of an unknown verb for the reply -- never the raw
    payload. Keeps only word characters and dashes, capped, so nothing odd lands
    even in Medic's own logs."""
    cleaned = "".join(ch for ch in token if ch.isalnum() or ch in "-_")
    return cleaned[:24] if cleaned else "(ures)"


def parse(text: object) -> Parsed:
    """Parse raw message text into a Command or a Reject. Pure; no IO.

    Caller MUST have already checked authorize(chat_id); parse() assumes the
    sender is Boss and only concerns itself with command validity.
    """
    if not isinstance(text, str):
        return Reject("empty", "Ures parancs.\n" + usage())
    parts = text.strip().split()
    if not parts:
        return Reject("empty", "Ures parancs.\n" + usage())

    # Telegram sends "/status" or "/status@Medic_fixer_bot"; normalise both.
    verb = parts[0].lstrip("/").split("@", 1)[0].lower()
    args = parts[1:]

    spec = COMMANDS.get(verb)
    if spec is None:
        return Reject("unknown", f"Ismeretlen parancs: {_safe_verb(verb)}\n" + usage())

    if spec.arg == ARG_NONE:
        if args:
            return Reject("extra_arg", f"A '{spec.name}' nem var argumentumot.\n  {spec.help}")
        return Command(spec.name, None)

    # Commands that require exactly one enum-validated argument.
    if len(args) == 0:
        return Reject("missing_arg", f"Hianyzo argumentum.\n  {spec.help}")
    if len(args) > 1:
        return Reject("extra_arg", f"Tul sok argumentum.\n  {spec.help}")

    arg = args[0].lower()
    allowed = AGENT_SET if spec.arg == ARG_AGENT else RESTART_TARGET_SET
    if arg not in allowed:
        return Reject("bad_arg", f"Ervenytelen cel: {_safe_verb(arg)}\n  {spec.help}")
    return Command(spec.name, arg)
