#!/usr/bin/env python3
"""6-month retention purge for Claudia's local Drive pre-write backups (ENG-048).

Every mutating Drive op (overwrite-upload; future delete/move) snapshots the
file's current version to store/claudia-drive-backups/ BEFORE the write, named
    <UTC-ISO>__<fileId>__<original-name>
(see src/mcp/google-drive.ts backupDriveFileVersion). The Boss decision
(2026-08-01 TG4809) sets a 6-month retention: this script deletes backups older
than that.

Age is read from the filename's UTC-ISO timestamp prefix (the canonical, tamper-
resistant source: the file's own mtime can drift). If the prefix is unparseable,
the file's mtime is the fallback -- a backup is never left forever just because
its name got mangled.

Usage:
    python3 scripts/claudia-drive-backup-purge.py [--dry-run] [--dir <path>]
                                                  [--max-age-days N]

- --dry-run    : list what WOULD be deleted, delete nothing.
- --dir        : backup dir (default: env CLAUDIA_DRIVE_BACKUP_DIR, else
                 <repo>/store/claudia-drive-backups).
- --max-age-days: retention window in days (default 183 ~= 6 months).

NOT wired into cron/scheduler here -- marveen owns the scheduling. Safe to run
repeatedly; a missing dir is a clean no-op (exit 0).

Exit 0 always on a normal run (including empty/missing dir). Exit 1 only on an
unexpected error while deleting a matched file (surfaced, not swallowed).
"""

import argparse
import os
import re
import sys
from datetime import datetime, timezone

# 6 months. Kept as days so it is explicit and testable.
DEFAULT_MAX_AGE_DAYS = 183

# The canonical UTC-ISO prefix a backup filename starts with, e.g.
# "2026-08-01T12:34:56.789Z__<fileId>__<name>". new Date().toISOString().
_TS_PREFIX = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)__"
)


def repo_root():
    # scripts/ is one level under the repo root.
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def default_backup_dir():
    env = os.environ.get("CLAUDIA_DRIVE_BACKUP_DIR")
    if env:
        return env
    return os.path.join(repo_root(), "store", "claudia-drive-backups")


def parse_backup_age_epoch(filename, full_path):
    """Return the backup's creation time as an epoch-seconds float.

    Prefer the UTC-ISO filename prefix; fall back to the file's mtime if the
    prefix is absent/unparseable (a mangled name must not become immortal)."""
    m = _TS_PREFIX.match(filename)
    if m:
        iso = m.group(1)
        try:
            # Python's fromisoformat rejects the trailing 'Z' before 3.11; swap it.
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
        except ValueError:
            pass
    return os.path.getmtime(full_path)


def find_expired(backup_dir, max_age_days, now_epoch):
    """List (path, age_days) for regular files older than max_age_days."""
    cutoff = now_epoch - max_age_days * 86400
    expired = []
    if not os.path.isdir(backup_dir):
        return expired
    for name in sorted(os.listdir(backup_dir)):
        path = os.path.join(backup_dir, name)
        if not os.path.isfile(path):
            continue
        created = parse_backup_age_epoch(name, path)
        if created < cutoff:
            age_days = (now_epoch - created) / 86400
            expired.append((path, age_days))
    return expired


def main(argv=None):
    ap = argparse.ArgumentParser(description="Purge Claudia Drive backups older than 6 months.")
    ap.add_argument("--dry-run", action="store_true", help="list without deleting")
    ap.add_argument("--dir", default=None, help="backup dir (default: env / store/claudia-drive-backups)")
    ap.add_argument("--max-age-days", type=int, default=DEFAULT_MAX_AGE_DAYS)
    args = ap.parse_args(argv)

    backup_dir = args.dir or default_backup_dir()
    now_epoch = datetime.now(timezone.utc).timestamp()

    expired = find_expired(backup_dir, args.max_age_days, now_epoch)

    if not os.path.isdir(backup_dir):
        print(f"[drive-backup-purge] dir absent, nothing to do: {backup_dir}")
        return 0

    if not expired:
        print(f"[drive-backup-purge] no backups older than {args.max_age_days}d in {backup_dir}")
        return 0

    deleted = 0
    for path, age_days in expired:
        if args.dry_run:
            print(f"[drive-backup-purge] WOULD delete ({age_days:.0f}d): {os.path.basename(path)}")
            continue
        try:
            os.remove(path)
            deleted += 1
            print(f"[drive-backup-purge] deleted ({age_days:.0f}d): {os.path.basename(path)}")
        except OSError as e:
            print(f"[drive-backup-purge] ERROR deleting {path}: {e}", file=sys.stderr)
            return 1

    verb = "would delete" if args.dry_run else "deleted"
    print(f"[drive-backup-purge] {verb} {len(expired) if args.dry_run else deleted} backup(s) (retention {args.max_age_days}d)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
