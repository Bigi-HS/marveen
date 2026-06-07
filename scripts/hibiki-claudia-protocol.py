#!/usr/bin/env python3
"""Hibiki <-> Claudia scheduling-coordination protocol (spec D-AC1..D-AC3).

Hibiki never writes to Dominik's Google Calendar directly. When it generates a
weekly plan it proposes session slots to Claudia (the PA agent, which owns the
calendar); Claudia confirms or rejects each slot and Hibiki folds the confirmed
times back into the stored plan (D-AC1). Rejected days are re-proposed from the
day's remaining free windows, or flagged to Dominik -- never silently dropped
(D-AC2).

This module is the wire contract + validator for that exchange (D-AC3). It is
pure-stdlib, side-effect-free (no IO, no network), so the inter-agent transport
stays the caller's concern and the protocol logic is unit-tested directly.

Privacy (spec F-AC3): a Claudia-bound message must carry ONLY scheduling fields.
`scan_for_health_data` rejects any payload that smuggles supplement / DEXA /
weight / nutrition data into a schedule message, so the validator enforces the
privacy boundary in code, not just in review.
"""

from __future__ import annotations

WEEKDAYS = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]

# Rest days are not placed on the calendar -- only working sessions are proposed.
SCHEDULABLE_SESSION_TYPES = {"strength", "mobility", "cardio"}
ALL_SESSION_TYPES = SCHEDULABLE_SESSION_TYPES | {"rest"}

# Required fields per message shape (additional benign fields are allowed by the
# spec; health fields are blocked separately by scan_for_health_data).
REQUEST_SLOT_REQUIRED = ("day", "preferred_time", "duration_min", "session_type")
CONFIRM_SLOT_REQUIRED = ("day", "confirmed_time")
REJECT_SLOT_REQUIRED = ("day", "reason")

# Substrings that mark a key as health/personal data (F-AC3). Matched
# case-insensitively against every key anywhere in a schedule payload.
HEALTH_KEY_MARKERS = (
    "supplement", "dosage", "dose", "intake", "dexa", "body_fat", "bodyfat",
    "lean_mass", "leanmass", "bone_density", "weight", "calorie", "protein",
    "nutrition", "macro", "form_feedback", "progress", "rpe", "rir",
)


# --------------------------------------------------------------------------- #
# Small time helpers (kept local so this module has zero internal deps)
# --------------------------------------------------------------------------- #
def minutes_of_day(hhmm: str) -> int:
    """'HH:MM' -> minutes since midnight. Raises ValueError on bad input."""
    h, m = str(hhmm).strip().split(":")
    hi, mi = int(h), int(m)
    if not (0 <= hi < 24 and 0 <= mi < 60):
        raise ValueError(f"time out of range: {hhmm!r}")
    return hi * 60 + mi


def valid_time(hhmm) -> bool:
    try:
        minutes_of_day(hhmm)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def parse_window(window: str) -> tuple[int, int] | None:
    """'06:00-09:00' -> (360, 540), or None if malformed/inverted."""
    try:
        lo_s, hi_s = str(window).split("-")
        lo, hi = minutes_of_day(lo_s), minutes_of_day(hi_s)
    except (ValueError, AttributeError):
        return None
    return (lo, hi) if lo < hi else None


# --------------------------------------------------------------------------- #
# Privacy guard (F-AC3)
# --------------------------------------------------------------------------- #
def scan_for_health_data(payload, _path: str = "") -> list[str]:
    """Return the key-paths of any health/personal data found in `payload`.

    Recurses dicts/lists. A Claudia-bound message must produce an empty list.
    """
    hits: list[str] = []
    if isinstance(payload, dict):
        for key, val in payload.items():
            low = str(key).lower()
            here = f"{_path}.{key}" if _path else str(key)
            if any(marker in low for marker in HEALTH_KEY_MARKERS):
                hits.append(here)
            hits.extend(scan_for_health_data(val, here))
    elif isinstance(payload, list):
        for i, item in enumerate(payload):
            hits.extend(scan_for_health_data(item, f"{_path}[{i}]"))
    return hits


