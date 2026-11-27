#!/usr/bin/env python3
"""Intervals.icu free personal API -> noa.db health_data table.
Nightly 06:30, backfills last 7 days if missing.

Chad SEC conditions (card 09d0ff28, CONDITIONAL PASS):
  C1. Credentials from store/.intervals-config (chmod 0600) -- NEVER .env.
  C2. GET-only. POST/PUT/DELETE FORBIDDEN -- this fetcher only reads personal data.
  C3. GPS/coordinate fields stripped from activities before storage.
      Hibiki queries use explicit column lists (never SELECT *).
"""
import argparse, configparser, json, os, sqlite3, urllib.error, urllib.request
from base64 import b64encode
from datetime import date, timedelta

ROOT    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONF    = os.path.join(ROOT, 'store/.intervals-config')
DB_PATH = os.path.join(ROOT, 'store/noa.db')
BASE    = 'https://intervals.icu/api/v1'

# C3 -- fields stripped from every activity object before any processing or storage.
# Intervals.icu may include map/polyline/latlng/streams in activity JSON.
GPS_KEYS = frozenset({
    'latlng', 'lat_lng', 'start_latlng', 'end_latlng',
    'polyline', 'map', 'coordinates', 'coordinate',
    'gps', 'gps_data', 'streams',
    'altitude', 'altitude_smooth',
    'track', 'route',
})


def _load_credentials():
    """C1: read from store/.intervals-config only. Never from os.environ."""
    cfg = configparser.ConfigParser()
    cfg.read(CONF)
    sec = 'intervals'
    if not cfg.has_section(sec):
        raise RuntimeError(
            f"Missing [{sec}] section in {CONF}.\n"
            "Copy store/.intervals-config.template to store/.intervals-config "
            "and fill in athlete_id + api_key."
        )
    athlete_id = cfg.get(sec, 'athlete_id', fallback='')
    api_key    = cfg.get(sec, 'api_key',    fallback='')
    if not athlete_id or athlete_id.startswith('<') or not api_key or api_key.startswith('<'):
        raise RuntimeError(
            f"Placeholder values still in {CONF} -- fill in real credentials first."
        )
    return athlete_id, api_key


def _auth_header(api_key: str) -> dict:
    # Intervals.icu Basic Auth: username="API_KEY" (literal), password=<your api key>.
    # User-Agent is REQUIRED: default python-urllib UA is blocked by Cloudflare (error 1010).
    token = b64encode(f'API_KEY:{api_key}'.encode()).decode()
    return {'Authorization': f'Basic {token}', 'Accept': 'application/json',
            'User-Agent': 'NoA-Fleet-HealthConnector/1.0 (intervals.icu API client)'}


def _get(url: str, headers: dict) -> object:
    """C2: GET requests only. POST/PUT/DELETE/PATCH are FORBIDDEN in this fetcher."""
    req = urllib.request.Request(url, headers=headers, method='GET')
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def _strip_gps(obj: object) -> object:
    """C3: recursively remove GPS/coordinate fields from any JSON structure."""
    if isinstance(obj, dict):
        return {k: _strip_gps(v) for k, v in obj.items()
                if k.lower() not in GPS_KEYS}
    if isinstance(obj, list):
        return [_strip_gps(item) for item in obj]
    return obj


def _fetch_wellness(athlete_id: str, hdrs: dict, d: str) -> dict:
    url = f'{BASE}/athlete/{athlete_id}/wellness/{d}'
    return _get(url, hdrs)


def _fetch_activities(athlete_id: str, hdrs: dict, d: str) -> list:
    url = f'{BASE}/athlete/{athlete_id}/activities?oldest={d}&newest={d}'
    result = _get(url, hdrs)
    acts = result if isinstance(result, list) else []
    # C3: strip GPS from every activity before anything else touches the data
    return [_strip_gps(a) for a in acts]


