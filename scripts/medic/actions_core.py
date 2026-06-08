#!/usr/bin/env python3
"""Medic credential CORE -- token-refresh (validate + propagate) and login-link.

HIGH RISK / Dave-owned (NOT phantom, card fc252db2 part C + auth-fix 1493e3e8).
These handlers touch the shared OAuth credential. Rules baked in: the token VALUE
is NEVER logged, echoed, or sent to Telegram (only read from / written to files
0600); we do NOT reimplement OAuth.

Empirical model (measured 2026-06-08, see store/medic-setuptoken-checklist.md):
the fleet auth token is now a STATIC ~1-year `sk-ant-oat01-...` bearer stored at
store/.claude-oauth-token. It does NOT rotate every 8h and there is no programmatic
refresh -- re-minting is an interactive `claude setup-token` browser flow only a
human can complete. `CLAUDE_CODE_OAUTH_TOKEN` set in an agent's env OVERRIDES any
stale .credentials.json (verified), so propagation = keeping a fleet env-file in
lockstep with the canonical token.

So the two handlers are:
  token-refresh : validate the canonical token (shape + age vs the ~1y expiry) and
                  PROPAGATE it into the fleet env-file (idempotent). If it is
                  missing/malformed/expired, point Boss at login-link. There is no
                  8h hot-path; this is a cheap, network-free, file-only operation.
  login-link    : Medic cannot open a browser, so it DETECTS the situation and
                  guides Boss through the one human step (`claude setup-token`),
                  then auto-propagates once the new token lands in the file.

The fleet env-file (FLEET_ENV_PATH) is the contract point the migration PR consumes
(every agent launch sources it for CLAUDE_CODE_OAUTH_TOKEN).
"""
from __future__ import annotations

import os
import re
from typing import Optional

from medic.types import HandlerContext, Reply

# Repo root: scripts/medic/actions_core.py -> up 3.
INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Canonical long-lived setup-token (sk-ant-oat01-..., 0600, gitignored).
SETUP_TOKEN_PATH = os.path.join(INSTALL_DIR, "store", ".claude-oauth-token")
# Fleet env-file the migration PR makes every agent launch source. 0600, gitignored.
FLEET_ENV_PATH = os.path.join(INSTALL_DIR, "store", "fleet-oauth.env")

TOKEN_PREFIX = "sk-ant-oat01-"
TOKEN_MIN_LEN = 40           # generous floor; the observed token is 108 chars
EXPIRY_DAYS = 365.0          # setup-token lifetime (~1 year)
WARN_BEFORE_DAYS = 21.0      # re-mint warning window before expiry
DAY_SEC = 86400.0
ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN"


def _valid_shape(token: str) -> bool:
    """A setup-token is a single-line `sk-ant-oat01-...` bearer. Shape only --
    never proves the token authenticates, just that it is well-formed."""
    return (
        token.startswith(TOKEN_PREFIX)
        and len(token) >= TOKEN_MIN_LEN
        and "\n" not in token
        and " " not in token
    )


def _token_status(ctx: HandlerContext) -> dict:
    """Read-only canonical-token status. NEVER returns the token value.

    Keys: present(bool), valid_shape(bool), age_days(float|None),
    expires_in_days(float|None), expired(bool), expiring_soon(bool).
    """
    raw = ctx.ex.read_text(SETUP_TOKEN_PATH)
    st = {
        "present": raw is not None,
        "valid_shape": False,
        "age_days": None,
        "expires_in_days": None,
        "expired": False,
        "expiring_soon": False,
    }
    if raw is None:
        return st
    st["valid_shape"] = _valid_shape(raw.strip())

    mtime = ctx.ex.path_mtime(SETUP_TOKEN_PATH)
    if mtime is not None:
        try:
            age = (float(ctx.ex.now()) - float(mtime)) / DAY_SEC
            st["age_days"] = age
            remaining = EXPIRY_DAYS - age
            st["expires_in_days"] = remaining
            st["expired"] = remaining <= 0
            st["expiring_soon"] = 0 < remaining <= WARN_BEFORE_DAYS
        except (ValueError, TypeError):
            pass
    return st


