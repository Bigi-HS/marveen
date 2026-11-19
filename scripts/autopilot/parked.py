#!/usr/bin/env python3
"""Centralized `parked_until` column check for autopilot classification.

Single source of truth for whether a kanban card is parked RIGHT NOW by the
structured `parked_until` column -- an explicit time-commitment that suppresses
driving regardless of the card's status, age, or free-text awaiting-marker.

Root cause this fixes (card da838ff2 / 05c1671f): classify.py honored only the
free-text awaiting-marker (+ age windows) and the boss_waiting flag, but never
read the `parked_until` column. A card with parked_until=FUTURE but a stale
last_moved was still surfaced as MINE (owner view) or NUDGEABLE (orchestrator
view) -> repeated 15-min false-TICK_DRIVE churn. The column must park the card
on EVERY tick surface (MINE, NUDGEABLE, stale-count), and must fall through to
normal classification once `now` passes parked_until (re-triage), so parking is
never permanent.
"""
from __future__ import annotations

# `parked_until` is stored as epoch SECONDS in the live DB (e.g. 1797289200 =
# 2026-12-15), though an older design note (build-v2-db-design-xlsx.py) labelled
# the column "epoch ms". Be unit-tolerant: any value at/above this threshold is
# treated as milliseconds and divided down. 1e12 seconds is ~year 33658, so no
# real seconds-epoch reaches it, while any plausible ms-epoch (>= ~2001) does.
_MS_THRESHOLD = 1_000_000_000_000  # 1e12


def _coerce_epoch_seconds(value):
    """Return `value` as epoch seconds (float), or None if empty/unparseable.

    Accepts seconds or milliseconds (auto-detected) and numeric strings.
    Zero / negative / non-numeric -> None (treated as "no park").
    """
    if value is None or value == "":
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    if v >= _MS_THRESHOLD:
        v = v / 1000.0
    return v


def parked_until_active(card: dict, now: float) -> bool:
    """True iff `card` carries a parked_until strictly in the future vs `now`.

    `now` is epoch seconds. Absent / zero / past / unparseable parked_until ->
    False (the card is not parked by this column and falls through to normal
    classification).
    """
    pu = _coerce_epoch_seconds(card.get("parked_until"))
    if pu is None:
        return False
    return pu > now
