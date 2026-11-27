#!/usr/bin/env python3
"""Migration: create health_data table in noa.db.
GPS columns intentionally absent (Chad SEC condition C3, card 09d0ff28).
Idempotent: safe to run multiple times (CREATE TABLE IF NOT EXISTS).
"""
import argparse, sqlite3
from pathlib import Path

_HERE         = Path(__file__).resolve().parent          # scripts/migration/
_PROJECT_ROOT = _HERE.parent.parent                      # scripts/ -> repo root
_DB_DEFAULT   = _PROJECT_ROOT / 'store' / 'noa.db'

DDL = """
CREATE TABLE IF NOT EXISTS health_data (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT    NOT NULL UNIQUE,
    source          TEXT    DEFAULT 'intervals-icu',
    -- Activity
    steps           INTEGER,
    active_calories INTEGER,
    distance_m      INTEGER,
    -- Sleep
    sleep_hours     REAL,
    sleep_deep_min  INTEGER,
    sleep_rem_min   INTEGER,
    sleep_light_min INTEGER,
    -- Cardiac / Recovery
    resting_hr      INTEGER,
    hrv             INTEGER,
    spo2            REAL,
    readiness       INTEGER,
    stress          INTEGER,
    -- Body composition (optional, from smart scale via Intervals.icu)
    weight_kg       REAL,
    -- Workouts -- GPS NOT stored per Chad C3
    workout_count   INTEGER,
    workouts_json   TEXT,
    -- Audit
    fetched_at      INTEGER DEFAULT (unixepoch()),
    -- Raw blobs (GPS already stripped by fetcher before insert, per Chad C3)
    raw_wellness    TEXT,
    raw_activities  TEXT
);

CREATE INDEX IF NOT EXISTS idx_health_date ON health_data(date);
"""


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create health_data table in noa.db (idempotent)."
    )
    parser.add_argument(
        '--db', type=Path, default=_DB_DEFAULT,
        help=f'path to noa.db (default: {_DB_DEFAULT})',
    )
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(DDL)
    conn.commit()

    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='health_data'")
    assert cur.fetchone(), "health_data table not created"
    cur.execute("PRAGMA table_info(health_data)")
    cols = [row[1] for row in cur.fetchall()]
    gps_found = [c for c in cols if any(g in c.lower()
                 for g in ('lat', 'lng', 'gps', 'coord', 'poly', 'track', 'route'))]
    assert not gps_found, f"GPS columns found (must not be): {gps_found}"
    print(f"OK: health_data created in {args.db}, {len(cols)} columns, GPS assertion PASS")
    conn.close()


if __name__ == '__main__':
    main()
