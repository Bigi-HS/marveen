#!/usr/bin/env python3
"""Hibiki token-free daily push.

Deterministic, NON-LLM daily push for the Hibiki personal-trainer agent. Reads
the pre-generated structured training plan + supplement inventory from Hibiki's
private store and pushes today's session and timed intake reminders to Hibiki's
own Telegram channel -- WITHOUT a running Claude session (spec B-AC2).

Designed to be invoked every few minutes by a system cron entry (or a
fleet-supervisor watchdog-pattern daemon), NOT by ~/.claude/scheduled-tasks/
(those only fire inside a live Claude session). Each tick decides what, if
anything, is due now and sends it once (a per-day state file dedupes).

Dependencies: Python 3 standard library only (json, urllib, datetime, ...), so
the push never needs an LLM call and never imports a third-party package.

Privacy (spec C-AC3 / F-AC3): supplement names and any health data are NEVER
written to stdout/stderr. Logs report counts and opaque keys only. The private
store lives under agents/hibiki/store/ (gitignored).

Signature (spec G-AC1): the closing signature phrase is loaded from a single
file (signature.txt). Until Dominik/Genesis confirm it, the file holds a
placeholder and this script REFUSES to send a live push -- the deploy blocker is
enforced in code, not just in the spec.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime

log = logging.getLogger("hibiki-push")

WEEKDAYS = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]

DEFAULT_SESSION_PUSH_TIME = "06:30"
DEFAULT_REMINDER_TOLERANCE_MIN = 5
PLACEHOLDER_MARK = "PLACEHOLDER"


# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #
def store_paths(store_root: str) -> dict[str, str]:
    """Resolve the private-store file paths under `store_root`."""
    return {
        "plans_dir": os.path.join(store_root, "plans"),
        "supplements": os.path.join(store_root, "hibiki-supplements.json"),
        "progress": os.path.join(store_root, "hibiki-progress.json"),
        "config": os.path.join(store_root, "push-config.json"),
        "signature": os.path.join(store_root, "signature.txt"),
    }


def plan_path(store_root: str, week_key: str) -> str:
    return os.path.join(store_root, "plans", f"hibiki-plan-{week_key}.json")


def state_path(store_root: str, d: date) -> str:
    return os.path.join(store_root, f".push-state-{d.isoformat()}.json")


# --------------------------------------------------------------------------- #
# Pure logic (no IO -- unit tested directly)
# --------------------------------------------------------------------------- #
def iso_week_key(d: date) -> str:
    """ISO-8601 week key, e.g. date(2026, 6, 8) -> '2026-W24'."""
    iso = d.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def weekday_name(d: date) -> str:
    return WEEKDAYS[d.weekday()]


def minutes_of_day(hhmm: str) -> int:
    """'HH:MM' -> minutes since midnight. Raises ValueError on bad input."""
    h, m = hhmm.strip().split(":")
    hi, mi = int(h), int(m)
    if not (0 <= hi < 24 and 0 <= mi < 60):
        raise ValueError(f"time out of range: {hhmm!r}")
    return hi * 60 + mi


def find_today_session(plan: dict, d: date) -> dict | None:
    """Return the session object for `d`'s weekday, or None if not present."""
    target = weekday_name(d)
    for s in plan.get("weekly_sessions", []):
        if s.get("day") == target:
            return s
    return None


def supplement_due_today(entry: dict, d: date) -> list[str]:
    """Intake times ('HH:MM') scheduled for `d` for one supplement entry."""
    out: list[str] = []
    today = weekday_name(d)
    for slot in entry.get("intake_schedule", []):
        days = slot.get("days", "daily")
        if days == "daily" or (isinstance(days, list) and today[:3] in days):
            t = slot.get("time")
            if t:
                out.append(t)
    return out


def today_supplement_overview(supplements: list[dict], d: date) -> list[tuple[str, str]]:
    """(name, time) pairs scheduled today, sorted by time. No dosage anywhere."""
    pairs: list[tuple[str, str]] = []
    for entry in supplements:
        name = entry.get("name", "?")
        for t in supplement_due_today(entry, d):
            pairs.append((name, t))
    pairs.sort(key=lambda p: minutes_of_day(p[1]))
    return pairs


def append_signature(body: str, signature: str) -> str:
    sig = (signature or "").strip()
    return f"{body}\n\n{sig}" if sig else body


