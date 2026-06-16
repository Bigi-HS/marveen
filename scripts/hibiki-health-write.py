#!/usr/bin/env python3
"""Hibiki health store write helper.

Enforces the security ACs from hibiki-health-tracker-extension spec:
  SEC-AC1: range validation before any write
  SEC-AC3: source field (manual | vision-confirmed) required on every entry
  SEC-AC4b: store files created/opened with mode 0600 (owner read/write only)

Usage:
    python3 scripts/hibiki-health-write.py nutrition \
        --date 2026-06-15 --calories 1723 --protein 181 --carbs 104 --fat 65 \
        --fiber 8 --source manual [--notes "edzésnap"] [--store STORE]

    python3 scripts/hibiki-health-write.py adherence \
        --date 2026-06-15 --source manual \
        --taken "Omega-3:08:00,Vitamin D:08:00" \
        --skipped "Berberine::forgot pre-lunch" \
        [--store STORE]

    python3 scripts/hibiki-health-write.py init-store [--store STORE]

SEC-AC4: This script MUST NOT be called from a context that pipes output to
shared memory, inter-agent messages, or the daily log. Call it from Hibiki's
own session only; relay results via Hibiki's Telegram channel.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from datetime import date
from typing import Any

# SEC-AC1 range validation bounds (keep in sync with hibiki-stats.py RANGE_CHECKS)
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

DEFAULT_STORE = os.path.join(
    os.path.dirname(__file__), "..", "agents", "hibiki", "store"
)

VALID_SOURCES = {"manual", "vision-confirmed"}
MODE_0600 = stat.S_IRUSR | stat.S_IWUSR


def _open_store_file(path: str) -> Any:
    """Read a store JSON file, creating it with 0600 if absent."""
    if not os.path.exists(path):
        _write_store_file(path, {"entries": []})
    return _read_json(path)


def _read_json(path: str) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _write_store_file(path: str, data: Any) -> None:
    """Write JSON to path, enforcing 0600 permissions (SEC-AC4b)."""
    dir_ = os.path.dirname(path)
    if dir_:
        os.makedirs(dir_, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, MODE_0600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    # Ensure 0600 even if the file existed before us
    os.chmod(path, MODE_0600)


def validate_ranges(values: dict[str, float]) -> list[str]:
    """Return list of error messages for out-of-range fields (SEC-AC1)."""
    errors = []
    for field, val in values.items():
        if field in RANGE_CHECKS:
            lo, hi = RANGE_CHECKS[field]
            if not (lo <= val <= hi):
                errors.append(
                    f"{field}={val} is out of range [{lo}, {hi}]"
                )
    return errors


# --------------------------------------------------------------------------- #
# Nutrition log write (NUT-AC1, NUT-AC2)
# --------------------------------------------------------------------------- #
def write_nutrition(
    store: str,
    date_str: str,
    calories: float,
    protein: float,
    carbs: float,
    fat: float,
    fiber: float | None,
    source: str,
    notes: str | None = None,
) -> None:
    if source not in VALID_SOURCES:
        print(f"ERROR: source must be one of {VALID_SOURCES}, got {source!r}", file=sys.stderr)
        sys.exit(1)

    values = {
        "total_calories": calories,
        "protein_g": protein,
        "carbs_g": carbs,
        "fat_g": fat,
    }
    if fiber is not None:
        values["fiber_g"] = fiber

    errors = validate_ranges(values)
    if errors:
        print("ERROR: range validation failed (SEC-AC1):", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        sys.exit(1)

    path = os.path.join(store, "nutrition_log.json")
    data = _open_store_file(path)
    entries = data.get("entries", [])

    # NUT-AC1: one entry per date; update if exists
    existing = next((i for i, e in enumerate(entries) if e.get("date") == date_str), None)
    entry: dict[str, Any] = {
        "date": date_str,
        "logged": True,
        "total_calories": calories,
        "protein_g": protein,
        "carbs_g": carbs,
        "fat_g": fat,
        "source": source,
    }
    if fiber is not None:
        entry["fiber_g"] = fiber
    if notes:
        entry["notes"] = notes

    if existing is not None:
        old_cal = entries[existing].get("total_calories")
        if old_cal is not None and abs(old_cal - calories) > 300:
            print(
                f"WARNING: replacing existing entry for {date_str} -- "
                f"calorie difference is large ({old_cal} -> {calories}). "
                "Verify this is intentional.",
                file=sys.stderr,
            )
        entries[existing] = entry
    else:
        entries.append(entry)

    data["entries"] = sorted(entries, key=lambda e: e.get("date", ""))
    _write_store_file(path, data)
    print(f"OK: nutrition entry written for {date_str} ({calories} kcal, {protein}g P, source={source})")


# --------------------------------------------------------------------------- #
# Supplement adherence write (ADH-AC1, ADH-AC2)
# --------------------------------------------------------------------------- #
def write_adherence(
    store: str,
    date_str: str,
    source: str,
    taken: list[dict],
    skipped: list[dict],
    supplement_names: set[str],
) -> None:
    if source not in VALID_SOURCES:
        print(f"ERROR: source must be one of {VALID_SOURCES}, got {source!r}", file=sys.stderr)
        sys.exit(1)

    supplements = []
    for item in taken:
        name = item["name"]
        if name not in supplement_names:
            print(
                f"ERROR: supplement {name!r} not in hibiki-supplements.json -- "
                "add it to the schedule first (ADH-AC1).",
                file=sys.stderr,
            )
            sys.exit(1)
        entry: dict[str, Any] = {"name": name, "taken": True}
        if item.get("time"):
            entry["time_taken"] = item["time"]
        entry["notes"] = item.get("notes")
        supplements.append(entry)

    for item in skipped:
        name = item["name"]
        if name not in supplement_names:
            print(
                f"ERROR: supplement {name!r} not in hibiki-supplements.json.",
                file=sys.stderr,
            )
            sys.exit(1)
        supplements.append({
            "name": name,
            "taken": False,
            "notes": item.get("notes"),
        })

    path = os.path.join(store, "supplement_adherence_log.json")
    data = _open_store_file(path)
    entries = data.get("entries", [])

    # ADH-AC1: one entry per date; update overwrites supplements array
    existing = next((i for i, e in enumerate(entries) if e.get("date") == date_str), None)
    day_entry = {
        "date": date_str,
        "supplements": supplements,
        "source": source,
    }
    if existing is not None:
        entries[existing] = day_entry
    else:
        entries.append(day_entry)

    data["entries"] = sorted(entries, key=lambda e: e.get("date", ""))
    _write_store_file(path, data)
    taken_names = [s["name"] for s in supplements if s["taken"]]
    skipped_names = [s["name"] for s in supplements if not s["taken"]]
    print(f"OK: adherence entry written for {date_str} -- taken: {taken_names}, skipped: {skipped_names}")


def load_supplement_names(store: str) -> set[str]:
    path = os.path.join(store, "hibiki-supplements.json")
    if not os.path.exists(path):
        return set()
    data = _read_json(path)
    supps = data if isinstance(data, list) else data.get("supplements", [])
    return {s["name"] for s in supps if "name" in s}


def write_dexa(
    store: str,
    date_str: str,
    body_fat_pct: float,
    fat_mass_kg: float,
    lean_mass_kg: float,
    vat_area_cm2: float | None,
    bone_density: float | None,
    source: str,
    notes: str | None = None,
) -> None:
    """Write a DEXA scan result to hibiki-progress.json (SEC-AC1/3 enforced)."""
    if source not in VALID_SOURCES:
        print(f"ERROR: source must be one of {VALID_SOURCES}, got {source!r}", file=sys.stderr)
        sys.exit(1)

    values: dict[str, float] = {
        "body_fat_pct": body_fat_pct,
        "fat_mass_kg": fat_mass_kg,
        "lean_mass_kg": lean_mass_kg,
    }
    if vat_area_cm2 is not None:
        values["vat_area_cm2"] = vat_area_cm2
    if bone_density is not None:
        values["bone_density"] = bone_density

    errors = validate_ranges(values)
    if errors:
        print("ERROR: range validation failed (SEC-AC1):", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        sys.exit(1)

    path = os.path.join(store, "hibiki-progress.json")
    data = _read_json(path)
    scans = data.get("dexa_results", [])

    entry: dict[str, Any] = {
        "date": date_str,
        "body_fat_pct": body_fat_pct,
        "fat_mass_kg": fat_mass_kg,
        "lean_mass_kg": lean_mass_kg,
        "source": source,
    }
    if vat_area_cm2 is not None:
        entry["vat_area_cm2"] = vat_area_cm2
    if bone_density is not None:
        entry["bone_density"] = bone_density
    if notes:
        entry["notes"] = notes

    existing = next((i for i, e in enumerate(scans) if e.get("date") == date_str), None)
    if existing is not None:
        scans[existing] = entry
    else:
        scans.append(entry)

    data["dexa_results"] = sorted(scans, key=lambda e: e.get("date", ""))
    _write_store_file(path, data)
    print(
        f"OK: DEXA entry written for {date_str} "
        f"(body_fat_pct={body_fat_pct}%, fat={fat_mass_kg}kg, lean={lean_mass_kg}kg, source={source})"
    )


def write_nutrition_not_logged(store: str, date_str: str) -> None:
    """Write a logged:false sentinel for a day with no food log (NUT-AC1).

    Distinct from a missing entry: missing = unknown; logged:false = confirmed no-log day.
    Trend functions count this as a denominator gap day, not an excluded unknown.

    Aborts with sys.exit(1) if an existing logged:true entry would be silently overwritten.
    """
    path = os.path.join(store, "nutrition_log.json")
    data = _open_store_file(path)
    entries = data.get("entries", [])

    existing_idx = next((i for i, e in enumerate(entries) if e.get("date") == date_str), None)
    if existing_idx is not None:
        existing = entries[existing_idx]
        if existing.get("logged", True):
            kcal = existing.get("total_calories", "?")
            src = existing.get("source", "?")
            print(
                f"ERROR: a logged:true entry already exists for {date_str} "
                f"({kcal} kcal, source={src}). "
                "Writing a not-logged sentinel would permanently delete this data. "
                "Delete the existing entry manually first if this is intentional.",
                file=sys.stderr,
            )
            sys.exit(1)

    sentinel: dict[str, Any] = {"date": date_str, "logged": False}
    if existing_idx is not None:
        entries[existing_idx] = sentinel
    else:
        entries.append(sentinel)

    data["entries"] = sorted(entries, key=lambda e: e.get("date", ""))
    _write_store_file(path, data)
    print(f"OK: logged:false sentinel written for {date_str} (confirmed no-log day)")


def init_store(store: str) -> None:
    """Create empty store files with 0600 if they don't exist (SEC-AC4b)."""
    for filename in ("nutrition_log.json", "supplement_adherence_log.json"):
        path = os.path.join(store, filename)
        if not os.path.exists(path):
            _write_store_file(path, {"entries": []})
            print(f"Created: {path} (mode 0600)")
        else:
            os.chmod(path, MODE_0600)
            print(f"Exists:  {path} (permissions enforced)")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _parse_taken(s: str) -> list[dict]:
    """Parse 'Name:HH:MM,Name2:HH:MM' into list of dicts.

    Split on the FIRST colon only so HH:MM stays intact.
    """
    result = []
    for part in s.split(","):
        halves = part.strip().split(":", 1)
        name = halves[0].strip()
        if not name:
            continue
        time_ = halves[1].strip() if len(halves) > 1 else None
        result.append({"name": name, "time": time_ or None, "notes": None})
    return result


