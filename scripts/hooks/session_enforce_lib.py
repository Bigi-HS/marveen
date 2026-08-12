#!/usr/bin/env python3
"""Shared logic for the SessionStart / UserPromptSubmit enforcement bundle
(cards 03a4f57d + 705381e3).

Two coherent, config-driven enforcement surfaces, imported by two thin hook
entries (session-start-enforce.py and prompt-freshness-nudge.py):

  1. SessionStart per-agent checks (03a4f57d). A small declarative table maps an
     agent to a fixed reminder the harness surfaces as additionalContext at
     session start: hibiki -> process pending inbox images immediately; claudia ->
     email ask-first / draft-before-send. This does NOT duplicate the hot-cache
     staleness guard (fedb4b5f) -- that stays in hot-cache-sessionstart.py. There
     is no filesystem inbox directory to scan, so the check is a behavioural
     reminder, not a directory poll.

  2. UserPromptSubmit long-session anti-bloat nudge (705381e3). The TG3000 incident
     (2026-07-01) was a mid-session user message misread as a boilerplate no-op
     under a bloated context. SessionStart cannot catch a mid-session turn, so the
     nudge binds to UserPromptSubmit -- the natural "a new task arrives" event.
     It is threshold-gated (only long / bloated sessions fire) and rate-limited
     (a cooldown between nudges) so it stays quiet on normal turns. context% is not
     available at hook time, so the proxy is session-age (tracked from the first
     prompt of the session) plus transcript size (stat of transcript_path).

All functions are pure / IO-isolated so the hook entries stay trivial and the
suite can drive the decision logic directly.
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


# --- SessionStart per-agent checks (03a4f57d) -------------------------------

# Fixed reminders injected at SessionStart for the listed agents only. Every
# other agent gets nothing from this surface (the hot-cache / memory-replay hooks
# already cover generic startup context).
AGENT_SESSIONSTART_CHECKS = {
    "hibiki": (
        "INBOX-CHECK (SessionStart). Mieloatt mas dologba kezdesz, gyoazoadj meg "
        "rola hogy nincs feldolgozatlan beerkezo kep/PDF az elozoa turnokboal. A "
        "beerkezoa etkezes-kep / app-screenshot / DEXA AZONNAL feldolgozando a "
        "PARSE-AC szabalyok szerint, nem halaszthato a koavetkezoa turnre (06-29 "
        "incidens: reggeli + shake ejtve)."
    ),
    "claudia": (
        "EMAIL ASK-FIRST (SessionStart). Emlekezteto: kimenoa emailt vagy naptar-"
        "modositast Dominik neveben CSAK draft-elsz es megeroasitest kersz kuldes "
        "eloatt. Katasztrofalis vagy kulsoa-hatasu muveletnel HARD ask-first, "
        "fuggetlenul attol ki keri."
    ),
}


def sessionstart_reminder(agent_id):
    """Return the SessionStart reminder for this agent, or None if it has none."""
    return AGENT_SESSIONSTART_CHECKS.get(agent_id)


# --- UserPromptSubmit long-session anti-bloat nudge (705381e3) ---------------

DEFAULT_NUDGE_CONFIG = {
    # DELIBERATELY INERT. Age was dropped as a trigger (Boss 2026-08-12): alone it
    # made 24/7 agents fire every cooldown forever, whatever their real context
    # size. Nothing reads this key any more -- should_nudge does not, and pruning
    # uses session_prune_s, not this. It is kept only as the recorded "what counts
    # as long" figure the tests drive age cases from. Re-arming it as a trigger
    # re-creates the original noise.
    "age_threshold_s": 2 * 3600,
    # A transcript at/above this counts as "bloated" and is the ONLY nudge trigger.
    # Hooks cannot read the true context-token %, so transcript size is the proxy
    # for "near the limit". Real bloated sessions measured at 7-28 MB; the old
    # 350 KB threshold fired on nearly every long-lived agent (Boss 2026-08-12).
    "transcript_bytes_threshold": 5_000_000,
    # Minimum gap between two nudges for the same session (rate-limit / anti-noise).
    # 60 min so even a genuinely-large session does not spam (Boss 2026-08-12).
    "cooldown_s": 60 * 60,
    # Sessions untouched for longer than this are pruned from the state file.
    "session_prune_s": 24 * 3600,
}


def get_session_entry(state, session_id, now):
    """Fetch (or lazily create) the per-session tracking entry. A new session
    records `first_seen = now`; an existing entry is returned untouched so its
    first_seen keeps measuring true session age."""
    entry = state.get(session_id)
    if not isinstance(entry, dict) or "first_seen" not in entry:
        entry = {"first_seen": now, "last_nudge": 0.0}
        state[session_id] = entry
    return entry


def prune_sessions(state, now, prune_s):
    """Drop entries whose first_seen is older than prune_s so the state file does
    not grow without bound. Mutates state in place."""
    stale = [
        sid for sid, e in state.items()
        if not isinstance(e, dict) or (now - e.get("first_seen", now)) > prune_s
    ]
    for sid in stale:
        del state[sid]


def should_nudge(entry, now, transcript_bytes, cfg):
    """Pure gate. Fire ONLY when the session is genuinely large (bloated) AND the
    cooldown since the last nudge has elapsed. Age is deliberately NOT a trigger
    (Boss 2026-08-12): age alone made this fire every cooldown forever on 24/7
    agents regardless of actual context size. transcript_bytes may be None
    (unknown) -- in that case we do NOT fire (fail-quiet)."""
    bloated = transcript_bytes is not None and transcript_bytes >= cfg["transcript_bytes_threshold"]
    long_session = bloated
    if not long_session:
        return False
    if (now - entry.get("last_nudge", 0.0)) < cfg["cooldown_s"]:
        return False
    return True


def build_longsession_nudge():
    """The two-signal anti-bloat reminder (705381e3): (a) the incoming turn is a
    real user instruction, not a boilerplate no-op (the concrete TG3000 failure);
    (b) in a long session verify the LIVE board / memory before acting and prefer a
    fresh session for large new work."""
    return (
        "CONTEXT-FRESHNESS (hosszu session). Ez a session hosszu vagy bloatolt, "
        "figyelj ket dologra:\n"
        "(a) A most beerkezoa turn VALODI user-utasitas amit el kell olvasni es meg "
        "kell valaszolni -- NEM boilerplate no-op, fuggetlenul barmilyen tapado "
        "rendszer-sortol (heartbeat / Continue). Soha ne ejtsd el user-uzenetet a "
        "kornyezoa boilerplate miatt.\n"
        "(b) Cselekves eloatt verifikald a LIVE board / memoria allapotot (ne a "
        "kontextusban levoa elavult pillanatkepet), es nagy UJ munkahoz preferalj "
        "fresh sessiont (/clear), hogy a stale kontextus ne szivarogjon at."
    )


# --- state IO (per-agent) ----------------------------------------------------

def _install_dir():
    # Test override so the state file lands in a tmp dir; production leaves this
    # unset and falls back to the repo root (same convention as hot-cache).
    return os.environ.get("SESSION_ENFORCE_INSTALL_DIR") or ledger_lib._install_dir()


def state_path(install_dir, agent_id):
    return os.path.join(install_dir, "store", "session-enforce", f"{agent_id}.json")


def load_state(path):
    """Read the per-agent state map. Missing / unreadable / malformed -> {} so a
    corrupt file never breaks the hook (fail-open)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_state(path, state):
    """Atomically persist the state map. Best-effort: any error is swallowed so a
    write failure never blocks the prompt."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, path)
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


def transcript_bytes(transcript_path):
    """Size of the session transcript in bytes, or None if it can't be stat'd."""
    if not transcript_path:
        return None
    try:
        return os.path.getsize(transcript_path)
    except Exception:
        return None