def build_session_message(session: dict, nutrition: dict, supp_overview: list[tuple[str, str]], signature: str) -> str:
    """Full training-day push: session + nutrition target + today's intake agenda."""
    lines: list[str] = []
    day = session.get("day", "").capitalize()
    deload = " (deload)" if session.get("deload") else ""
    lines.append(f"Edzes ma -- {day}{deload}")
    dur = session.get("duration_min")
    if dur:
        lines.append(f"Idotartam: ~{dur} perc")
    for ex in session.get("exercises", []):
        name = ex.get("name", "?")
        scheme = ex.get("load_scheme")
        sets = ex.get("sets")
        reps = ex.get("reps_or_duration")
        parts = [name]
        if sets is not None and reps is not None:
            parts.append(f"{sets}x{reps}")
        if scheme:
            parts.append(f"@ {scheme}")
        lines.append("  - " + " ".join(str(p) for p in parts))
        notes = ex.get("notes")
        if notes:
            lines.append(f"      {notes}")
    cues = session.get("form_cues") or []
    if cues:
        lines.append("Forma-cue: " + "; ".join(str(c) for c in cues))
    if nutrition:
        cal = nutrition.get("calories")
        prot = nutrition.get("protein_g")
        if cal is not None or prot is not None:
            lines.append(f"Taplalkozasi cel: {cal} kcal / {prot} g feherje")
    if supp_overview:
        agenda = ", ".join(f"{n} ({t})" for n, t in supp_overview)
        lines.append(f"Mai bevitel-terv: {agenda}")
    return append_signature("\n".join(lines), signature)


def build_rest_message(session: dict, supp_overview: list[tuple[str, str]], signature: str) -> str:
    """Rest / active-recovery day: short, no exercise list (spec B-AC4)."""
    day = session.get("day", "").capitalize()
    lines = [f"Pihenonap ma -- {day}. Aktiv regeneracio, nincs eros edzes."]
    notes = session.get("notes")
    if notes:
        lines.append(str(notes))
    if supp_overview:
        agenda = ", ".join(f"{n} ({t})" for n, t in supp_overview)
        lines.append(f"Mai bevitel-terv: {agenda}")
    return append_signature("\n".join(lines), signature)


def build_reminder_message(name: str, signature: str) -> str:
    """Single timed intake reminder: name + 'time to take' only. No dosage (B-AC3)."""
    return append_signature(f"Emlekezteto: ideje bevenni -- {name}.", signature)


def build_plan_error_message(signature: str) -> str:
    return append_signature(
        "A mai edzesterv nem elerheto (hianyzik vagy serult). Kezi ellenorzes szukseges.",
        signature,
    )


def due_actions(now: datetime, plan: dict | None, supplements: list[dict], config: dict, sent: set[str]) -> list[dict]:
    """Decide what to send this tick. Pure: returns action dicts, no IO.

    Each action: {key, kind, name?, build:callable(signature)->str}. `key` dedupes
    against `sent`. `name` (supplement) is carried for the private state file only,
    never logged.
    """
    d = now.date()
    now_min = now.hour * 60 + now.minute
    actions: list[dict] = []

    # 1. Daily session / rest push at (or after) the configured push time, once.
    push_min = minutes_of_day(config.get("session_push_time", DEFAULT_SESSION_PUSH_TIME))
    if now_min >= push_min and "session" not in sent:
        if plan is None:
            actions.append({"key": "plan-error", "kind": "plan-error",
                            "build": build_plan_error_message})
        else:
            session = find_today_session(plan, d)
            nutrition = plan.get("nutrition_targets", {})
            overview = today_supplement_overview(supplements, d)
            if session is None:
                # No session entry for today -> treat as rest.
                actions.append({"key": "session", "kind": "rest",
                                "build": lambda sig: build_rest_message({"day": weekday_name(d)}, overview, sig)})
            elif session.get("session_type") == "rest":
                actions.append({"key": "session", "kind": "rest",
                                "build": lambda sig, s=session: build_rest_message(s, overview, sig)})
            else:
                actions.append({"key": "session", "kind": "session",
                                "build": lambda sig, s=session: build_session_message(s, nutrition, overview, sig)})

    # 2. Timed intake reminders: fire within tolerance of each scheduled time, once.
    tol = int(config.get("reminder_tolerance_min", DEFAULT_REMINDER_TOLERANCE_MIN))
    for entry in supplements:
        name = entry.get("name", "?")
        for t in supplement_due_today(entry, d):
            key = f"supp:{name}:{t}"
            if key in sent:
                continue
            if abs(now_min - minutes_of_day(t)) <= tol:
                actions.append({"key": key, "kind": "reminder", "name": name,
                                "build": lambda sig, n=name: build_reminder_message(n, sig)})
    return actions


def signature_is_placeholder(signature: str | None) -> bool:
    s = (signature or "").strip()
    return (not s) or (PLACEHOLDER_MARK.lower() in s.lower())