def _parse_skipped(s: str) -> list[dict]:
    """Parse 'Name::notes,Name2' into list of dicts."""
    result = []
    for part in s.split(","):
        parts = part.strip().split("::")
        name = parts[0].strip()
        if not name:
            continue
        notes = parts[1].strip() if len(parts) > 1 else None
        result.append({"name": name, "notes": notes})
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Hibiki health store write helper")
    sub = parser.add_subparsers(dest="cmd")

    # nutrition subcommand
    n = sub.add_parser("nutrition", help="Write a nutrition log entry (NUT-AC2)")
    n.add_argument("--date", default=str(date.today()))
    n.add_argument("--calories", type=float, required=True)
    n.add_argument("--protein", type=float, required=True)
    n.add_argument("--carbs", type=float, required=True)
    n.add_argument("--fat", type=float, required=True)
    n.add_argument("--fiber", type=float, default=None)
    n.add_argument("--source", required=True, choices=list(VALID_SOURCES))
    n.add_argument("--notes", default=None)
    n.add_argument("--store", default=DEFAULT_STORE)

    # adherence subcommand
    a = sub.add_parser("adherence", help="Write supplement adherence entry (ADH-AC2)")
    a.add_argument("--date", default=str(date.today()))
    a.add_argument("--source", required=True, choices=list(VALID_SOURCES))
    a.add_argument("--taken", default="", help="'Name:HH:MM,Name2:HH:MM'")
    a.add_argument("--skipped", default="", help="'Name::reason,Name2'")
    a.add_argument("--store", default=DEFAULT_STORE)

    # not-logged subcommand
    nl = sub.add_parser("not-logged", help="Write logged:false sentinel (NUT-AC1 confirmed no-log day)")
    nl.add_argument("--date", default=str(date.today()))
    nl.add_argument("--store", default=DEFAULT_STORE)

    # dexa subcommand
    d = sub.add_parser("dexa", help="Write DEXA scan result to progress store (SEC-AC1/3)")
    d.add_argument("--date", default=str(date.today()))
    d.add_argument("--body-fat-pct", type=float, required=True)
    d.add_argument("--fat-mass-kg", type=float, required=True)
    d.add_argument("--lean-mass-kg", type=float, required=True)
    d.add_argument("--vat-area-cm2", type=float, default=None)
    d.add_argument("--bone-density", type=float, default=None)
    d.add_argument("--source", required=True, choices=list(VALID_SOURCES))
    d.add_argument("--notes", default=None)
    d.add_argument("--store", default=DEFAULT_STORE)

    # init-store subcommand
    i = sub.add_parser("init-store", help="Create store files with 0600 (SEC-AC4b)")
    i.add_argument("--store", default=DEFAULT_STORE)

    args = parser.parse_args()

    if args.cmd == "nutrition":
        write_nutrition(
            store=os.path.abspath(args.store),
            date_str=args.date,
            calories=args.calories,
            protein=args.protein,
            carbs=args.carbs,
            fat=args.fat,
            fiber=args.fiber,
            source=args.source,
            notes=args.notes,
        )
    elif args.cmd == "adherence":
        store = os.path.abspath(args.store)
        taken = _parse_taken(args.taken) if args.taken else []
        skipped = _parse_skipped(args.skipped) if args.skipped else []
        names = load_supplement_names(store)
        write_adherence(
            store=store,
            date_str=args.date,
            source=args.source,
            taken=taken,
            skipped=skipped,
            supplement_names=names,
        )
    elif args.cmd == "not-logged":
        write_nutrition_not_logged(
            store=os.path.abspath(args.store),
            date_str=args.date,
        )
    elif args.cmd == "dexa":
        write_dexa(
            store=os.path.abspath(args.store),
            date_str=args.date,
            body_fat_pct=args.body_fat_pct,
            fat_mass_kg=args.fat_mass_kg,
            lean_mass_kg=args.lean_mass_kg,
            vat_area_cm2=args.vat_area_cm2,
            bone_density=args.bone_density,
            source=args.source,
            notes=args.notes,
        )
    elif args.cmd == "init-store":
        init_store(os.path.abspath(args.store))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
