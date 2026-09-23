#!/usr/bin/env python3
"""One-time repair for WELL-66e35b2c: rename _date -> date in hibiki hand-build snapshots.

Run once after deploying the ingest-store.ts reader-side fix. The reader already
normalises _date at read-time, so this script is data-hygiene only (raw consumers
and future migrations see a canonical file). Safe to re-run: idempotent.

Usage: python3 scripts/_well-66e35b2c-repair-date-field.py [--dry-run]
"""
import json, os, sys, glob, re

DRY_RUN = '--dry-run' in sys.argv
# Run from the marveen project root (where store/ lives). The script resolves
# the store path relative to CWD so it works regardless of worktree layout.
STORE = os.path.join(os.getcwd(), 'store', 'zepp')
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

repaired, skipped = 0, 0
for path in sorted(glob.glob(os.path.join(STORE, 'daily-*.json'))):
    fname = os.path.basename(path)
    # Extract canonical date from filename (authoritative key, validated by store)
    m = re.match(r'^daily-(\d{4}-\d{2}-\d{2})\.json$', fname)
    if not m:
        continue
    canonical_date = m.group(1)
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception as e:
        print(f'SKIP (parse error) {fname}: {e}', file=sys.stderr)
        skipped += 1
        continue

    valid_date = isinstance(data.get('date'), str) and bool(DATE_RE.match(data.get('date', '')))
    if valid_date:
        skipped += 1
        continue

    # Repair: set date from filename, remove _date
    data['date'] = canonical_date
    data.pop('_date', None)

    if DRY_RUN:
        print(f'[dry-run] would repair {fname}: _date -> date={canonical_date!r}')
    else:
        tmp = path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
        print(f'repaired {fname}: date={canonical_date!r}')
    repaired += 1

print(f'\ndone: {repaired} repaired, {skipped} skipped' + (' (dry-run)' if DRY_RUN else ''))