# --------------------------------------------------------------------------- #
# Validators -- each returns a list of human-readable error strings ([] == ok)
# --------------------------------------------------------------------------- #
def _validate_slot(slot, idx: int, required: tuple, errors: list[str]) -> None:
    if not isinstance(slot, dict):
        errors.append(f"sessions[{idx}] must be an object")
        return
    for field in required:
        if field not in slot:
            errors.append(f"sessions[{idx}] missing required field '{field}'")
    day = slot.get("day")
    if day is not None and day not in WEEKDAYS:
        errors.append(f"sessions[{idx}].day '{day}' is not a weekday")


def validate_schedule_request(msg) -> list[str]:
    """Validate a hibiki->claudia schedule_request (D-AC3)."""
    errors: list[str] = []
    if not isinstance(msg, dict):
        return ["message must be an object"]
    if msg.get("type") != "schedule_request":
        errors.append("type must be 'schedule_request'")
    if msg.get("from") != "hibiki":
        errors.append("from must be 'hibiki'")
    if not msg.get("week"):
        errors.append("missing required field 'week'")
    sessions = msg.get("sessions")
    if not isinstance(sessions, list) or not sessions:
        errors.append("sessions must be a non-empty array")
        sessions = []
    for i, slot in enumerate(sessions):
        _validate_slot(slot, i, REQUEST_SLOT_REQUIRED, errors)
        if isinstance(slot, dict):
            pt = slot.get("preferred_time")
            if pt is not None and not valid_time(pt):
                errors.append(f"sessions[{i}].preferred_time '{pt}' is not HH:MM")
            st = slot.get("session_type")
            if st is not None and st not in SCHEDULABLE_SESSION_TYPES:
                errors.append(
                    f"sessions[{i}].session_type '{st}' is not schedulable "
                    f"(rest days are not placed on the calendar)")
            dm = slot.get("duration_min")
            if dm is not None and (not isinstance(dm, int) or dm <= 0):
                errors.append(f"sessions[{i}].duration_min must be a positive integer")
            win = slot.get("flexibility_window")
            if win is not None and parse_window(win) is None:
                errors.append(f"sessions[{i}].flexibility_window '{win}' is malformed")
    # F-AC3: scheduling messages must not carry health data.
    for hit in scan_for_health_data(msg):
        errors.append(f"health data not allowed in a schedule message: '{hit}'")
    return errors


def validate_schedule_confirmation(msg) -> list[str]:
    """Validate a claudia->hibiki schedule_confirmation (D-AC3)."""
    errors: list[str] = []
    if not isinstance(msg, dict):
        return ["message must be an object"]
    if msg.get("type") != "schedule_confirmation":
        errors.append("type must be 'schedule_confirmation'")
    if msg.get("from") != "claudia":
        errors.append("from must be 'claudia'")
    confirmed = msg.get("sessions", [])
    rejected = msg.get("rejected", [])
    if not isinstance(confirmed, list):
        errors.append("sessions must be an array")
        confirmed = []
    if not isinstance(rejected, list):
        errors.append("rejected must be an array")
        rejected = []
    if not confirmed and not rejected:
        errors.append("confirmation must contain at least one confirmed or rejected slot")
    for i, slot in enumerate(confirmed):
        _validate_slot(slot, i, CONFIRM_SLOT_REQUIRED, errors)
        if isinstance(slot, dict):
            ct = slot.get("confirmed_time")
            if ct is not None and not valid_time(ct):
                errors.append(f"sessions[{i}].confirmed_time '{ct}' is not HH:MM")
    for i, slot in enumerate(rejected):
        if not isinstance(slot, dict):
            errors.append(f"rejected[{i}] must be an object")
            continue
        for field in REJECT_SLOT_REQUIRED:
            if field not in slot:
                errors.append(f"rejected[{i}] missing required field '{field}'")
        if slot.get("day") is not None and slot["day"] not in WEEKDAYS:
            errors.append(f"rejected[{i}].day '{slot['day']}' is not a weekday")
    for hit in scan_for_health_data(msg):
        errors.append(f"health data not allowed in a schedule message: '{hit}'")
    return errors


