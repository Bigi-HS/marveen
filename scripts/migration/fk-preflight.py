#!/usr/bin/env python3
"""M0 orphan-census preflight for the fleet-DB all-agents plan (card 26ba217a).

This is milestone M0 only: a NON-MUTATING, read-only census that scans every
core table for orphan ``agent_id``-like values -- rows whose agent identifier
has no matching roster entry -- and prints a report. It NEVER writes to the DB.

Why it exists (spec store/spec-fleet-db-all-agents-26ba217a.md, section 5 "M0"):
the section 4.2 FK phase can only be switched on AFTER the orphan set is empty,
because with ``PRAGMA foreign_keys=ON`` an orphan ``agent_id`` would make the
INSERT raise IntegrityError. This script is the dry-run proof of what would
break, printed as a report, so a human can decide the cleanup BEFORE any
mutation.

Design contract (falsifiable, per spec AC4 / AC7 and Thor tests T3/T6):
  * The four core tables + their agent-id columns are a FIXED, enumerated set,
    so T3 can assert the report covers ALL of them (not a sample):
        kanban_cards.assignee
        memories.agent_id
        agent_messages.from_agent
        agent_tokens.agent_id
  * The DB is opened read-only (``?mode=ro`` URI) -- a write attempt would
    itself raise, which is a second line of defence behind "no write code path".
  * There is NO ``--apply`` that mutates anything in M0. The flag is accepted
    only so the dry-run contract can be exercised: with OR without it the DB
    mtime does NOT change (T6). M0 has no mutating branch at all.
  * The roster source is machine-derived from ``agents/*/agent-config.json``
    (the same dirs ``gen-fleet-roster.py`` reads) plus the orchestrator
    ``marveen`` (which lives at the project root, not under agents/). This is
    NOT a hand-kept list. Until the ``agents`` dim-table exists (M1), the
    on-disk config dirs ARE the canonical roster.

Exit code: 0 when the census ran (regardless of whether orphans were found --
M0 only reports; it does not gate on its own). Non-zero only on operational
failure (DB missing, roster source missing).

Usage:
    python3 scripts/migration/fk-preflight.py                 # live DB + live roster
    python3 scripts/migration/fk-preflight.py --db /path/noa.db --agents-dir /path/agents
    python3 scripts/migration/fk-preflight.py --json          # machine-readable report
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple

# ---------------------------------------------------------------------------
# FIXED enumerated core-table set. Keep this tuple authoritative: T3 asserts the
# report covers EVERY entry here. (table, agent_id_column)
# ---------------------------------------------------------------------------
CORE_TABLES: Tuple[Tuple[str, str], ...] = (
    ("kanban_cards", "assignee"),
    ("memories", "agent_id"),
    ("agent_messages", "from_agent"),
    ("agent_tokens", "agent_id"),
)

# Orchestrator lives at the project root, not under agents/, so it is never a
# config-dir but IS a valid roster member.
ROOT_ONLY_AGENTS: Tuple[str, ...] = ("marveen",)

_HERE = Path(__file__).resolve().parent
_PROJECT_ROOT = _HERE.parent.parent  # scripts/migration/ -> scripts/ -> root


def default_db_path() -> Path:
    return _PROJECT_ROOT / "store" / "noa.db"


def default_agents_dir() -> Path:
    return _PROJECT_ROOT / "agents"


def load_roster(agents_dir: Path) -> Set[str]:
    """Canonical roster = every dir under agents_dir that holds an
    agent-config.json, plus the root-only orchestrator(s).

    Machine-derived, NOT a hand-kept list (spec AC3 / section 4.1 seed source).
    """
    if not agents_dir.is_dir():
        raise FileNotFoundError(f"agents dir not found: {agents_dir}")
    roster: Set[str] = set(ROOT_ONLY_AGENTS)
    for child in sorted(agents_dir.iterdir()):
        if child.is_dir() and (child / "agent-config.json").is_file():
            roster.add(child.name)
    return roster


def _table_exists(con: sqlite3.Connection, table: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def census(con: sqlite3.Connection, roster: Set[str]) -> List[Dict]:
    """Scan every core table. Returns one entry per core table (ALWAYS all of
    them, present or not -- T3), each with its distinct values and the orphan
    subset (distinct values not in the roster).
    """
    report: List[Dict] = []
    for table, col in CORE_TABLES:
        entry: Dict = {
            "table": table,
            "column": col,
            "present": _table_exists(con, table),
            "distinct": [],
            "orphans": [],
        }
        if entry["present"]:
            # NULLs are not agent bindings -> excluded from the census.
            rows = con.execute(
                f"SELECT DISTINCT {col} FROM {table} WHERE {col} IS NOT NULL"
            ).fetchall()
            values = sorted(str(r[0]) for r in rows)
            entry["distinct"] = values
            entry["orphans"] = [v for v in values if v not in roster]
        report.append(entry)
    return report


def all_orphans(report: List[Dict]) -> Set[str]:
    out: Set[str] = set()
    for entry in report:
        out.update(entry["orphans"])
    return out


def run_census(db_path: Path, agents_dir: Path) -> Tuple[List[Dict], Set[str]]:
    """Open the DB READ-ONLY and run the census. No write path exists here."""
    if not db_path.is_file():
        raise FileNotFoundError(f"database not found: {db_path}")
    roster = load_roster(agents_dir)
    # mode=ro: any accidental write would raise sqlite3.OperationalError.
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        report = census(con, roster)
    finally:
        con.close()
    return report, roster


def format_text(report: List[Dict], roster: Set[str]) -> str:
    lines: List[str] = []
    lines.append("M0 orphan-census preflight (card 26ba217a) -- READ-ONLY, no mutation")
    lines.append(f"roster size: {len(roster)} agents")
    lines.append("")
    orphans = all_orphans(report)
    for entry in report:
        tag = "" if entry["present"] else "  [TABLE MISSING]"
        lines.append(f"== {entry['table']}.{entry['column']}{tag} ==")
        lines.append(
            f"   distinct agent_ids: {len(entry['distinct'])}"
            f"   orphans: {len(entry['orphans'])}"
        )
        if entry["orphans"]:
            lines.append(f"   ORPHANS: {', '.join(entry['orphans'])}")
        lines.append("")
    lines.append(f"TOTAL distinct orphan agent_ids across all core tables: {len(orphans)}")
    if orphans:
        lines.append(f"   {', '.join(sorted(orphans))}")
        lines.append("")
        lines.append(
            "FK phase (section 4.2) is BLOCKED until these orphans are resolved: "
            "with PRAGMA foreign_keys=ON an orphan agent_id INSERT raises IntegrityError."
        )
    else:
        lines.append("No orphans. FK-phase orphan precondition is GREEN.")
    return "\n".join(lines)


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="M0 non-mutating orphan-census for the fleet-DB FK preflight (card 26ba217a).",
    )
    parser.add_argument("--db", type=Path, default=None, help="path to noa.db (default: live store/noa.db)")
    parser.add_argument(
        "--agents-dir", type=Path, default=None, help="path to agents/ roster dir (default: live agents/)"
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON report")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="ACCEPTED BUT A NO-OP in M0: M0 is report-only and never mutates. "
        "Present so the dry-run contract (DB mtime unchanged with or without it) is testable.",
    )
    args = parser.parse_args(argv)

    db_path = (args.db or default_db_path()).resolve()
    agents_dir = (args.agents_dir or default_agents_dir()).resolve()

    try:
        report, roster = run_census(db_path, agents_dir)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(
            json.dumps(
                {
                    "roster_size": len(roster),
                    "roster": sorted(roster),
                    "tables": report,
                    "all_orphans": sorted(all_orphans(report)),
                },
                indent=2,
            )
        )
    else:
        print(format_text(report, roster))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
