#!/usr/bin/env python3
"""Intervals.icu health completeness watchdog.

Replaces the lost scripts/intervals-health-watchdog.py (referenced in memory,
never committed to disk). The nightly/intraday fetcher now re-fetches INCOMPLETE
days (any core field NULL) within its lookback window, so a late-finalizing field
(HRV) fills in automatically once upstream catches up. This watchdog is the other
half: it catches a GENUINE stuck sync -- a past day where even the early-finalizing
core fields (resting_hr AND sleep_hours) never arrived.

Stuck definition (deliberately conservative to avoid false alarms):
  A day is STUCK iff BOTH resting_hr AND sleep_hours are NULL
  AND the day is OLDER than the finalization window (~36h).
We do NOT alarm on today/yesterday still filling in (data-latency is normal),
and we do NOT alarm on HRV-only gaps (HRV legitimately finalizes days later and
the fetcher handles that by re-fetching). Only a day where the EARLY core fields
are both still absent well past finalization indicates the sync itself is stuck.

On a genuine stuck state: send ONE inter-agent message to marveen and exit 1.
Otherwise: silent, exit 0. Idempotent / read-only against noa.db.
"""
import json
import os
import sqlite3
import sys
import urllib.request
from datetime import date, datetime, timedelta

ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH    = os.path.join(ROOT, 'store/noa.db')
TOKEN_PATH = os.path.join(ROOT, 'store/.dashboard-token')
MESSAGES_URL = 'http://localhost:3420/api/messages'

# How many days back to inspect.
LOOKBACK_DAYS = 7
# Days newer than this are STILL FILLING IN (normal upstream latency) -> never
# flagged. 36h means today and yesterday are always exempt; a day two or more
# days old with both early core fields missing is a genuine stuck sync.
FINALIZATION_HOURS = 36


def _load_token() -> str:
    with open(TOKEN_PATH) as f:
        return f.read().strip()


def _stuck_days(conn: sqlite3.Connection, today: date, now: datetime) -> list[str]:
    """Return ISO dates (oldest-first) that look like a genuinely stuck sync:
    both resting_hr AND sleep_hours NULL AND the day finalized > FINALIZATION_HOURS ago."""
    cutoff = now - timedelta(hours=FINALIZATION_HOURS)
    start  = today - timedelta(days=LOOKBACK_DAYS - 1)
    cur = conn.cursor()
    cur.execute(
        "SELECT date, resting_hr, sleep_hours FROM health_data "
        "WHERE date >= ? AND date <= ? ORDER BY date ASC",
        (start.isoformat(), today.isoformat()),
    )
    stuck = []
    for d, resting_hr, sleep_hours in cur.fetchall():
        try:
            day = date.fromisoformat(d)
        except (ValueError, TypeError):
            continue
        # A day's data is considered final at END of that day; measure age from
        # the start of the following day so "yesterday" is still within the
        # finalization window until ~36h have elapsed.
        finalized_at = datetime(day.year, day.month, day.day) + timedelta(days=1)
        if finalized_at > cutoff:
            continue  # still inside the finalization window -> normal, not stuck
        if resting_hr is None and sleep_hours is None:
            stuck.append(d)
    return stuck


def _alert_marveen(stuck: list[str]) -> None:
    token = _load_token()
    days = ', '.join(stuck)
    content = (
        "ALERT: intervals.icu health sync looks STUCK. "
        f"These finalized days have NO resting_hr AND NO sleep_hours in health_data: {days}. "
        "The intraday/nightly fetcher re-fetches incomplete days automatically, so a day this "
        "old with both early core fields still missing means the upstream sync (watch/intervals.icu) "
        "is not delivering. Check the tracker sync + store/.intervals-config credentials. "
        "(HRV-only gaps are NOT flagged -- they finalize late and the fetcher fills them.)"
    )
    payload = json.dumps({
        "from": "marveen",
        "to": "marveen",
        "content": content,
    }).encode()
    req = urllib.request.Request(
        MESSAGES_URL,
        data=payload,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)


def main() -> None:
    if not os.path.exists(DB_PATH):
        # No DB -> nothing to watch. Stay silent (do not alarm on infra absence).
        sys.exit(0)
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        conn.execute("PRAGMA query_only=ON")
        stuck = _stuck_days(conn, date.today(), datetime.now())
    finally:
        conn.close()

    if not stuck:
        sys.exit(0)  # silent healthy path

    try:
        _alert_marveen(stuck)
    except Exception as e:  # noqa: BLE001 -- best-effort alert; still exit 1 to signal stuck
        print(f"WARNING: could not send stuck-sync alert: {e}", file=sys.stderr)
    print(f"STUCK: intervals.icu health sync stuck on {len(stuck)} day(s): {', '.join(stuck)}")
    sys.exit(1)


if __name__ == "__main__":
    main()
