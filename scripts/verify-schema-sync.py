#!/usr/bin/env python3
"""Verify two SQLite DBs share the same structural schema (spec A1 v5, AC-5).

Compares, order-insensitively:
  - table names          (ignoring sqlite_* internal tables, incl. sqlite_sequence)
  - columns + types       per table
  - index names + SQL    (ignoring auto-generated sqlite_autoindex_*)
  - trigger names + SQL

A path of ":memory:" is materialized from the canonical DDL file
(scripts/schema-noa.sql, overridable via SCHEMA_PATH) -- this is how AC-1 is
checked: `verify-schema-sync.py store/noa.db :memory:`.

Exit 0 when the two schemas are structurally identical, 1 otherwise (with a
human-readable diff on stdout).

Usage: python3 scripts/verify-schema-sync.py <db-a> <db-b>
"""
import os
import re
import sqlite3
import sys
from pathlib import Path


def _default_schema_path() -> Path:
    return Path(__file__).resolve().parent / "schema-noa.sql"


def _norm(sql: str) -> str:
    """Canonicalize DDL for comparison: lowercase, collapse whitespace, tighten
    punctuation so pure reformatting is not reported as a difference."""
    s = (sql or "").lower()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*([(),])\s*", r"\1", s)
    return s.strip()


def _connect(path: str) -> sqlite3.Connection:
    if path == ":memory:":
        schema_path = Path(os.environ.get("SCHEMA_PATH", _default_schema_path()))
        conn = sqlite3.connect(":memory:")
        conn.executescript(schema_path.read_text(encoding="utf-8"))
        return conn
    if not Path(path).exists():
        print(f"ERROR: DB not found: {path}", file=sys.stderr)
        sys.exit(2)
    return sqlite3.connect(path)


def _schema(conn: sqlite3.Connection):
    tables = {}
    for (tname,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall():
        cols = {}
        # Parameterized table-valued form (SQLite 3.16+) -- a bound argument is
        # safe against table names carrying quotes; f-string interpolation into a
        # bare PRAGMA would break on a crafted DB (Chad hardening).
        for row in conn.execute(
            "SELECT name, type FROM pragma_table_info(?)", (tname,)
        ).fetchall():
            cols[row[0]] = (row[1] or "").upper()
        tables[tname] = cols

    indexes = {}
    for name, sql in conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='index'"
    ).fetchall():
        if name.startswith("sqlite_autoindex_"):
            continue
        indexes[name] = _norm(sql)

    triggers = {}
    for name, sql in conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='trigger'"
    ).fetchall():
        triggers[name] = _norm(sql)

    return tables, indexes, triggers


def _diff_sets(kind, a, b, out):
    only_a = sorted(set(a) - set(b))
    only_b = sorted(set(b) - set(a))
    if only_a:
        out.append(f"{kind} only in A: {', '.join(only_a)}")
    if only_b:
        out.append(f"{kind} only in B: {', '.join(only_b)}")
    return not only_a and not only_b


def main(argv) -> int:
    if len(argv) != 3:
        print("usage: verify-schema-sync.py <db-a> <db-b>", file=sys.stderr)
        return 2
    a = _connect(argv[1])
    b = _connect(argv[2])
    ta, ia, ga = _schema(a)
    tb, ib, gb = _schema(b)

    diffs = []

    _diff_sets("table", ta, tb, diffs)
    for t in sorted(set(ta) & set(tb)):
        ca, cb = ta[t], tb[t]
        for col in sorted(set(ca) - set(cb)):
            diffs.append(f"table {t}: column only in A: {col}")
        for col in sorted(set(cb) - set(ca)):
            diffs.append(f"table {t}: column only in B: {col}")
        for col in sorted(set(ca) & set(cb)):
            if ca[col] != cb[col]:
                diffs.append(f"table {t}.{col}: type A={ca[col]!r} B={cb[col]!r}")

    _diff_sets("index", ia, ib, diffs)
    for idx in sorted(set(ia) & set(ib)):
        if ia[idx] != ib[idx]:
            diffs.append(f"index {idx}: SQL differs\n    A: {ia[idx]}\n    B: {ib[idx]}")

    _diff_sets("trigger", ga, gb, diffs)
    for tg in sorted(set(ga) & set(gb)):
        if ga[tg] != gb[tg]:
            diffs.append(f"trigger {tg}: SQL differs")

    if diffs:
        print("SCHEMA MISMATCH:")
        for d in diffs:
            print("  - " + d)
        return 1
    print("Schema sync OK: tables, columns, indexes, triggers all match.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
