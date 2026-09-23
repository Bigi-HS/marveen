#!/usr/bin/env python3
"""Hibiki manual-vision Zepp nap writer (WELL-4b2e63fe).

Writes a properly formed ZeppDailySnapshot JSON for a day where Boss manually
read 3 numbers from the Zepp Balance app (HRV ms + resting HR bpm + net sleep
min). Sets `date` (not `_date`) and `sourceSyncedAt` = ISO write-time so the
freshness route sees a non-null sync timestamp and does not emit a
"latest data never" alert for a day that is actually fresh.

CRITICAL: sourceSyncedAt = write-time, NOT the data date. A manual entry
written today for today's numbers must read as "synced now", not "synced at
midnight of the data day" -- that would make a same-day write read as 0h stale,
but a write 12h later for the same data day would read as 12h stale and
incorrectly trigger the 8h alert. Write-time is the right clock.

Usage (from marveen project root):
    python3 scripts/write-manual-vision-day.py \\
        --date 2026-09-23 --hrv 45 --resting-hr 58 --sleep-min 434

Optional args:
    --sleep-end-at   ISO UTC timestamp (e.g. 2026-09-23T06:00:00Z)
    --workouts       JSON array string of workout objects (default: [])
    --dry-run        Print what would be written without touching the filesystem
    --store          Override store directory (default: store/zepp)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def is_valid_date(s: str) -> bool:
    return bool(DATE_RE.match(s))


def _write_zepp_file(path: str, data: dict) -> None:
    """Atomic write, 0600 permissions -- mirrors ZeppIngestStore.write() semantics."""
    dir_ = os.path.dirname(path)
    if dir_:
        os.makedirs(dir_, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def build_snapshot(
    date: str,
    hrv: float,
    resting_hr: float,
    sleep_min: int,
    sleep_end_at: str | None,
    workouts: list,
    write_time_iso: str,
) -> dict:
    """Construct a ZeppDailySnapshot dict with canonical field names.

    date is set from the parameter (authoritative), NOT from any _date key.
    sourceSyncedAt is the write-time clock (see module docstring).
    """
    snap: dict = {
        "date": date,
        "pulledAt": write_time_iso,
        "status": "ok",
        "sourceSyncedAt": write_time_iso,
        "vitals": {
            "hrv": hrv,
            "restingHr": resting_hr,
        },
        "sleep": {
            "durationMin": sleep_min,
            "startAt": f"{date}T22:00:00Z",
            "endAt": sleep_end_at or f"{date}T06:00:00Z",
        },
        "workouts": workouts,
    }
    return snap


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Write a manual-vision Zepp daily snapshot (WELL-4b2e63fe)"
    )
    parser.add_argument("--date", required=True, help="YYYY-MM-DD data date")
    parser.add_argument("--hrv", type=float, required=True, help="HRV ms (RMSSD)")
    parser.add_argument("--resting-hr", type=float, required=True, help="Resting HR bpm")
    parser.add_argument("--sleep-min", type=int, required=True, help="Net sleep minutes")
    parser.add_argument(
        "--sleep-end-at",
        default=None,
        help="Sleep wake time ISO UTC (e.g. 2026-09-23T06:00:00Z)",
    )
    parser.add_argument(
        "--workouts",
        default="[]",
        help="JSON array of workout objects (default: [])",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print without writing")
    parser.add_argument(
        "--store",
        default=os.path.join(os.getcwd(), "store", "zepp"),
        help="Zepp store directory (default: store/zepp relative to CWD)",
    )
    args = parser.parse_args()

    # Validate date (mirrors ZeppIngestStore.isValidDate)
    if not is_valid_date(args.date):
        print(
            f"ERROR: date must be strict YYYY-MM-DD, got {args.date!r}", file=sys.stderr
        )
        sys.exit(1)

    # Parse workouts
    try:
        workouts = json.loads(args.workouts)
        if not isinstance(workouts, list):
            raise ValueError("must be a JSON array")
    except (json.JSONDecodeError, ValueError) as e:
        print(f"ERROR: --workouts must be a valid JSON array: {e}", file=sys.stderr)
        sys.exit(1)

    write_time_iso = datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")

    snap = build_snapshot(
        date=args.date,
        hrv=args.hrv,
        resting_hr=args.resting_hr,
        sleep_min=args.sleep_min,
        sleep_end_at=args.sleep_end_at,
        workouts=workouts,
        write_time_iso=write_time_iso,
    )

    if args.dry_run:
        print(json.dumps(snap, indent=2))
        print(f"\n[dry-run] would write to: {os.path.join(args.store, f'daily-{args.date}.json')}")
        return

    path = os.path.join(args.store, f"daily-{args.date}.json")
    _write_zepp_file(path, snap)
    print(
        f"OK: {path} written (date={args.date}, sourceSyncedAt={write_time_iso}, "
        f"hrv={args.hrv}, restingHr={args.resting_hr}, sleepMin={args.sleep_min})"
    )


if __name__ == "__main__":
    main()
