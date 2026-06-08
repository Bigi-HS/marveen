#!/usr/bin/env python3
"""Medic credential CORE -- token-refresh(+install+propagate) and login-link.

HIGH RISK / Dave-owned (NOT phantom, card fc252db2 part C). These handlers touch
the shared OAuth credential. Rules baked in: the token value is NEVER logged,
echoed, or sent to Telegram (only written to files 0600); the OAuth refresh uses
Claude Code's BUILT-IN mechanism (no OAuth reimplementation); propagation reuses
the supervisor's promote-to-main + symlink reconcile (auth-fix card 1493e3e8).

This file is a STUB on eng/medic-base so the scaffold imports + tests green.
Dave fills the real implementation on the base in a follow-up commit; phantom
modules never touch this file.
"""
from __future__ import annotations

from medic.types import HandlerContext, Reply


def handle_token_refresh(ctx: HandlerContext) -> Reply:
    # TODO(dave, core): single-owner headless refresh of ~/.claude main token ->
    # promote-to-main -> reconcile symlinks -> reconnect. Case1 refresh-token
    # alive => fully headless. Case2 dead => return login-link guidance.
    return Reply("token-refresh: core meg nincs bekotve (eng/medic-base stub).")


def handle_login_link(ctx: HandlerContext) -> Reply:
    # TODO(dave, core): produce the `claude auth login` browser URL and send it
    # to Boss ONLY. The captured token is written to file, never to Telegram/log.
    return Reply("login-link: core meg nincs bekotve (eng/medic-base stub).")