# --------------------------------------------------------------------------- #
# Transforms -- build a request from a plan, fold a confirmation back in
# --------------------------------------------------------------------------- #
def build_schedule_request(plan: dict, week_key: str) -> dict:
    """Extract schedulable (non-rest) sessions from a plan into a request (D-AC1).

    Only scheduling fields are copied -- no nutrition/exercise/health data leaks.
    """
    sessions = []
    for s in plan.get("weekly_sessions", []):
        st = s.get("session_type")
        if st not in SCHEDULABLE_SESSION_TYPES:
            continue
        slot = {
            "day": s.get("day"),
            "preferred_time": s.get("scheduled_time") or s.get("preferred_time"),
            "duration_min": s.get("duration_min"),
            "session_type": st,
        }
        win = s.get("flexibility_window")
        if win:
            slot["flexibility_window"] = win
        sessions.append(slot)
    return {"type": "schedule_request", "from": "hibiki",
            "week": week_key, "sessions": sessions}


def apply_confirmation(plan: dict, confirmation: dict) -> dict:
    """Fold Claudia's confirmation into the plan (D-AC1) and report rejections.

    Returns {plan, confirmed_days, rejected, finalized}:
      - confirmed slots write scheduled_time (+ calendar_event_id) onto the
        matching session;
      - rejected days are returned for re-proposal (D-AC2);
      - finalized is True only when every schedulable session got a confirmed
        time (spec: the plan is not finalized until Claudia confirms).
    The input plan is not mutated; a shallow-copied plan is returned.
    """
    sessions = [dict(s) for s in plan.get("weekly_sessions", [])]
    by_day = {s.get("day"): s for s in sessions}

    confirmed_days = []
    for slot in confirmation.get("sessions", []):
        day = slot.get("day")
        target = by_day.get(day)
        if target is None:
            continue
        target["scheduled_time"] = slot.get("confirmed_time")
        if slot.get("calendar_event_id"):
            target["calendar_event_id"] = slot["calendar_event_id"]
        confirmed_days.append(day)

    rejected = [
        {"day": r.get("day"), "reason": r.get("reason")}
        for r in confirmation.get("rejected", [])
    ]

    new_plan = dict(plan)
    new_plan["weekly_sessions"] = sessions

    schedulable = [s for s in sessions if s.get("session_type") in SCHEDULABLE_SESSION_TYPES]
    finalized = bool(schedulable) and all(s.get("scheduled_time") for s in schedulable)

    return {"plan": new_plan, "confirmed_days": confirmed_days,
            "rejected": rejected, "finalized": finalized}


def propose_alternative(session: dict, busy_windows: list[str]) -> dict | None:
    """Pick the earliest start inside the session's flexibility window that does
    not overlap a busy window (D-AC2). `busy_windows` are the day's already-taken
    windows to avoid. Returns a request slot, or None if no free slot fits -- the
    caller then flags 'no slot available' to Dominik.
    """
    win = parse_window(session.get("flexibility_window", ""))
    dur = session.get("duration_min")
    if win is None or not isinstance(dur, int) or dur <= 0:
        return None
    lo, hi = win
    busy = sorted(filter(None, (parse_window(w) for w in busy_windows)))
    start = lo
    while start + dur <= hi:
        end = start + dur
        clash = next((b for b in busy if b[0] < end and start < b[1]), None)
        if clash is None:
            return {
                "day": session.get("day"),
                "preferred_time": f"{start // 60:02d}:{start % 60:02d}",
                "duration_min": dur,
                "session_type": session.get("session_type"),
                "flexibility_window": session.get("flexibility_window"),
            }
        start = clash[1]  # jump past the conflicting event and retry
    return None


def reconcile_rejections(plan: dict, rejected: list[dict],
                         busy_windows: dict[str, list[str]]) -> dict:
    """For each rejected day build a follow-up proposal or a no-slot flag (D-AC2).

    `busy_windows[day]` lists the day's already-taken windows (existing calendar
    events to avoid). Returns {reproposal, no_slot}: a second schedule_request
    for days that found an alternative, plus the days that must be surfaced to
    Dominik.
    """
    by_day = {s.get("day"): s for s in plan.get("weekly_sessions", [])}
    reproposed, no_slot = [], []
    for rej in rejected:
        day = rej.get("day")
        session = by_day.get(day)
        if session is None:
            continue
        alt = propose_alternative(session, busy_windows.get(day, []))
        if alt is not None:
            reproposed.append(alt)
        else:
            no_slot.append({"day": day, "reason": rej.get("reason")})
    reproposal = None
    if reproposed:
        reproposal = {"type": "schedule_request", "from": "hibiki",
                      "week": plan.get("plan_id") or plan.get("week"),
                      "sessions": reproposed}
    return {"reproposal": reproposal, "no_slot": no_slot}
