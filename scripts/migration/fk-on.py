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

Enforcement precondition (hard, spec section 3 bound (g), marveen 2026-11-25):
``--apply`` is ALSO refused unless BOTH app DB-openers that write the 4 core
tables -- ``src/noa-db.ts`` (kanban_cards, memories) and ``src/db.ts``
(agent_messages, agent_tokens) -- commit a ``foreign_keys = ON`` opener pragma.
A declared SQLite FK is inert at runtime unless the WRITING connection enables
foreign_keys; FK-ON runs POST-CUTOVER, so without the opener pragma enforcement
would be inert for those tables. The gate is static (reads the two source files)
and runs BEFORE the snapshot/mutation. ``--skip-enforcement-check`` is a loud
explicit escape hatch (prints a WARN, never a silent default). Dry-run REPORTS
the enforcement status but does not block.

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


class EnforcementError(RuntimeError):
    """Raised when --apply is requested but the app DB-openers that write the 4
    core tables are not committed with ``PRAGMA foreign_keys = ON`` (spec P1
    section 3 bound (g)). FK-ON runs POST-CUTOVER; a declared SQLite FK is inert
    at runtime unless the WRITING connection enables foreign_keys, so running
    FK-ON into an opener that lacks the pragma would leave enforcement inert for
    those tables. The migration self-gates rather than silently under-enforce."""


# The two app DB-openers that write the 4 core tables (spec P2 recon):
#   src/noa-db.ts -> kanban_cards, memories
#   src/db.ts     -> agent_messages, agent_tokens
_OPENER_FILES: Tuple[str, ...] = ("src/noa-db.ts", "src/db.ts")

# Robust match for an opener pragma enabling foreign keys: the token
# ``foreign_keys`` followed by ``=`` / ``:`` / whitespace, then ON/on/1/true.
# Accepts e.g. ``pragma('foreign_keys = ON')``, ``foreign_keys=ON``,
# ``PRAGMA foreign_keys: on``, ``foreign_keys 1``, ``foreign_keys = true``.
# Intentionally does NOT match ``foreign_keys = OFF`` nor the conditional
# restore ``foreign_keys = ${prev ? 'ON' : 'OFF'}`` (the value token there is
# the interpolation, not a bare ON/1/true) -- so src/db.ts's migration-local
# toggle is correctly read as NOT an opener pragma.
_ENFORCE_RE = re.compile(
    r"foreign_keys\s*[=:\s]\s*(?:on|1|true)\b",
    re.IGNORECASE,
)


def app_enforcement_ready(repo_root: Path) -> Dict:
    """Statically read the two app DB-openers under ``repo_root`` and report
    whether EACH commits a ``foreign_keys = ON`` opener pragma.

    Returns a dict::

        {"ready": bool,              # True iff ALL openers ready
         "openers": {rel_path: {"ready": bool, "present": bool, "reason": str}},
         "missing": [rel_path, ...]} # openers lacking the pragma or absent

    A missing file is treated as NOT ready (fail-closed), naming the file.

    Empirical nuance (belt-and-suspenders): better-sqlite3 on this host
    currently defaults ``foreign_keys=ON``, so enforcement is in fact active
    even without an explicit opener pragma. This static check requires the
    EXPLICIT pragma anyway -- it is intentionally stricter than the driver
    default, as defense-in-depth against a driver/compile-flag change that would
    silently flip the default to OFF and render the FKs inert post-cutover.
    """
    repo_root = Path(repo_root)
    openers: Dict[str, Dict] = {}
    missing: List[str] = []
    for rel in _OPENER_FILES:
        path = repo_root / rel
        if not path.is_file():
            openers[rel] = {"ready": False, "present": False,
                            "reason": "opener file not found"}
            missing.append(rel)
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        ok = bool(_ENFORCE_RE.search(text))
        openers[rel] = {
            "ready": ok,
            "present": True,
            "reason": "foreign_keys=ON pragma present" if ok
            else "no opener foreign_keys=ON pragma found",
        }
        if not ok:
            missing.append(rel)
    return {"ready": not missing, "openers": openers, "missing": missing}


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


