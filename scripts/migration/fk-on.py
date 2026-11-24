#!/usr/bin/env python3
"""M3 FK-ON core migration (card 26ba217a / 5fd6853b).

Rebuild each of the 4 core tables so its agent-id column carries a real
``REFERENCES agents(agent_id)`` foreign key, via the canonical SQLite 12-step
table rebuild. Idempotent, dry-run-first, snapshot-gated, precondition-gated.

SQLite cannot ``ALTER TABLE ADD CONSTRAINT``; the only way to add a FK to an
existing table is the 12-step redefine (create _new, copy, drop, rename,
recreate dependent objects). A declared FK is also inert at runtime unless the
connection sets ``PRAGMA foreign_keys=ON`` -- that runtime half is P2 (src/db.ts),
a separate follow-up. This script is P1: the schema-level migration.

Runs POST-CUTOVER only, with the server STOPPED (no live writer holding the DB
across the DROP/RENAME). Per NoA 2026-11-25 the DB is cold-copied as-is at
cutover; M1 ``dim-seed.py --apply`` runs first (creates+seeds ``agents``), then
this. FK-ON does NOT run today -- this is a build-only, runnable, idempotent,
dry-run-first pipeline.

The 4 target tables + the new bare FK clause (NO ACTION, matching the existing
``kanban_cards.parent_id REFERENCES kanban_cards(id)`` style -- agents are retired
via ``retired_at``, never hard-deleted):

    kanban_cards.assignee   -> REFERENCES agents(agent_id)
    memories.agent_id       -> REFERENCES agents(agent_id)
    agent_messages.from_agent -> REFERENCES agents(agent_id)
    agent_tokens.agent_id   -> REFERENCES agents(agent_id)

(Note: ``agent_messages.to_agent`` is intentionally NOT FK'd in this phase --
inbound can target a not-yet-seeded id. Documented asymmetry, spec section 2.)

Rather than hardcode a ``__new`` DDL (which would silently drift from the live
schema as columns are added), the new CREATE statement is DERIVED from the live
``sqlite_master`` SQL by injecting the ``REFERENCES agents(agent_id)`` clause
into the FK column's definition. Every other column, CHECK, self-FK and UNIQUE
is preserved byte-for-byte. The copy uses an explicit column list (guards against
column-order drift) and keeps ``id`` values identical (required for the
``memories`` FTS external-content rowid linkage).

Precondition gate (hard, spec section 3f): ``--apply`` is refused unless the
``agents`` dim-table exists and is non-empty AND
``dim-seed.fk_uncovered_core_ids`` is ``[]`` on the target DB. Any uncovered id
would be a legit row the new FK would reject -> data loss. Dry-run does NOT gate
(it only reports the plan).

Usage:
    python3 scripts/migration/fk-on.py                 # live DB, DRY-RUN plan
    python3 scripts/migration/fk-on.py --json          # machine-readable plan
    python3 scripts/migration/fk-on.py --apply         # snapshot + rebuild (Boss-GO, server stopped)
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple

# ---------------------------------------------------------------------------
# FIXED enumerated core-table set -- identical to fk-preflight.py (M0) and
# dim-seed.py (M1). (table, agent_id_column)
# ---------------------------------------------------------------------------
CORE_TABLES: Tuple[Tuple[str, str], ...] = (
    ("kanban_cards", "assignee"),
    ("memories", "agent_id"),
    ("agent_messages", "from_agent"),
    ("agent_tokens", "agent_id"),
)

# The bare FK clause appended to each column def (NO ACTION, like parent_id).
_FK_REF = "REFERENCES agents(agent_id)"

_HERE = Path(__file__).resolve().parent
_PROJECT_ROOT = _HERE.parent.parent  # scripts/migration/ -> scripts/ -> root
_DIM_SEED = _HERE / "dim-seed.py"


# ---------------------------------------------------------------------------
# import dim-seed.py (hyphenated filename -> importlib) for the SAME precondition
# check (spec section 1: "P1 imports and re-checks this").
# ---------------------------------------------------------------------------
def _load_dim_seed():
    spec = importlib.util.spec_from_file_location("dim_seed", _DIM_SEED)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class PreconditionError(RuntimeError):
    """Raised when --apply is requested but the FK precondition is not GREEN."""


def default_db_path() -> Path:
    return _PROJECT_ROOT / "store" / "noa.db"


def default_agents_dir() -> Path:
    return _PROJECT_ROOT / "agents"


# ---------------------------------------------------------------------------
# schema introspection
# ---------------------------------------------------------------------------
def _table_exists(con: sqlite3.Connection, table: str) -> bool:
    return (
        con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        is not None
    )


def _table_sql(con: sqlite3.Connection, table: str) -> str:
    row = con.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if row is None or not row[0]:
        raise RuntimeError(f"table not found or has no DDL: {table}")
    return row[0]


def _table_columns(con: sqlite3.Connection, table: str) -> List[str]:
    """Ordered column names (for the explicit-column INSERT copy)."""
    return [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]


def _has_agents_fk(con: sqlite3.Connection, table: str, col: str) -> bool:
    """True if ``col`` already REFERENCES agents on ``table`` (idempotency gate)."""
    for r in con.execute(f"PRAGMA foreign_key_list({table})").fetchall():
        # columns: id, seq, table(ref), from, to, on_update, on_delete, match
        if r[2] == "agents" and r[3] == col:
            return True
    return False


def _dependent_objects(con: sqlite3.Connection, table: str) -> Tuple[List[str], List[str]]:
    """Return (index_sqls, trigger_sqls) attached to ``table`` that must be
    recreated after the rebuild. Auto-indexes (UNIQUE/PK, sql IS NULL) are
    carried by the table DDL itself and are skipped here."""
    idx = [
        r[0]
        for r in con.execute(
            "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? "
            "AND sql IS NOT NULL",
            (table,),
        ).fetchall()
    ]
    trg = [
        r[0]
        for r in con.execute(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
            (table,),
        ).fetchall()
    ]
    return idx, trg


# ---------------------------------------------------------------------------
# derive the __new CREATE statement by injecting the FK ref into the column def
# ---------------------------------------------------------------------------
def build_new_table_sql(original_sql: str, table: str, fk_col: str) -> str:
    """Return a CREATE TABLE statement for ``<table>__new`` identical to
    ``original_sql`` except the ``fk_col`` column definition gains
    ``REFERENCES agents(agent_id)`` and the table name is suffixed ``__new``.

    The FK ref is inserted right after the column name + its type token, before
    any trailing per-column constraints (NOT NULL, DEFAULT, CHECK, UNIQUE,
    existing REFERENCES). This matches SQLite grammar (column-constraints are
    order-independent) and the ``parent_id TEXT REFERENCES ...`` live style.
    """
    # 1) rename the table in the CREATE header.
    # Match: CREATE TABLE [IF NOT EXISTS] "?table"? (
    header_re = re.compile(
        r"(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)([\"'`\[]?)" + re.escape(table) + r"([\"'`\]]?)",
        re.IGNORECASE,
    )
    new_sql, n = header_re.subn(
        lambda m: f"{m.group(1)}{m.group(2)}{table}__new{m.group(3)}", original_sql, count=1
    )
    if n != 1:
        raise RuntimeError(f"could not rewrite CREATE header for {table}")

    # 2) inject the FK ref into the fk_col definition.
    # The column def starts with the (optionally quoted) column name followed by
    # whitespace and a type token (TEXT/INTEGER/...). Insert the ref after the
    # type token. We anchor on the column name as a word at a definition
    # boundary (preceded by '(' or ',') to avoid matching it inside a CHECK or
    # another column. The agent-id columns are all TEXT.
    col_re = re.compile(
        r"(?P<lead>[(,]\s*)(?P<name>[\"'`\[]?" + re.escape(fk_col) + r"[\"'`\]]?)"
        r"(?P<ws>\s+)(?P<type>TEXT|INTEGER|REAL|BLOB|NUMERIC)",
        re.IGNORECASE,
    )

    def _inject(m: re.Match) -> str:
        return (
            f"{m.group('lead')}{m.group('name')}{m.group('ws')}{m.group('type')} {_FK_REF}"
        )

    new_sql, n2 = col_re.subn(_inject, new_sql, count=1)
    if n2 != 1:
        raise RuntimeError(
            f"could not locate column '{fk_col}' definition in DDL for {table}"
        )
    return new_sql


# ---------------------------------------------------------------------------
# snapshot (0600) -- identical pattern to dim-seed._snapshot
# ---------------------------------------------------------------------------
def _snapshot(db_path: Path) -> Path:
    """Copy the DB to a timestamped .bak next to it, 0600, BEFORE any mutation
    (spec section 3a). noa.db holds tokens -> restrict snapshot perms."""
    stamp = time.strftime("%Y%m%dT%H%M%S")
    dest = db_path.with_name(f"{db_path.name}.fk-on.{stamp}.bak")
    shutil.copy2(db_path, dest)
    os.chmod(dest, 0o600)
    return dest


# ---------------------------------------------------------------------------
# per-table rebuild (one txn each -- a mid-run failure rolls back THAT table)
# ---------------------------------------------------------------------------
def _rebuild_one(con: sqlite3.Connection, table: str, fk_col: str) -> None:
    """The canonical SQLite 12-step redefine for one table, inside its own txn.

    PRECONDITION: the caller has already set ``PRAGMA foreign_keys=OFF`` OUTSIDE
    any transaction (the pragma is a no-op inside one). This function opens and
    commits its own BEGIN/COMMIT so each table is independently atomic.
    """
    original = _table_sql(con, table)
    new_sql = build_new_table_sql(original, table, fk_col)
    cols = _table_columns(con, table)
    col_list = ", ".join(f'"{c}"' for c in cols)
    idx_sqls, trg_sqls = _dependent_objects(con, table)

    con.execute("BEGIN")
    try:
        before = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        con.execute(f"DROP TABLE IF EXISTS {table}__new")
        con.execute(new_sql)
        # explicit column list, id preserved (FTS rowid linkage for memories).
        con.execute(
            f"INSERT INTO {table}__new ({col_list}) SELECT {col_list} FROM {table}"
        )
        con.execute(f"DROP TABLE {table}")
        con.execute(f"ALTER TABLE {table}__new RENAME TO {table}")
        # recreate indexes + triggers (the table object they were attached to
        # was dropped; the FTS vtable itself survives, only triggers re-attach).
        for sql in idx_sqls:
            con.execute(sql)
        for sql in trg_sqls:
            con.execute(sql)
        after = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        if after != before:
            raise RuntimeError(
                f"{table} rebuild row-count mismatch: {before} -> {after}"
            )
        # per-table FK integrity: no orphan may exist (precondition guarantees it)
        violations = con.execute(
            f"PRAGMA foreign_key_check({table})"
        ).fetchall()
        if violations:
            raise RuntimeError(
                f"{table} foreign_key_check reported {len(violations)} violation(s)"
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------
def _check_precondition(db_path: Path, agents_dir: Path) -> List[str]:
    """Raise PreconditionError unless the FK precondition is GREEN. Returns the
    (empty) uncovered list on success for the result dict."""
    dim = _load_dim_seed()
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if not _table_exists(con, "agents"):
            raise PreconditionError(
                "precondition FAILED: 'agents' dim-table does not exist. "
                "Run dim-seed.py --apply first."
            )
        n = con.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
        if n == 0:
            raise PreconditionError(
                "precondition FAILED: 'agents' dim-table is empty. "
                "Run dim-seed.py --apply first."
            )
    finally:
        con.close()
    uncovered = sorted(dim.fk_uncovered_core_ids(agents_dir, db_path))
    if uncovered:
        raise PreconditionError(
            "precondition FAILED: fk_uncovered_core_ids is non-empty -- these "
            "live core ids would be rejected by the new FK: " + ", ".join(uncovered)
        )
    return uncovered


def run_migration(db_path: Path, agents_dir: Path, *, apply: bool) -> Dict:
    """Build the per-table rebuild plan; with apply=True, gate the precondition,
    snapshot, then rebuild each not-yet-covered table in its own transaction.

    Returns a result dict: which tables were rebuilt / skipped, the FK clauses,
    the snapshot path, and the post-rebuild foreign_key_check violation count.
    """
    if not db_path.is_file():
        raise FileNotFoundError(f"database not found: {db_path}")

    # plan (read-only): which tables still need the FK.
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        plan_rebuild: List[str] = []
        plan_skip: List[str] = []
        fk_clauses: Dict[str, str] = {}
        for table, col in CORE_TABLES:
            fk_clauses[table] = f"{col} {_FK_REF}"
            if not _table_exists(con, table):
                # a missing core table is not this script's job to create.
                plan_skip.append(table)
                continue
            if _has_agents_fk(con, table, col):
                plan_skip.append(table)
            else:
                plan_rebuild.append(table)
    finally:
        con.close()

    result: Dict = {
        "apply": apply,
        "rebuilt": [],
        "skipped": sorted(plan_skip),
        "to_rebuild": sorted(plan_rebuild),
        "fk_clauses": fk_clauses,
        "snapshot": None,
        "fk_uncovered": [],
        "fk_check_violations": None,
    }

    if not apply:
        return result  # dry-run: no precondition gate, no write path reached

    # --- apply path: precondition gate FIRST (abort leaves DB untouched) ------
    result["fk_uncovered"] = _check_precondition(db_path, agents_dir)

    if not plan_rebuild:
        # nothing to do; still a clean, idempotent apply. No snapshot needed
        # since no mutation occurs.
        result["fk_check_violations"] = 0
        return result

    snap = _snapshot(db_path)
    result["snapshot"] = str(snap)

    con = sqlite3.connect(db_path)
    try:
        # pragma OFF must be OUTSIDE any txn (no-op inside one).
        con.execute("PRAGMA foreign_keys = OFF")
        con.execute("PRAGMA busy_timeout = 5000")
        rebuilt: List[str] = []
        for table, col in CORE_TABLES:
            if table in plan_rebuild:
                _rebuild_one(con, table, col)
                rebuilt.append(table)
        result["rebuilt"] = sorted(rebuilt)
        # global integrity check across the whole DB after all rebuilds.
        violations = con.execute("PRAGMA foreign_key_check").fetchall()
        result["fk_check_violations"] = len(violations)
        if violations:
            raise RuntimeError(
                f"post-rebuild foreign_key_check reported {len(violations)} violation(s)"
            )
        con.execute("PRAGMA foreign_keys = ON")  # restore
    finally:
        con.close()
    return result


# ---------------------------------------------------------------------------
# text / json rendering (token value never printed)
# ---------------------------------------------------------------------------
def format_text(result: Dict) -> str:
    lines: List[str] = []
    mode = "APPLY (mutating)" if result["apply"] else "DRY-RUN (no write)"
    lines.append(f"M3 FK-ON core (card 26ba217a) -- {mode}")
    lines.append("")
    lines.append("-- new FK clauses (bare REFERENCES, NO ACTION) --")
    for table, col in CORE_TABLES:
        lines.append(f"   {table}.{col}  ->  {result['fk_clauses'][table]}")
    lines.append("")
    if result["apply"]:
        lines.append(
            "precondition: GREEN (agents seeded, fk_uncovered=[])"
        )
        if result["snapshot"]:
            lines.append(f"snapshot: {result['snapshot']}")
        else:
            lines.append("snapshot: none (0 tables needed rebuild)")
        lines.append(f"rebuilt: {', '.join(result['rebuilt']) or '(none)'}")
        lines.append(f"skipped (FK already present): {', '.join(result['skipped']) or '(none)'}")
        lines.append(f"foreign_key_check violations: {result['fk_check_violations']}")
    else:
        lines.append(f"to rebuild: {', '.join(result['to_rebuild']) or '(none)'}")
        lines.append(f"already covered (skip): {', '.join(result['skipped']) or '(none)'}")
        lines.append(
            "dry-run: nothing written. Precondition is checked only on --apply. "
            "Re-run with --apply (server stopped, Boss-GO) to rebuild."
        )
    return "\n".join(lines)


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="M3 FK-ON core migration: add REFERENCES agents(agent_id) to "
        "the 4 core tables via the SQLite 12-step rebuild (card 26ba217a)."
    )
    parser.add_argument("--db", type=Path, default=None, help="path to noa.db (default: live store/noa.db)")
    parser.add_argument(
        "--agents-dir", type=Path, default=None, help="path to agents/ roster dir (default: live agents/)"
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable plan")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="WRITE the DB: precondition-gate, snapshot, then rebuild each "
        "not-yet-covered core table. Default is DRY-RUN. Run with the server "
        "STOPPED and after dim-seed.py --apply. Needs Boss-GO.",
    )
    args = parser.parse_args(argv)

    db_path = (args.db or default_db_path()).resolve()
    agents_dir = (args.agents_dir or default_agents_dir()).resolve()

    try:
        result = run_migration(db_path, agents_dir, apply=args.apply)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except PreconditionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(format_text(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
