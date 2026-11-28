#!/usr/bin/env python3
"""Stage-1 identity remap: agent id ``marveen`` -> ``noa`` (NoA fleet migration).

Purpose-built, idempotent, FK-safe remap of EVERY identity column that holds the
exact value ``marveen`` across the live schema, to ``noa``. This is NOT the
``migrate-to-noa.py`` rebuild (that is a source.db -> noa.db schema rebuild); this
operates IN PLACE on a single noa.db-shaped database and only repoints identity
references.

What it does, in order (single transaction, ``foreign_keys=ON``):

  1. REGISTER the ``noa`` agents row (FK parent) FIRST, by cloning the ``marveen``
     agents row (team/leader/model/kind/created_at), with ``display='NoA'`` and
     ``status`` carried over. Skipped if ``noa`` already exists. Because FK
     enforcement is live, this MUST happen before any child column is repointed,
     else an IntegrityError aborts the whole transaction.

  2. REMAP the 4 FK-child columns of ``agents`` first
     (memories.agent_id, agent_messages.from_agent, kanban_cards.assignee,
     agent_tokens.agent_id), then every other identity column that holds exactly
     ``marveen`` -- enumerated DATA-DRIVEN from ``sqlite_master`` + ``PRAGMA
     table_info`` at run time, NOT a hardcoded list. The ``agents`` dim table
     itself is EXCLUDED: the old ``marveen`` row is left intact for a later retire
     step (Stage N), we only ADD ``noa`` and repoint refs here.

SAFETY / SCOPE:
  * Only the EXACT string ``marveen`` is remapped. ``marveen-local`` (the retired
    local-Ollama agent) and every other distinct id are preserved untouched.
  * ``--db PATH`` is REQUIRED. There is no live default: you cannot accidentally
    run this against store/noa.db by omission.
  * Default mode is ``--dry-run`` (report counts, mutate nothing). ``--apply``
    performs the transaction. ``--dry-run`` and ``--apply`` are mutually exclusive.
  * Idempotent: a second ``--apply`` run finds 0 marveen identity cells and the
    noa row already present -> 0 changes, exit 0.

Exit codes: 0 success/clean, 2 bad args / missing DB, 3 FK violation after apply,
4 verification mismatch after apply.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time

OLD_ID = "marveen"
NEW_ID = "noa"
NEW_DISPLAY = "NoA"

# The agents dim table is handled specially (register noa, keep marveen row for a
# later retire step). Never bulk-remap its agent_id/display/other value columns
# here -- doing so would rename the PK row instead of adding a sibling.
AGENTS_TABLE = "agents"

# Columns in the agents table that may equal OLD_ID but are the dim-row's OWN
# data (not references to it) -- excluded from the generic value-remap scan.
_AGENTS_SELF_COLUMNS_EXCLUDED = True  # we exclude the whole agents table from scan


def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _fk_children_of_agents(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """Return [(table, column)] with a declared FK onto agents.agent_id."""
    out: list[tuple[str, str]] = []
    for (tname,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall():
        try:
            for fk in conn.execute(f"PRAGMA foreign_key_list('{tname}')").fetchall():
                # columns: id, seq, table, from, to, on_update, on_delete, match
                if fk[2] == AGENTS_TABLE:
                    out.append((tname, fk[3]))
        except sqlite3.Error:
            continue
    return out


def _scan_identity_cells(conn: sqlite3.Connection, value: str) -> dict[str, int]:
    """Count exact-match cells of ``value`` per ``table.column`` across the whole
    schema, EXCLUDING the agents dim table. Data-driven: every column of every
    user table is probed.

    Returns {"table.column": count} for count > 0.
    """
    ledger: dict[str, int] = {}
    for (tname,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall():
        if tname == AGENTS_TABLE:
            continue
        for ci in conn.execute(f"PRAGMA table_info('{tname}')").fetchall():
            cname = ci[1]
            try:
                n = conn.execute(
                    f"SELECT COUNT(*) FROM '{tname}' WHERE \"{cname}\" = ?", (value,)
                ).fetchone()[0]
            except sqlite3.Error:
                continue
            if n:
                ledger[f"{tname}.{cname}"] = n
    return ledger


def _ordered_targets(
    conn: sqlite3.Connection, ledger: dict[str, int]
) -> list[tuple[str, str, int]]:
    """Return [(table, column, count)] with FK-child columns FIRST (FK-safe under
    foreign_keys=ON once the noa parent row exists), then the rest, each group in
    descending count order for a stable, readable ledger."""
    fk_cols = {(t, c) for (t, c) in _fk_children_of_agents(conn)}
    fk_targets: list[tuple[str, str, int]] = []
    other_targets: list[tuple[str, str, int]] = []
    for key, cnt in ledger.items():
        tname, cname = key.split(".", 1)
        tup = (tname, cname, cnt)
        if (tname, cname) in fk_cols:
            fk_targets.append(tup)
        else:
            other_targets.append(tup)
    fk_targets.sort(key=lambda x: -x[2])
    other_targets.sort(key=lambda x: -x[2])
    return fk_targets + other_targets


def register_noa_row(conn: sqlite3.Connection) -> bool:
    """Clone the marveen agents row into a noa row (display='NoA') IF noa absent.
    Returns True if a new row was inserted, False if noa already existed."""
    existing = conn.execute(
        "SELECT 1 FROM agents WHERE agent_id = ?", (NEW_ID,)
    ).fetchone()
    if existing:
        return False
    marv = conn.execute(
        "SELECT * FROM agents WHERE agent_id = ?", (OLD_ID,)
    ).fetchone()
    if marv is None:
        raise RuntimeError(
            f"cannot register '{NEW_ID}': source row '{OLD_ID}' not in agents"
        )
    now = int(time.time())
    conn.execute(
        """INSERT INTO agents
             (agent_id, display, team, leader, model, domain_db, status, kind, created_at, retired_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            NEW_ID,
            NEW_DISPLAY,
            marv["team"],
            marv["leader"],
            marv["model"],
            marv["domain_db"],
            marv["status"],
            marv["kind"],
            marv["created_at"] if marv["created_at"] is not None else now,
            None,  # not retired
        ),
    )
    return True


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Remap agent id 'marveen' -> 'noa' (FK-safe, idempotent).")
    p.add_argument("--db", required=True, help="path to the noa.db-shaped DB (REQUIRED, no live default)")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="report counts, mutate nothing (DEFAULT)")
    mode.add_argument("--apply", action="store_true", help="perform the remap in a single transaction")
    args = p.parse_args(argv)

    apply = bool(args.apply)
    if not args.apply and not args.dry_run:
        # default is dry-run
        args.dry_run = True

    db_path = args.db
    if not os.path.exists(db_path):
        print(f"ERROR: --db path does not exist: {db_path}", file=sys.stderr)
        return 2
    # Guard: refuse the live store/noa.db by default path shape (defense in depth).
    if os.path.abspath(db_path).endswith(os.path.join("store", "noa.db")):
        print(
            "ERROR: refusing to operate on a path ending in store/noa.db. "
            "Run against a COPY (e.g. /tmp/noa-migtest.db).",
            file=sys.stderr,
        )
        return 2

    conn = _connect(db_path)

    # --- pre-state ledger ---
    ledger_marveen = _scan_identity_cells(conn, OLD_ID)
    ledger_noa_pre = _scan_identity_cells(conn, NEW_ID)
    noa_exists = conn.execute(
        "SELECT 1 FROM agents WHERE agent_id = ?", (NEW_ID,)
    ).fetchone() is not None
    marveen_local = _scan_identity_cells(conn, "marveen-local")  # for preservation proof
    pre_marveen_total = sum(ledger_marveen.values())
    pre_noa_total = sum(ledger_noa_pre.values())

    targets = _ordered_targets(conn, ledger_marveen)

    print(f"DB: {db_path}")
    print(f"mode: {'APPLY' if apply else 'DRY-RUN'}")
    print(f"noa agents row present: {noa_exists}")
    print(f"pre-state 'marveen' identity cells (excl. agents dim): {pre_marveen_total}")
    print(f"pre-state 'noa' identity cells (excl. agents dim): {pre_noa_total}")
    print(f"'marveen-local' cells (must be PRESERVED): {sum(marveen_local.values())}")
    print("per-column remap plan (FK children first):")
    for tname, cname, cnt in targets:
        print(f"  {cnt:>8}  {tname}.{cname}")

    if not apply:
        if not noa_exists:
            print("\n[dry-run] would REGISTER noa agents row (clone of marveen, display='NoA').")
        print("\n[dry-run] no changes written.")
        conn.close()
        return 0

    # --- APPLY: one transaction ---
    try:
        conn.execute("BEGIN")
        inserted = register_noa_row(conn)
        remapped_total = 0
        for tname, cname, _cnt in targets:
            cur = conn.execute(
                f"UPDATE '{tname}' SET \"{cname}\" = ? WHERE \"{cname}\" = ?",
                (NEW_ID, OLD_ID),
            )
            remapped_total += cur.rowcount
        conn.execute("COMMIT")
    except Exception as exc:  # noqa: BLE001
        conn.execute("ROLLBACK")
        print(f"ERROR: transaction rolled back: {exc}", file=sys.stderr)
        conn.close()
        return 3

    # --- post verification ---
    fk_viol = conn.execute("PRAGMA foreign_key_check").fetchall()
    post_marveen = sum(_scan_identity_cells(conn, OLD_ID).values())
    post_noa = sum(_scan_identity_cells(conn, NEW_ID).values())
    post_ml = sum(_scan_identity_cells(conn, "marveen-local").values())

    print(f"\n[apply] noa agents row inserted: {inserted}")
    print(f"[apply] identity cells remapped: {remapped_total}")
    print(f"[apply] post 'marveen' identity cells: {post_marveen} (expect 0)")
    print(f"[apply] post 'noa' identity cells: {post_noa}")
    print(f"[apply] 'marveen-local' cells after: {post_ml} (expect unchanged = {sum(marveen_local.values())})")
    print(f"[apply] PRAGMA foreign_key_check rows: {len(fk_viol)} (expect 0)")

    conn.close()

    if fk_viol:
        print("ERROR: FK violations after remap.", file=sys.stderr)
        return 3
    if post_marveen != 0:
        print("ERROR: residual 'marveen' identity cells after remap.", file=sys.stderr)
        return 4
    if post_noa != pre_noa_total + pre_marveen_total:
        print(
            f"ERROR: noa count {post_noa} != pre_noa {pre_noa_total} + remapped {pre_marveen_total}.",
            file=sys.stderr,
        )
        return 4
    if post_ml != sum(marveen_local.values()):
        print("ERROR: 'marveen-local' cell count changed.", file=sys.stderr)
        return 4
    print("\nOK: remap complete, FK-clean, marveen-local preserved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