def run_migration(
    db_path: Path,
    agents_dir: Path,
    *,
    apply: bool,
    repo_root: Path | None = None,
    skip_enforcement_check: bool = False,
) -> Dict:
    """Build the per-table rebuild plan; with apply=True, gate the preconditions,
    snapshot, then rebuild each not-yet-covered table in its own transaction.

    ``repo_root`` locates the two app DB-openers (src/noa-db.ts, src/db.ts) for
    the §3(g) enforcement-precondition. It defaults to ``agents_dir.parent``,
    which is the live repo root for the CLI default (agents_dir=<root>/agents)
    and the hermetic sandbox for tests (agents_dir=<tmp>/agents).

    Returns a result dict: which tables were rebuilt / skipped, the FK clauses,
    the snapshot path, the post-rebuild foreign_key_check violation count, and
    the enforcement-readiness status of the app openers.
    """
    if not db_path.is_file():
        raise FileNotFoundError(f"database not found: {db_path}")

    if repo_root is None:
        repo_root = agents_dir.parent
    enforcement = app_enforcement_ready(repo_root)
    enforcement["skipped"] = False

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
        "enforcement": enforcement,
    }

    if not apply:
        return result  # dry-run: no gate, no write path reached (enforcement reported only)

    # --- apply path: enforcement-precondition gate (§3(g), marveen hard cond) -
    # Refuse to run FK-ON into INERT runtime enforcement unless BOTH app openers
    # commit foreign_keys=ON -- checked BEFORE snapshot/mutation so a refusal
    # leaves the DB untouched. --skip-enforcement-check is a loud escape hatch.
    if not enforcement["ready"]:
        if skip_enforcement_check:
            enforcement["skipped"] = True
            print(
                "WARN: --skip-enforcement-check set; proceeding despite app "
                "opener(s) lacking a foreign_keys=ON pragma: "
                + ", ".join(enforcement["missing"])
                + ". FK enforcement may be INERT for the tables those openers "
                "write until the pragma is deployed.",
                file=sys.stderr,
            )
        else:
            raise EnforcementError(
                "enforcement-precondition FAILED: the app DB-opener(s) that write "
                "the core tables lack a committed `foreign_keys = ON` pragma, so "
                "FK-ON would be INERT at runtime for those tables: "
                + ", ".join(enforcement["missing"])
                + ". Fix the opener pragma (P2) before FK-ON, or re-run with "
                "--skip-enforcement-check to override (loud WARN)."
            )

    # --- apply path: FK precondition gate (abort leaves DB untouched) ---------
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
    enf = result.get("enforcement")
    if enf is not None:
        state = "READY" if enf["ready"] else "NOT READY"
        if enf.get("skipped"):
            state += " (bypassed via --skip-enforcement-check)"
        lines.append(f"app enforcement openers: {state}")
        for rel, info in enf["openers"].items():
            mark = "ok" if info["ready"] else "MISSING-PRAGMA" if info["present"] else "FILE-ABSENT"
            lines.append(f"   {rel}: {mark} -- {info['reason']}")
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
    parser.add_argument(
        "--repo-root", type=Path, default=None,
        help="repo root holding src/noa-db.ts + src/db.ts for the §3(g) "
        "enforcement-precondition (default: inferred from the agents dir parent)",
    )
    parser.add_argument(
        "--skip-enforcement-check", action="store_true",
        help="LOUD escape hatch: proceed with --apply even if an app opener "
        "lacks a foreign_keys=ON pragma (prints a WARN; FK may be inert).",
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
    repo_root = args.repo_root.resolve() if args.repo_root else None

    try:
        result = run_migration(
            db_path,
            agents_dir,
            apply=args.apply,
            repo_root=repo_root,
            skip_enforcement_check=args.skip_enforcement_check,
        )
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except PreconditionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    except EnforcementError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 4

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(format_text(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