def _upsert(cur: sqlite3.Cursor, d: str, w: dict, acts: list):
    sleep_secs = w.get('sleepSecs') or 0
    workouts   = [
        {
            'type':       a.get('type'),
            'duration_s': a.get('moving_time') or a.get('elapsed_time'),
            'calories':   a.get('calories'),
            'distance_m': a.get('distance'),
            'name':       a.get('name'),
        }
        for a in acts if a.get('type')
    ]
    # raw_activities already has GPS stripped (done in _fetch_activities)
    cur.execute("""
        INSERT OR REPLACE INTO health_data
            (date, steps, active_calories, distance_m,
             sleep_hours, sleep_deep_min, sleep_rem_min, sleep_light_min,
             resting_hr, hrv, spo2, readiness, stress, weight_kg,
             workout_count, workouts_json, raw_wellness, raw_activities)
        VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)
    """, (
        d,
        w.get('steps'),
        w.get('activeCalories'),
        w.get('distance'),
        sleep_secs / 3600 if sleep_secs else None,
        (w.get('sleepDeepSecs')  or 0) // 60 or None,
        (w.get('sleepRemSecs')   or 0) // 60 or None,
        (w.get('sleepLightSecs') or 0) // 60 or None,
        w.get('restingHR'),
        w.get('hrv'),
        w.get('spO2'),
        w.get('readiness'),
        w.get('stress'),
        w.get('weight'),
        len(acts),
        json.dumps(workouts),
        json.dumps(w),
        json.dumps(acts),
    ))


def _date_range(today: date, since: date | None, days: int) -> list[str]:
    """Return ISO dates oldest-first from since (or today-days+1) through today."""
    start = since if since is not None else (today - timedelta(days=days - 1))
    n = (today - start).days + 1
    return [(start + timedelta(days=i)).isoformat() for i in range(n)]


def run(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Fetch Intervals.icu wellness/activity data into noa.db health_data."
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        '--since', metavar='YYYY-MM-DD',
        help='fetch from this date through today (backfill mode)',
    )
    group.add_argument(
        '--days', type=int, default=7,
        help='fetch last N days (default: 7, used by nightly cron)',
    )
    args = parser.parse_args(argv)

    today = date.today()
    if args.since:
        try:
            since = date.fromisoformat(args.since)
        except ValueError:
            parser.error(f"--since must be YYYY-MM-DD, got: {args.since}")
        if since > today:
            parser.error(f"--since {since} is in the future")
        dates = _date_range(today, since, args.days)
    else:
        dates = _date_range(today, None, args.days)

    athlete_id, api_key = _load_credentials()
    hdrs = _auth_header(api_key)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    cur  = conn.cursor()

    fetched, skipped, errors = 0, 0, 0
    for d in dates:
        is_today = (d == today.isoformat())
        cur.execute("SELECT 1 FROM health_data WHERE date=?", (d,))
        if cur.fetchone() and not is_today:
            skipped += 1
            continue  # already stored; always refresh today
        try:
            w    = _fetch_wellness(athlete_id, hdrs, d)
            acts = _fetch_activities(athlete_id, hdrs, d)
            _upsert(cur, d, w, acts)
            fetched += 1
            print(f"OK   {d}: steps={w.get('steps')}, HR={w.get('restingHR')}, "
                  f"HRV={w.get('hrv')}, sleep={round((w.get('sleepSecs') or 0)/3600, 1)}h, "
                  f"workouts={len(acts)}")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                skipped += 1
                print(f"SKIP {d}: no data yet (404)")
            else:
                errors += 1
                print(f"ERR  {d}: HTTP {e.code}")
        except Exception as e:
            errors += 1
            print(f"ERR  {d}: {e}")

    conn.commit()
    conn.close()
    print(f"\nSummary: fetched={fetched}, skipped={skipped}, errors={errors} "
          f"(range: {dates[0]} .. {dates[-1]}, {len(dates)} days)")


if __name__ == '__main__':
    run()
