#!/usr/bin/env python3
"""Medic shared contract -- the interfaces every module builds against.

This file is the COUPLING POINT. It is owned by the core (Dave) and must stay
stable: phantom-authored modules (health probes, the diagnosis table, the
status/restart handlers, tests) import these types but MUST NOT edit this file.
That keeps parallel module work worktree-safe and collision-free.

Design: all system access goes through an injected `Executor` (argv lists only,
never a shell string), so every probe and handler is unit-testable with a fake
executor and a parsing/logic bug can never reach a real command.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Protocol, Sequence


# --------------------------------------------------------------------------- #
# Executor: the ONLY gateway to the system. Implementations: SystemExecutor    #
# (real, in bot.py) and fakes in tests. argv is always a list -- no shell.     #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ExecResult:
    code: int
    out: str
    err: str


class Executor(Protocol):
    def run(self, argv: Sequence[str], timeout: float = 30.0) -> ExecResult:
        """Run a process from an argv list (NEVER a shell string). Must not
        raise on non-zero exit; encode failure in ExecResult.code."""
        ...

    def read_text(self, path: str) -> Optional[str]:
        """Return a file's text, or None if missing/unreadable. Read-only."""
        ...

    def write_text(self, path: str, content: str, mode: int = 0o600) -> bool:
        """Atomically write a file (used only by the credential core). Returns
        True on success. Phantom/read-only modules never call this."""
        ...

    def path_mtime(self, path: str) -> Optional[float]:
        """File mtime (epoch sec) or None. Read-only."""
        ...

    def query(self, sql: str, params: Sequence = ()) -> List[tuple]:
        """Run a READ-ONLY SQL query against the fleet DB. Parameterised only."""
        ...

    def now(self) -> float:
        """Current epoch seconds (injected so tests are deterministic)."""
        ...


# --------------------------------------------------------------------------- #
# Health snapshot: the deterministic picture `diagnose` reasons over. Each      #
# probe fills the subset of fields it owns; health.collect() merges them.       #
# --------------------------------------------------------------------------- #
@dataclass
class HealthSnapshot:
    now: float = 0.0
    # tmux session name ("agent-dave", "marveen", ...) -> alive
    sessions: Dict[str, bool] = field(default_factory=dict)
    # main OAuth token: absolute expiry (epoch sec) and age since last refresh
    token_expires_at: Optional[float] = None
    token_refreshed_age_sec: Optional[float] = None
    # supervisor keep-alive / watchdog freshness
    keepalive_age_sec: Optional[float] = None
    watchdogs: Dict[str, bool] = field(default_factory=dict)
    # per-agent Telegram-pipe liveness (Bot API 409 = the bot is being polled = alive)
    pipe_alive: Dict[str, bool] = field(default_factory=dict)
    # inter-agent messages ingested but never delivered (delivered_at NULL)
    stuck_messages: int = 0
    # matched recent log-error signatures (stable codes, not raw log text)
    log_errors: List[str] = field(default_factory=list)

    def token_expires_in(self) -> Optional[float]:
        if self.token_expires_at is None:
            return None
        return self.token_expires_at - self.now


# A probe is a READ-ONLY function returning the HealthSnapshot fields it owns as
# a dict. It may call ex.run / ex.read_text / ex.query / ex.path_mtime / ex.now
# but MUST NOT mutate any state. Phantom modules each implement one `collect`.
Probe = Callable[[Executor], dict]


# --------------------------------------------------------------------------- #
# Diagnosis: the verdict `diagnose` returns. `fix_command` is a Medic command   #
# string Boss can run next (e.g. "token-refresh", "mcp dave").                  #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Diagnosis:
    cause: str        # token_expired | pipe_dead | session_crash | wedged | healthy | unknown
    detail: str
    fix_command: str


# --------------------------------------------------------------------------- #
# Handlers: each command maps to one handler taking a HandlerContext and        #
# returning a Reply. bot.py wires the registry by importing each module's       #
# `handle` explicitly (no shared registry file -> no phantom merge collisions). #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Reply:
    text: str


@dataclass(frozen=True)
class HandlerContext:
    ex: Executor
    arg: Optional[str] = None


Handler = Callable[[HandlerContext], Reply]
