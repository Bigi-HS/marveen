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


def try_minutes_of_day(hhmm: str) -> int | None:
    """Lenient minutes_of_day: returns None instead of raising for anything that is
    not a valid 'HH:MM' (symbolic intake phases like 'morning'/'pre_workout', empty,
    out of range, or a non-string). Card 9bf34f76: the live supplement inventory uses
    symbolic phases, and a single bad time must NOT crash the whole daily push -- it is
    skipped instead. Clock-based timing (overview sort, 'due now' reminders) is only
    meaningful for HH:MM, so a phase that cannot be placed on the clock is dropped."""
    try:
        return minutes_of_day(hhmm)
    except (ValueError, AttributeError, TypeError):
        return None


def find_today_session(plan: dict, d: date) -> dict | None:
    """Return the session object for `d`'s weekday, or None if not present."""
    target = weekday_name(d)
    for s in plan.get("weekly_sessions", []):
        if s.get("day") == target:
            return s
    return None


def supplement_due_today(entry: dict, d: date) -> list[str]:
    """Raw intake `time` values scheduled for `d` for one supplement entry, honouring
    days='daily' | a weekday-abbrev list. Legacy helper kept for direct callers/tests;
    the push pipeline uses resolved_supplement_intakes (which also resolves symbolic
    phases and handles 'training_days_only')."""
    out: list[str] = []
    today = weekday_name(d)
    for slot in entry.get("intake_schedule", []):
        days = slot.get("days", "daily")
        if days == "daily" or (isinstance(days, list) and today[:3] in days):
            t = slot.get("time")
            if t:
                out.append(t)
    return out


# --------------------------------------------------------------------------- #
# Symbolic intake-phase resolver (card 4db2faed)
# --------------------------------------------------------------------------- #
# The live inventory expresses intake timing as SYMBOLIC phases (morning /
# pre_workout / intra_workout / post_workout / pre_meal / evening), not 'HH:MM'.
# Supplement timing is event-relative, not absolute clock time, so the phases are
# intentional, not a data bug. This resolver maps each phase to concrete clock
# time(s) for today so the overview can sort and reminders can fire. Canonical
# values per Hibiki's domain spec (2026-06-14). An explicit 'HH:MM' time passes
# through unchanged (back-compat with any literal-time entry).
FIXED_PHASE_TIME = {
    "morning": "07:30",   # before the first meal
    "evening": "21:30",   # ~45-60 min before sleep
}
# `timing` values that shift a morning slot off the 07:30 default (data-driven, so
# no supplement name is hard-coded): with_meal (Asztaxantin) and max_13:00
# (L-Carnitine / Green Tea, which are also training-days-only) -> 08:00.
MORNING_TIMING_OVERRIDE = {
    "with_meal": "08:00",
    "max_13:00": "08:00",
}
PRE_MEAL_TIMES = ("07:30", "12:30", "18:30")  # 30 min before breakfast / lunch / dinner


def is_training_day(session: dict | None) -> bool:
    """True when today has a real (non-rest) training session."""
    return bool(session) and session.get("session_type") != "rest"


def _format_minutes(m: int) -> str | None:
    """minutes-since-midnight -> 'HH:MM', or None if it falls outside a single day."""
    return f"{m // 60:02d}:{m % 60:02d}" if 0 <= m < 24 * 60 else None


def anchor_to_session(session: dict | None, offset_min: int) -> str | None:
    """A workout-phase time = the day's session scheduled_time + offset_min. Returns
    None when there is no usable session time, so the caller SKIPS rather than firing
    a reminder at a guessed time (spec: never a false reminder on an uncertain time)."""
    if not session:
        return None
    base = try_minutes_of_day(session.get("scheduled_time"))
    if base is None:
        return None
    return _format_minutes(base + offset_min)


def resolve_intake_times(phase, timing: str | None, session: dict | None) -> list[str]:
    """Symbolic intake phase -> concrete 'HH:MM' time(s) for today. Returns [] when the
    slot cannot be placed on the clock: an unknown phase, or a workout phase with no
    usable session time (no training today / scheduled_time missing)."""
    # An explicit clock time passes through unchanged.
    if try_minutes_of_day(phase) is not None:
        return [phase]
    if phase == "pre_workout":
        t = anchor_to_session(session, -30)
        return [t] if t else []
    if phase == "intra_workout":
        t = anchor_to_session(session, 0)
        return [t] if t else []
    if phase == "post_workout":
        dur = session.get("duration_min") if session else None
        if not isinstance(dur, (int, float)):
            return []
        t = anchor_to_session(session, int(dur))
        return [t] if t else []
    if phase == "pre_meal":
        return list(PRE_MEAL_TIMES)
    if phase == "morning":
        return [MORNING_TIMING_OVERRIDE.get(timing or "", FIXED_PHASE_TIME["morning"])]
    if phase == "evening":
        return [FIXED_PHASE_TIME["evening"]]
    return []


def slot_due_today(slot: dict, d: date, session: dict | None) -> bool:
    """Whether one intake slot applies today: days='daily' | 'training_days_only' (only
    on a real training day) | a weekday-abbrev list."""
    days = slot.get("days", "daily")
    if days == "daily":
        return True
    if days == "training_days_only":
        return is_training_day(session)
    if isinstance(days, list):
        return weekday_name(d)[:3] in days
    return False


def intake_skip_reason(phase, session: dict | None) -> str:
    """Why a slot that IS due today still resolved to no time -- so the skip is explicit
    and auditable, never a silent nothing (DA-HIGH, the original-incident class)."""
    if phase in ("pre_workout", "intra_workout", "post_workout"):
        # Due (training day) but the workout time could not be anchored.
        return "null_session_anchor"
    return "unknown_phase"


