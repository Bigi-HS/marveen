#!/usr/bin/env python3
"""Hibiki health stats -- on-demand computation tool.

Implements STAT-AC1 through STAT-AC4 from the hibiki-health-tracker-extension spec.
All functions read from agents/hibiki/store/ (Hibiki-private, gitignored).
Results are NEVER cached; they are computed fresh each invocation.

SEC-AC4: This script must not write any output to shared memory, daily log,
or inter-agent messages. Invoke it from Hibiki's own session and relay the
result directly to Dominik's Telegram channel.

Usage:
    python3 scripts/hibiki-stats.py weight_trend [--days 30] [--store STORE]
    python3 scripts/hibiki-stats.py dexa_delta [--store STORE]
    python3 scripts/hibiki-stats.py workout_volume [--days 7] [--store STORE]
    python3 scripts/hibiki-stats.py macro_avg [--days 7] [--store STORE]
    python3 scripts/hibiki-stats.py all [--store STORE]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta
from typing import Any

DEFAULT_STORE = os.path.join(
    os.path.dirname(__file__), "..", "agents", "hibiki", "store"
)

MIN_WEIGHT_POINTS = 3

# SEC-AC1 range validation bounds (shared with hibiki-health-write.py)
RANGE_CHECKS: dict[str, tuple[float, float]] = {
    "total_calories": (100, 5000),
    "protein_g": (0, 350),
    "carbs_g": (0, 600),
    "fat_g": (0, 300),
    "fiber_g": (0, 150),
    "body_fat_pct": (5, 60),
    "weight_kg": (30, 250),
    "fat_mass_kg": (2, 150),
    "lean_mass_kg": (20, 120),
    "vat_area_cm2": (0, 400),
    # bone_density is stored as a DEXA T-score (see hibiki-dexa.py: the
    # bone_density_tscore input maps to the stored `bone_density` key).
    # Plausible human T-scores span roughly -4 (severe osteoporosis) to +3.
    "bone_density": (-4.0, 3.0),
}


def load_json(path: str) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------------- #
# STAT-AC1: weight_trend
# Linear regression over weight_log entries within last N days.
# Returns slope (kg/week), last known weight, number of data points.
# --------------------------------------------------------------------------- #
def weight_trend(progress: dict, days: int = 30) -> dict:
    entries = progress.get("weight_log", [])
    cutoff = date.today() - timedelta(days=days)
    pts = [
        (datetime.strptime(e["date"], "%Y-%m-%d").date(), e["kg"])
        for e in entries
        if "date" in e and "kg" in e
        and datetime.strptime(e["date"], "%Y-%m-%d").date() >= cutoff
    ]
    pts.sort(key=lambda x: x[0])

    if len(pts) < MIN_WEIGHT_POINTS:
        return {
            "status": "insufficient_data",
            "points": len(pts),
            "required": MIN_WEIGHT_POINTS,
            "message": (
                f"Csak {len(pts)} mérési pont az utóbbi {days} napban "
                f"(minimum {MIN_WEIGHT_POINTS} szükséges a trendhez)."
            ),
        }

    base_day = pts[0][0]
    xs = [(d - base_day).days for d, _ in pts]
    ys = [kg for _, kg in pts]
    n = len(xs)
    sx = sum(xs)
    sy = sum(ys)
    sxx = sum(x * x for x in xs)
    sxy = sum(x * y for x, y in zip(xs, ys))
    denom = n * sxx - sx * sx
    slope_per_day = (n * sxy - sx * sy) / denom if denom else 0.0
    slope_per_week = slope_per_day * 7

    direction = "csökken" if slope_per_week < -0.05 else ("nő" if slope_per_week > 0.05 else "stagnál")
    return {
        "status": "ok",
        "points": n,
        "window_days": days,
        "first_date": str(pts[0][0]),
        "last_date": str(pts[-1][0]),
        "first_kg": pts[0][1],
        "last_kg": pts[-1][1],
        "slope_kg_per_week": round(slope_per_week, 3),
        "direction": direction,
        "message": (
            f"Súlytrend ({n} pont, {days} nap): "
            f"{pts[0][1]} kg -> {pts[-1][1]} kg, "
            f"{slope_per_week:+.2f} kg/hét ({direction})."
        ),
    }


# --------------------------------------------------------------------------- #
# STAT-AC3: dexa_delta
# Delta between the two most recent DEXA scans.
# --------------------------------------------------------------------------- #
DEXA_FIELDS = ["body_fat_pct", "fat_mass_kg", "lean_mass_kg", "vat_area_cm2"]


def dexa_delta(progress: dict) -> dict:
    scans = progress.get("dexa_results", [])
    scans_sorted = sorted(scans, key=lambda s: s.get("date", ""))

    if len(scans_sorted) == 0:
        return {"status": "no_data", "message": "Nincs DEXA scan az adatbázisban."}

    if len(scans_sorted) == 1:
        s = scans_sorted[0]
        return {
            "status": "baseline_only",
            "scan_date": s.get("date"),
            "baseline": {f: s.get(f) for f in DEXA_FIELDS if f in s},
            "message": (
                f"Csak 1 DEXA scan van ({s.get('date')}). "
                "Delta nem számítható -- szükséges egy második scan."
            ),
        }

    old = scans_sorted[-2]
    new = scans_sorted[-1]
    delta = {}
    for f in DEXA_FIELDS:
        if f in old and f in new and old[f] is not None and new[f] is not None:
            delta[f] = round(new[f] - old[f], 2)

    lines = [f"DEXA delta ({old.get('date')} -> {new.get('date')}):"]
    for f, d in delta.items():
        sign = "+" if d >= 0 else ""
        lines.append(f"  {f}: {sign}{d}")

    return {
        "status": "ok",
        "old_date": old.get("date"),
        "new_date": new.get("date"),
        "old": {f: old.get(f) for f in DEXA_FIELDS},
        "new": {f: new.get(f) for f in DEXA_FIELDS},
        "delta": delta,
        "message": "\n".join(lines),
    }


# --------------------------------------------------------------------------- #
# STAT-AC4: workout_volume
# Total volume per session = sum(sets * reps * load_kg).
# Weekly volume = sum of sessions in window.
# Bodyweight-only exercises (load_kg absent or 0) excluded from volume but
# counted in set/rep totals.
# --------------------------------------------------------------------------- #
def _parse_reps(reps_val: Any) -> float:
    if isinstance(reps_val, (int, float)):
        return float(reps_val)
    if isinstance(reps_val, str):
        s = reps_val.split("/")[0].strip()
        try:
            return float(s)
        except ValueError:
            return 0.0
    return 0.0


def workout_volume(progress: dict, days: int = 7) -> dict:
    logs = progress.get("workout_log", [])
    cutoff = date.today() - timedelta(days=days)
    sessions = [
        e for e in logs
        if "date" in e
        and datetime.strptime(e["date"], "%Y-%m-%d").date() >= cutoff
    ]

    total_volume = 0.0
    total_sets = 0
    session_summaries = []

    for sess in sessions:
        sess_vol = 0.0
        sess_sets = 0
        exercises = sess.get("exercises", [])
        for ex in exercises:
            ex_sets = ex.get("sets", [])
            if isinstance(ex_sets, list):
                for s in ex_sets:
                    if isinstance(s, dict):
                        load = s.get("load_kg", 0)
                        try:
                            load_f = float(load) if load not in (None, "") else 0.0
                        except (ValueError, TypeError):
                            load_f = 0.0
                        reps = _parse_reps(s.get("reps", 0))
                        if load_f > 0:
                            sess_vol += reps * load_f
                        sess_sets += 1
            elif isinstance(ex_sets, int):
                sess_sets += ex_sets

        total_volume += sess_vol
        total_sets += sess_sets
        session_summaries.append({
            "date": sess.get("date"),
            "session": sess.get("session", "?"),
            "volume_kg": round(sess_vol, 1),
            "sets": sess_sets,
        })

    return {
        "status": "ok",
        "window_days": days,
        "sessions": len(sessions),
        "total_volume_kg": round(total_volume, 1),
        "total_sets": total_sets,
        "session_summaries": session_summaries,
        "message": (
            f"Edzésvolumen (utóbbi {days} nap): "
            f"{len(sessions)} session, {round(total_volume, 0):.0f} kg total volume, "
            f"{total_sets} set."
        ),
    }


# --------------------------------------------------------------------------- #
# STAT-AC2: macro_avg
# Rolling average calories + macros over last N logged days.
# --------------------------------------------------------------------------- #
def macro_avg(nutrition_log_path: str, days: int = 7) -> dict:
    if not os.path.exists(nutrition_log_path):
        return {
            "status": "no_data",
            "message": (
                "nutrition_log.json nem létezik még. "
                "Küldd az étkezés appod képernyőképét vagy add meg a makrókat szövegesen."
            ),
        }

    data = load_json(nutrition_log_path)
    entries = data.get("entries", [])
    cutoff = date.today() - timedelta(days=days)
    window = [
        e for e in entries
        if "date" in e
        and datetime.strptime(e["date"], "%Y-%m-%d").date() >= cutoff
    ]

    logged = [e for e in window if e.get("logged", True)]
    vision_count = sum(1 for e in logged if e.get("source") == "vision-confirmed")
    manual_count = sum(1 for e in logged if e.get("source") == "manual")
    n = len(logged)

    if n == 0:
        return {
            "status": "insufficient_data",
            "window_days": days,
            "logged_days": 0,
            "message": f"Nincs naplózott nap az utóbbi {days} napban.",
        }

    def avg(field: str) -> float:
        vals = [e.get(field) for e in logged if e.get(field) is not None]
        return round(sum(vals) / len(vals), 1) if vals else 0.0

    result = {
        "status": "ok",
        "window_days": days,
        "logged_days": n,
        "vision_confirmed_days": vision_count,
        "manual_days": manual_count,
        "avg_calories": avg("total_calories"),
        "avg_protein_g": avg("protein_g"),
        "avg_carbs_g": avg("carbs_g"),
        "avg_fat_g": avg("fat_g"),
    }

    coverage_note = ""
    if n < 4:
        coverage_note = f" (átlag nem reprezentatív: csak {n}/{days} nap naplózva)"

    source_note = f"{manual_count} manuális + {vision_count} vision-confirmed nap"
    result["message"] = (
        f"Makró átlag (utóbbi {n} naplózott nap, {days} napos ablakból):\n"
        f"  Kalória: {result['avg_calories']} kcal/nap\n"
        f"  Fehérje: {result['avg_protein_g']} g\n"
        f"  Szénhidrát: {result['avg_carbs_g']} g\n"
        f"  Zsír: {result['avg_fat_g']} g\n"
        f"  Forrás: {source_note}{coverage_note}"
    )
    return result


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main() -> None:
    parser = argparse.ArgumentParser(description="Hibiki health stats (on-demand)")
    parser.add_argument(
        "command",
        choices=["weight_trend", "dexa_delta", "workout_volume", "macro_avg", "all"],
    )
    parser.add_argument("--store", default=DEFAULT_STORE, help="Path to hibiki store dir")
    parser.add_argument("--days", type=int, default=None, help="Window in days (overrides defaults)")
    args = parser.parse_args()

    store = os.path.abspath(args.store)
    progress_path = os.path.join(store, "hibiki-progress.json")
    nutrition_path = os.path.join(store, "nutrition_log.json")

    if not os.path.exists(progress_path):
        print(f"ERROR: progress file not found: {progress_path}", file=sys.stderr)
        sys.exit(1)

    progress = load_json(progress_path)

    results = {}

    if args.command in ("weight_trend", "all"):
        days = args.days or 30
        results["weight_trend"] = weight_trend(progress, days=days)

    if args.command in ("dexa_delta", "all"):
        results["dexa_delta"] = dexa_delta(progress)

    if args.command in ("workout_volume", "all"):
        days = args.days or 7
        results["workout_volume"] = workout_volume(progress, days=days)

    if args.command in ("macro_avg", "all"):
        days = args.days or 7
        results["macro_avg"] = macro_avg(nutrition_path, days=days)

    for name, r in results.items():
        print(f"\n=== {name} ===")
        print(r.get("message", json.dumps(r, ensure_ascii=False, indent=2)))


if __name__ == "__main__":
    main()
