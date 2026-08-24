#!/usr/bin/env python3
"""Normalize kanban_cards timestamp columns to epoch-seconds.

Originally written to repair the mixed-format timestamps that accumulated in
store/claudeclaw.db before the W5-cutover (2026-06-28). The live kanban table
now lives in store/noa.db; claudeclaw.db is scheduled for retirement (ENG-024).
The DEFAULT_DB now points to noa.db so this script does not crash after the
retire. Running against noa.db is a no-op (timestamps are already epoch-seconds)
but is safe -- every value already in epoch-seconds is left untouched.

The `created_at` and `updated_at` columns in store/claudeclaw.db accumulated a
MIX of formats over time: epoch-seconds, epoch-milliseconds, and ISO-8601
strings (both naive and tz-aware). Every other time column and the table's own
INSERTs use epoch-seconds (strftime('%s','now')), so this script unifies the two
polluted columns onto that single representation.

Design constraints (carded as b3ef5cd4):
  * DRY-RUN by default. --apply is required to write. Backs the db up to <db>.bak
    before the first write.
  * IDEMPOTENT: a value already in epoch-seconds is left untouched, so running
    twice yields the same result as running once.
  * A value that cannot be parsed is SKIPPED and reported, never crashes the run
    and never corrupts the cell.
  * Plain parametrized UPDATE per changed cell -- no table rebuild, so no
    foreign-key concern.

Naive ISO strings (no timezone) are interpreted as Europe/Budapest local time
(the fleet's timezone); tz-aware strings use their own offset.
"""
import argparse
import json
import os
import shutil
import sqlite3
import sys
from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo

DEFAULT_DB = os.environ.get("MIGRATE_KANBAN_DB", "store/noa.db")
TABLE = "kanban_cards"
COLUMNS = ("created_at", "updated_at")
LOCAL_TZ = ZoneInfo("Europe/Budapest")

# Epoch-seconds for a current-ish timestamp sit around 1.78e9; epoch-millis are
# ~1.78e12. The 1e12 boundary cleanly separates the two; anything below 1e9 is
# too small to be a plausible recent second-epoch and is treated as suspicious.
_MS_THRESHOLD = 1e12
_S_FLOOR = 1e9


def classify(value):
    """Return one of: 'null', 'epoch_ms', 'epoch_s', 'small', 'iso'."""
    if value is None:
        return "null"
    try:
        f = float(value)
    except (TypeError, ValueError):
        return "iso"
    if f >= _MS_THRESHOLD:
        return "epoch_ms"
    if f >= _S_FLOOR:
        return "epoch_s"
    return "small"


def to_epoch_s(value):
    """Normalize a single cell to (epoch_seconds:int, reason:str).

    On success returns (int, format). On a value that should be left alone
    returns (None, reason) -- the caller skips it.
    """
    kind = classify(value)
    if kind == "null":
        return None, "null"
    if kind == "epoch_ms":
        return int(float(value) // 1000), "epoch_ms"
    if kind == "epoch_s":
        return int(float(value)), "epoch_s"
    if kind == "small":
        return None, "suspicious_small"
    # iso
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError:
        return None, "parse_error"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=LOCAL_TZ)
    return int(dt.timestamp()), "iso"


def analyze(conn):
    """Inspect every row; build a report of format distribution + planned changes.

    Returns a dict:
      {table, columns: {col: {dist: {fmt: n}, changes: [(id, old, new)],
                              skipped: [(id, old, reason)]}}}
    """
    report = {"table": TABLE, "columns": {}}
    cur = conn.cursor()
    for col in COLUMNS:
        dist = Counter()
        changes = []
        skipped = []
        for row_id, old in cur.execute(f"SELECT id, {col} FROM {TABLE}"):
            dist[classify(old)] += 1
            new, reason = to_epoch_s(old)
            if new is None:
                if reason not in ("null",):
                    skipped.append((row_id, old, reason))
                continue
            if old != new:
                changes.append((row_id, old, new))
        report["columns"][col] = {
            "dist": dict(dist),
            "changes": changes,
            "skipped": skipped,
        }
    return report


def apply(conn, report):
    """Apply the planned changes from `analyze`. Returns the number of cells written."""
    cur = conn.cursor()
    written = 0
    for col, info in report["columns"].items():
        for row_id, _old, new in info["changes"]:
            cur.execute(f"UPDATE {TABLE} SET {col} = ? WHERE id = ?", (new, row_id))
            written += cur.rowcount
    return written


def _backup(path):
    bak = path + ".bak"
    shutil.copy2(path, bak)
    return bak


def _summary(report):
    lines = []
    for col, info in report["columns"].items():
        dist = ", ".join(f"{k}={v}" for k, v in sorted(info["dist"].items()))
        lines.append(f"  {col}: [{dist}]")
        lines.append(
            f"    -> {len(info['changes'])} to normalize, "
            f"{len(info['skipped'])} skipped"
        )
        for row_id, old, reason in info["skipped"]:
            lines.append(f"       SKIP {row_id}: {old!r} ({reason})")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Normalize kanban_cards timestamps to epoch-seconds")
    ap.add_argument("--db", default=DEFAULT_DB, help=f"SQLite db path (default {DEFAULT_DB})")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run report only)")
    ap.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = ap.parse_args(argv)

    if not os.path.exists(args.db):
        print(f"db not found: {args.db}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(args.db)
    try:
        report = analyze(conn)
        total_changes = sum(len(c["changes"]) for c in report["columns"].values())
        total_skipped = sum(len(c["skipped"]) for c in report["columns"].values())

        if args.apply:
            bak = _backup(args.db)
            written = apply(conn, report)
            conn.commit()
            report["applied"] = {"backup": bak, "written": written}

        if args.json:
            print(json.dumps(report, default=str, indent=2))
        else:
            mode = "APPLY" if args.apply else "DRY-RUN"
            print(f"kanban timestamp normalization [{mode}]  db={args.db}")
            print(_summary(report))
            if args.apply:
                print(f"  backup: {report['applied']['backup']}")
                print(f"  written: {report['applied']['written']} cells")
            else:
                print(f"  total: {total_changes} to normalize, {total_skipped} skipped "
                      f"(re-run with --apply to write)")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
