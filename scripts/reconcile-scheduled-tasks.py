#!/usr/bin/env python3
"""Reconcile file-based scheduled-task dirs against the scheduled_tasks DB rows
(migration-readiness GAP G4, card 1123).

Two sources of truth for scheduled tasks exist and must stay consistent or tasks
silently stop firing after a migration:

  1. File dirs under ~/.claude/scheduled-tasks/<id>/  (SKILL.md + task-config.json
     -- the task *body*). This path is read by src/web/scheduled-tasks-io.ts.
  2. Rows in scheduled_tasks in the live noa.db (the *desired-state* record read
     by the scheduler: schedule, next_run, last_run, status).

The file-dir name is, by construction, the DB primary key `scheduled_tasks.id`
(both kebab-case). A reconcile is therefore a set-diff of dir-names vs row-ids.

Orphan classes this report surfaces:

  FILE-ORPHAN      dir on disk with NO scheduled_tasks row at all. The scheduler
                   DB-row is the thing that actually fires; a body with no row
                   never runs (dead weight that will migrate but do nothing).
  ROW-ORPHAN       a non-deleted (active|paused) DB row whose dir is MISSING on
                   disk. On a live box the scheduler cannot read the prompt body
                   -> the task is broken. On migration this means a row was
                   carried but its body dir was not.
  DELETED-ON-DISK  a row with status='deleted' (tombstone) whose dir still
                   exists. Harmless (the row will not fire) but it inflates the
                   dir count and should be pruned before a migration snapshot so
                   the counts are explainable.

The historical "157 dirs vs 213 rows" mismatch decomposes as:
  213 rows = <non-deleted rows> + <deleted tombstone rows>
  157 dirs = <non-deleted rows that have a dir> + <file-orphans>
so the gap is mostly the deleted-tombstone rows, which never fire.

SAFETY: read-only. Never writes to the DB or the task dirs. The DB path is
resolved CWD-independently via the shared resolver (fails open to the LIVE
store/noa.db, never the frozen legacy db) and the tasks dir honors
NOA_SCHEDULED_TASKS_DIR for tests.

Usage:
  python3 scripts/reconcile-scheduled-tasks.py            # human-readable report
  python3 scripts/reconcile-scheduled-tasks.py --json     # machine-readable
  exit code 0 = reconciled (no actionable orphans), 1 = drift found
"""
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db_resolve import resolve_default_db  # noqa: E402


def tasks_dir() -> Path:
    """The scheduled-tasks file root. Mirrors SCHEDULED_TASKS_DIR in
    src/web/scheduled-tasks-io.ts (~/.claude/scheduled-tasks). Overridable for
    tests via NOA_SCHEDULED_TASKS_DIR."""
    override = os.environ.get("NOA_SCHEDULED_TASKS_DIR")
    if override:
        return Path(override)
    return Path(os.path.expanduser("~/.claude/scheduled-tasks"))


def list_task_dirs(root: Path) -> set:
    """Dir names under the task root that look like a task body (have a
    SKILL.md -- the same existence check readScheduledTask() uses)."""
    if not root.exists():
        return set()
    names = set()
    for p in sorted(root.iterdir()):
        try:
            if p.is_dir() and (p / "SKILL.md").exists():
                names.add(p.name)
        except OSError:
            continue
    return names


def load_db_rows(db_path: Path) -> dict:
    """Return {id: status} for every scheduled_tasks row."""
    db = sqlite3.connect(str(db_path))
    try:
        return {
            row[0]: row[1]
            for row in db.execute("SELECT id, status FROM scheduled_tasks")
        }
    finally:
        db.close()


def reconcile(dir_names: set, db_rows: dict) -> dict:
    """Pure set-diff; no I/O. db_rows is {id: status}."""
    all_ids = set(db_rows)
    live_ids = {i for i, s in db_rows.items() if s != "deleted"}
    deleted_ids = {i for i, s in db_rows.items() if s == "deleted"}

    file_orphans = sorted(dir_names - all_ids)
    row_orphans = sorted(live_ids - dir_names)
    deleted_on_disk = sorted(deleted_ids & dir_names)

    return {
        "counts": {
            "dirs": len(dir_names),
            "db_rows_total": len(all_ids),
            "db_rows_non_deleted": len(live_ids),
            "db_rows_deleted": len(deleted_ids),
            "matched": len(dir_names & live_ids),
        },
        "file_orphans": file_orphans,
        "row_orphans": row_orphans,
        "deleted_on_disk": deleted_on_disk,
    }


def print_report(rep: dict, db_path: Path, root: Path) -> None:
    c = rep["counts"]
    print("Scheduled-task reconcile (GAP G4)")
    print(f"  tasks dir : {root}")
    print(f"  db        : {db_path}")
    print(
        f"  {c['dirs']} dirs on disk vs {c['db_rows_total']} DB rows "
        f"({c['db_rows_non_deleted']} active/paused + {c['db_rows_deleted']} deleted tombstones); "
        f"{c['matched']} matched"
    )
    print()

    def section(title, items, note):
        print(f"  {title}: {len(items)}")
        if items:
            print(f"    ({note})")
            for x in items:
                print(f"      - {x}")

    section(
        "FILE-ORPHANS (dir on disk, NO db row -> never fires, dead weight)",
        rep["file_orphans"],
        "fix: add a scheduled_tasks row via POST /api/schedule, or delete the dir",
    )
    section(
        "ROW-ORPHANS (non-deleted db row, dir MISSING -> broken task, body unreadable)",
        rep["row_orphans"],
        "fix: restore the dir from backup, or mark the row status='deleted'",
    )
    section(
        "DELETED-ON-DISK (tombstone db row, dir still present -> harmless, prune before snapshot)",
        rep["deleted_on_disk"],
        "fix: rm the dir so migration dir-count is explainable",
    )

    print()
    actionable = len(rep["file_orphans"]) + len(rep["row_orphans"])
    if actionable == 0:
        print("  RECONCILED: no actionable orphans (deleted-on-disk is cosmetic).")
    else:
        print(f"  DRIFT: {actionable} actionable orphan(s) -- see above.")


def main(argv) -> int:
    as_json = "--json" in argv
    db_path = Path(resolve_default_db())
    root = tasks_dir()

    if not db_path.exists():
        msg = f"noa.db not found at {db_path} -- cannot reconcile"
        if as_json:
            print(json.dumps({"error": msg}))
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
        return 2

    dir_names = list_task_dirs(root)
    db_rows = load_db_rows(db_path)
    rep = reconcile(dir_names, db_rows)

    if as_json:
        rep["tasks_dir"] = str(root)
        rep["db_path"] = str(db_path)
        print(json.dumps(rep, indent=2))
    else:
        print_report(rep, db_path, root)

    actionable = len(rep["file_orphans"]) + len(rep["row_orphans"])
    return 1 if actionable else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