# --------------------------------------------------------------------------- #
# IO (thin wrappers; integration-tested via tmp dirs / injected sender)
# --------------------------------------------------------------------------- #
def load_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except (json.JSONDecodeError, OSError):
        return None  # present-but-corrupt: caller distinguishes from missing


def load_signature(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def load_token(env_path: str) -> str | None:
    """Read TELEGRAM_BOT_TOKEN from the agent's channel .env. Never logged."""
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("TELEGRAM_BOT_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        return None
    return None


def load_state(store_root: str, d: date) -> set[str]:
    data = load_json(state_path(store_root, d), {"sent": []})
    if not data:
        return set()
    return set(data.get("sent", []))


def save_state(store_root: str, d: date, sent: set[str]) -> None:
    path = state_path(store_root, d)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"sent": sorted(sent)}, fh)
        os.replace(tmp, path)
    except OSError as exc:
        log.warning("could not persist push state: %s", exc.__class__.__name__)


def telegram_sender(token: str, chat_id):
    """Build a real Telegram sendMessage callable. The token is captured in the
    closure and never logged."""
    url = f"https://api.telegram.org/bot{token}/sendMessage"

    def _send(text: str) -> bool:
        payload = json.dumps({"chat_id": chat_id, "text": text}).encode("utf-8")
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return 200 <= resp.status < 300
        except (urllib.error.URLError, OSError) as exc:
            log.warning("telegram send failed: %s", exc.__class__.__name__)
            return False

    return _send


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def run(now: datetime, store_root: str, sender, dry_run: bool = False) -> dict:
    """Execute one tick. `sender(text)->bool` is injected (real one in main()).

    Returns a summary dict (counts + kinds) that is safe to log -- it carries no
    supplement names or health data.
    """
    paths = store_paths(store_root)
    d = now.date()
    signature = load_signature(paths["signature"])

    if signature_is_placeholder(signature) and not dry_run:
        log.warning("signature not configured (G-AC1 deploy blocker) -- push suppressed")
        return {"suppressed": "signature-placeholder", "sent": 0, "kinds": []}

    config = load_json(paths["config"], {}) or {}
    supplements = load_json(paths["supplements"], []) or []
    raw_plan = load_json(plan_path(store_root, iso_week_key(d)), "MISSING")
    plan = None if raw_plan in ("MISSING", None) else raw_plan

    sent = load_state(store_root, d)
    actions = due_actions(now, plan, supplements, config, sent)

    sent_count = 0
    kinds: list[str] = []
    for act in actions:
        text = act["build"](signature)
        ok = True if dry_run else sender(text)
        if ok:
            sent.add(act["key"])
            sent_count += 1
            kinds.append(act["kind"])
        else:
            log.warning("send failed for kind=%s (will retry next tick)", act["kind"])

    if sent_count and not dry_run:
        save_state(store_root, d, sent)

    summary = {"sent": sent_count, "kinds": kinds, "dry_run": dry_run}
    log.info("tick %s: sent=%d kinds=%s", now.strftime("%Y-%m-%d %H:%M"), sent_count, kinds)
    return summary


def default_store_root() -> str:
    # repo_root/agents/hibiki/store
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)
    return os.path.join(repo_root, "agents", "hibiki", "store")


def channel_env_path(store_root: str) -> str:
    # agents/hibiki/store -> agents/hibiki/.claude/channels/telegram/.env
    agent_dir = os.path.dirname(store_root)
    return os.path.join(agent_dir, ".claude", "channels", "telegram", ".env")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hibiki token-free daily push (NON-LLM).")
    parser.add_argument("--store-root", default=None, help="override the private store path")
    parser.add_argument("--now", default=None, help="ISO datetime override (for testing)")
    parser.add_argument("--dry-run", action="store_true", help="build messages, do not send")
    parser.add_argument("--quiet", action="store_true", help="warnings only")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    store_root = args.store_root or default_store_root()
    now = datetime.fromisoformat(args.now) if args.now else datetime.now()

    if args.dry_run:
        summary = run(now, store_root, sender=lambda _t: True, dry_run=True)
        print(json.dumps(summary))
        return 0

    config = load_json(store_paths(store_root)["config"], {}) or {}
    chat_id = config.get("chat_id") or os.environ.get("HIBIKI_CHAT_ID")
    token = load_token(channel_env_path(store_root))
    if not token or not chat_id:
        log.error("missing telegram token or chat_id -- cannot push (provisioning incomplete)")
        return 2

    summary = run(now, store_root, sender=telegram_sender(token, chat_id), dry_run=False)
    return 0 if "suppressed" not in summary else 0


if __name__ == "__main__":
    sys.exit(main())