def _fmt_age(st: dict) -> str:
    """Human age/expiry suffix for reports (no secrets, estimate only)."""
    if st.get("age_days") is None:
        return "kor ismeretlen"
    age = st["age_days"]
    rem = st.get("expires_in_days")
    rem_txt = "ismeretlen" if rem is None else f"~{rem:.0f} nap"
    return f"kor ~{age:.0f} nap, becsult hatra: {rem_txt} (a lejarat becsult)"


def handle_token_refresh(ctx: HandlerContext) -> Reply:
    """Validate the canonical setup-token and propagate it into the fleet env-file.

    No 8h refresh exists for a static bearer; this is validate + idempotent
    file-sync. On a missing/malformed/expired token, defer to login-link.
    """
    st = _token_status(ctx)

    if not st["present"]:
        return Reply(
            "token-refresh: nincs canonical token (store/.claude-oauth-token "
            "hianyzik). Re-mint kell: futtasd a login-link lepeseit."
        )
    if not st["valid_shape"]:
        return Reply(
            "token-refresh: a canonical token alakja rossz (nem sk-ant-oat01-...). "
            "Re-mint kell: futtasd a login-link lepeseit."
        )
    if st["expired"]:
        return Reply(
            f"token-refresh: a token lejart ({_fmt_age(st)}). Re-mint kell: "
            "futtasd a login-link lepeseit."
        )

    # Propagate: keep FLEET_ENV_PATH in lockstep with the canonical token. The
    # value is read and rewritten only into a 0600 file -- never logged/echoed.
    token = (ctx.ex.read_text(SETUP_TOKEN_PATH) or "").strip()
    desired = f"{ENV_VAR}={token}\n"
    current = ctx.ex.read_text(FLEET_ENV_PATH)
    if current == desired:
        synced = "mar naprakesz"
    else:
        ok = ctx.ex.write_text(FLEET_ENV_PATH, desired, mode=0o600)
        synced = "frissitve" if ok else "FRISSITES SIKERTELEN"

    warn = " FIGYELEM: hamarosan lejar, tervezz re-mintet." if st["expiring_soon"] else ""
    return Reply(
        f"token-refresh: token OK ({_fmt_age(st)}). Fleet env ({ENV_VAR}): {synced}. "
        f"Az agensek a kovetkezo ujrainditaskor veszik fel.{warn}"
    )


def handle_login_link(ctx: HandlerContext) -> Reply:
    """Guide Boss through the one human re-mint step, then auto-propagate.

    Medic has no browser, and re-minting requires an interactive `claude
    setup-token` flow. So we report the current state and the exact procedure;
    once the new token lands at SETUP_TOKEN_PATH, `token-refresh` propagates it.
    """
    st = _token_status(ctx)
    if not st["present"]:
        state = "Jelenleg nincs canonical token."
    elif st["expired"]:
        state = f"A jelenlegi token lejart ({_fmt_age(st)})."
    elif st["expiring_soon"]:
        state = f"A jelenlegi token hamarosan lejar ({_fmt_age(st)})."
    else:
        state = f"A jelenlegi token meg ervenyes ({_fmt_age(st)})."

    return Reply(
        "login-link (re-mint, egyszeri emberi lepes):\n"
        f"{state}\n"
        "1) Terminalban: claude setup-token (bongeszos bejelentkezes).\n"
        "2) A kapott sk-ant-oat01-... tokent mentsd ide: "
        "store/.claude-oauth-token (chmod 600).\n"
        "3) Utana kuldd: token-refresh -- Medic ellenorzi es szetteriti a flottanak.\n"
        "(A token erteket SOHA ne kuldd vissza ide; csak a fajlba kerul.)"
    )


# --------------------------------------------------------------------------- #
# Pure helper kept for a future fully-automated capture (verified-with-Boss     #
# follow-up): extract the authorize URL from `claude setup-token` output so it  #
# can be relayed to Boss. Unit-tested; not yet wired into a live PTY drive.     #
# --------------------------------------------------------------------------- #
_URL_RE = re.compile(r"https://\S+")


def extract_setup_url(text: str) -> Optional[str]:
    """Return the first https URL in setup-token output, or None. Pure."""
    if not text:
        return None
    m = _URL_RE.search(text)
    return m.group(0).rstrip(".,)。") if m else None