def resolved_supplement_intakes(supplements: list[dict], d: date, session: dict | None) -> list[tuple[str, str]]:
    """All (name, resolved 'HH:MM') intakes due today, after day gating + phase
    resolution. A multi-time phase (pre_meal) expands to one pair per time.

    A slot that is NOT due today (day gate) is normal flow and silently dropped. A slot
    that IS due today but cannot be placed on the clock (unknown phase, or a workout
    phase with no usable session time) is an ABNORMAL skip: it is reason-tagged and
    logged (count only, no names) so it can never become a silent should-have-fired."""
    out: list[tuple[str, str]] = []
    skips: dict[str, int] = {}
    for entry in supplements:
        name = entry.get("name", "?")
        for slot in entry.get("intake_schedule", []):
            if not slot_due_today(slot, d, session):
                continue   # normal day gate (rest day / wrong weekday) -- not a concern
            phase = slot.get("time")
            times = resolve_intake_times(phase, slot.get("timing"), session)
            if not times:
                reason = intake_skip_reason(phase, session)
                skips[reason] = skips.get(reason, 0) + 1
                continue
            for t in times:
                out.append((name, t))
    if skips:
        # Privacy (C-AC3): reasons + counts only, never a supplement name or value.
        log.warning("resolver: %d due intake(s) could not be placed on the clock, by reason: %s",
                    sum(skips.values()), dict(sorted(skips.items())))
    return out


def today_supplement_overview(supplements: list[dict], d: date, session: dict | None = None) -> list[tuple[str, str]]:
    """(name, resolved 'HH:MM') pairs scheduled today, sorted by time then name. No
    dosage anywhere. Symbolic phases are resolved via resolve_intake_times; `session`
    (today's plan session, or None) supplies the workout-phase anchor + training-day gate."""
    pairs = resolved_supplement_intakes(supplements, d, session)
    pairs.sort(key=lambda p: (minutes_of_day(p[1]), p[0]))
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


def build_reminder_message(names: list[str], signature: str) -> str:
    """Timed intake reminder for one resolved time: the supplement name(s) due then,
    'time to take' only -- no dosage (B-AC3). Multiple supplements that resolve to the
    same time are listed together (collision bucketing, card 4db2faed)."""
    listed = ", ".join(names)
    return append_signature(f"Emlekezteto: ideje bevenni -- {listed}.", signature)


def build_plan_error_message(signature: str) -> str:
    return append_signature(
        "A mai edzesterv nem elerheto (hianyzik vagy serult). Kezi ellenorzes szukseges.",
        signature,
    )


def due_actions(now: datetime, plan: dict | None, supplements: list[dict], config: dict, sent: set[str]) -> list[dict]:
    """Decide what to send this tick. Pure: returns action dicts, no IO.

    Each action: {key, kind, build:callable(signature)->str}. `key` dedupes against
    `sent`. No supplement name enters `key`/`kind`/the summary -- only the reminder
    TEXT (built on demand, sent to Hibiki's own channel) names them.

    Times are Europe/Budapest WALL-CLOCK: `now` is the local time the caller passes,
    the resolved phase times (07:30/...) and the plan scheduled_time are wall-clock,
    and all comparisons are plain minute-of-day arithmetic -- no UTC conversion, so a
    DST transition shifts nothing (a 07:30 reminder fires at local 07:30 either side).
    """
    d = now.date()
    now_min = now.hour * 60 + now.minute
    actions: list[dict] = []
    # Today's session (or None) -- the anchor for workout phases + the training-day
    # gate. Computed once so reminders see it even before the session-push time.
    session = find_today_session(plan, d) if plan else None

    # 1. Daily session / rest push at (or after) the configured push time, once.
    push_min = minutes_of_day(config.get("session_push_time", DEFAULT_SESSION_PUSH_TIME))
    if now_min >= push_min and "session" not in sent:
        if plan is None:
            # Shares the "session" dedup key with the real session/rest push: the
            # daily-delivery event fires once per day, so a missing/corrupt plan
            # alerts once -- never re-fires every tick (would spam Telegram).
            actions.append({"key": "session", "kind": "plan-error",
                            "build": build_plan_error_message})
        else:
            nutrition = plan.get("nutrition_targets", {})
            supp_enabled = config.get("supplement_push_enabled", True)
            overview = today_supplement_overview(supplements, d, session) if supp_enabled else []
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

    # 2. Timed intake reminders: bucket every intake due today by its RESOLVED time, so
    # a single reminder per time lists all supplements due then (collision decision,
    # card 4db2faed). Names within a bucket are sorted for deterministic text.
    # Skipped entirely when supplement_push_enabled=false in push-config.json.
    tol = int(config.get("reminder_tolerance_min", DEFAULT_REMINDER_TOLERANCE_MIN))
    buckets: dict[str, list[str]] = {}
    if config.get("supplement_push_enabled", True):
        for name, t in resolved_supplement_intakes(supplements, d, session):
            buckets.setdefault(t, []).append(name)
    for t in sorted(buckets):
        key = f"supp:{t}"
        if key in sent:
            continue
        if abs(now_min - minutes_of_day(t)) <= tol:
            names = sorted(buckets[t])
            actions.append({"key": key, "kind": "reminder",
                            "build": lambda sig, ns=names: build_reminder_message(ns, sig)})
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
        # 0600 for store-file consistency: the dedup keys carry supplement names,
        # so keep the state file owner-only like the rest of the private store.
        # 0600 for store-file consistency with the rest of the private store. The
        # dedup keys are now name-free (session / supp:HH:MM), so the file no longer
        # carries supplement names, but keep it owner-only regardless.
        os.chmod(tmp, 0o600)
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
