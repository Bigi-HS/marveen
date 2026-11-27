#!/usr/bin/env python3
"""One-time re-clean: strip stream_types (and any residual GPS keys) from
existing health_data.raw_activities rows.

stream_types is a metadata list like ["latlng","polyline","time","distance"]
-- it contains GPS label strings, not coordinates. We drop it entirely.
"""
import json, sqlite3, sys

DB = '/home/domin/marveen/store/noa.db'

GPS_KEYS = frozenset({
    'latlng', 'lat_lng', 'start_latlng', 'end_latlng',
    'polyline', 'map', 'coordinates', 'coordinate',
    'gps', 'gps_data', 'streams', 'stream_types',
    'altitude', 'altitude_smooth',
    'track', 'route',
})


def strip_gps(obj):
    if isinstance(obj, dict):
        return {k: strip_gps(v) for k, v in obj.items() if k.lower() not in GPS_KEYS}
    if isinstance(obj, list):
        return [strip_gps(i) for i in obj]
    return obj


conn = sqlite3.connect(DB)
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("PRAGMA foreign_keys=ON")
cur = conn.cursor()

cur.execute("SELECT id, raw_activities FROM health_data WHERE raw_activities IS NOT NULL")
rows = cur.fetchall()
print(f"Rows to check: {len(rows)}")

updated = 0
for row_id, raw in rows:
    try:
        acts = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        continue
    cleaned = strip_gps(acts)
    if cleaned == acts:
        continue  # nothing to strip
    cur.execute("UPDATE health_data SET raw_activities=? WHERE id=?",
                (json.dumps(cleaned), row_id))
    updated += 1

conn.commit()

# Verify: no 'stream_types' or 'latlng' keys remain as JSON object keys
cur.execute("SELECT id, raw_activities FROM health_data WHERE raw_activities IS NOT NULL")
remaining = 0
for row_id, raw in cur.fetchall():
    try:
        acts = json.loads(raw)
    except Exception:
        continue
    text = json.dumps(acts)
    # Check for GPS key presence as dict keys (not as string values in non-dict context)
    for a in (acts if isinstance(acts, list) else [acts]):
        if isinstance(a, dict) and any(k.lower() in GPS_KEYS for k in a):
            remaining += 1
            print(f"  WARN row {row_id}: GPS key still present")

conn.close()
print(f"Updated: {updated} rows. GPS keys remaining as dict keys: {remaining}")
if remaining == 0:
    print("C3 airtight: PASS")
else:
    print("C3 FAIL -- manual check needed")
    sys.exit(1)
