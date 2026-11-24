#!/usr/bin/env python3
"""M1 ``agents`` dim-table + idempotent seed, with the explicit three-class
roster normalize pass over the M0 live-census orphans (cards 26ba217a / 5fd6853b).

This is milestone M1 of the fleet-DB all-agents plan
(store/spec-fleet-db-all-agents-26ba217a.md, section 5 "M1"). It mirrors the
merged M0 ``fk-preflight.py`` pattern: same ``load_roster()`` config-dir source,
same ``CORE_TABLES`` enumerated set, same dry-run-default / ``--apply``-gated
contract, same read-only census of the live orphans.

Why it exists
-------------
M0 proved that the live core tables carry orphan ``agent_id`` values that have no
roster entry. With ``PRAGMA foreign_keys=ON`` (M3) an orphan would make an INSERT
raise IntegrityError. Before M3 can switch FK on, the roster seed-source must be
NORMALIZED so that every *legitimate* core-table id resolves to a seeded
``agents.agent_id``. This script does that normalize deterministically, in three
explicit classes, and emits the idempotent seed.

The three normalize classes (verified against the M0 live census orphans
Dave, Genesis, appletype, blackbart, dampier, dave-expired, dominik, fake-admin,
fleet-supervisor, gate, gelim, gourmet, hibiki, kerrigan, server, servo-skull)
-----------------------------------------------------------------------------
(a) case / remap  -- a bare-string id that IS a known agent under a different
    spelling. ``Dave`` -> ``dave`` is a casefold. ``Genesis`` / ``genesis`` ->
    ``marveen`` is a REMAP, NOT a casefold: ``genesis`` is the fleet brand, the
    canonical live-infra actor id is ``marveen`` (see memory
    shared-fleet-db-canonical-agent-id-marveen-genesis-remap-not-casefold-1124).
    A naive ``.lower()`` would leave a phantom ``genesis`` row and FK-fail.
(b) config-less real agents -- ``dampier, hibiki, gourmet, kerrigan, gelim,
    blackbart, servo-skull``: real fleet members that ``load_roster()`` (which
    keys on the config file) misses, either because they have an
    ``agents/<name>/`` dir but ship no ``agent-config.json`` (dampier/hibiki/
    gourmet/kerrigan/gelim), or because they have no ``agents/<name>/`` dir at
    all yet carry real actor-rows in the FK-target columns (blackbart=248,
    servo-skull=56 incl ``agent_tokens.agent_id``). Quarantining the latter
    would make M3 FK-ON reject their legit rows, so all of these are ADDED to
    the dim-seed source explicitly.
(c) service / non-agent ids + test fixtures -- ``server, gate, fleet-supervisor,
    appletype, dominik`` (infra/service identifiers or the owner, not routing
    agents) plus the test fixtures ``fake-admin`` and ``dave-expired``. These
    are QUARANTINED: listed but NOT seeded. A quarantined
    id is intentionally excluded from the FK-coverage set -- the corresponding
    legacy rows are cleaned up separately before M3, they are not seeded.

Design contract (falsifiable, spec AC2/AC3/AC6/AC7)
---------------------------------------------------
  * AC2 -- emits ``CREATE TABLE IF NOT EXISTS agents (...)`` with PK=agent_id,
    the shape the 4 core-table FKs (section 4.2) will point at.
  * AC3 -- seed source is machine-derived: ``load_roster()`` config dirs +
    ``ROOT_ONLY_AGENTS`` + the class-(b) list + class-(a) remaps of live orphans;
    NOT a hand-kept row list.
  * AC6 -- ``INSERT ... ON CONFLICT(agent_id) DO UPDATE`` upsert: a second
    ``--apply`` run inserts 0 NEW rows.
  * AC7 -- dry-run default. Nothing is written without ``--apply``; with
    ``--apply`` a DB snapshot is taken BEFORE any mutation.

FK precondition (the load-bearing M3 claim)
-------------------------------------------
``fk_uncovered_core_ids()`` returns the set of NON-quarantined core-table
agent_ids that do NOT resolve to a seeded ``agent_id`` after normalize. For M3
FK-ON to be safe this set must be EMPTY -- any member would be a legit row that a
foreign-key constraint would reject. This is the M1->M3 gate.

Usage:
    python3 scripts/migration/dim-seed.py                 # live DB + live roster, DRY-RUN
    python3 scripts/migration/dim-seed.py --json          # machine-readable plan
    python3 scripts/migration/dim-seed.py --apply         # snapshot + CREATE + seed (Boss-GO)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Dict, List, Set, Tuple

# ---------------------------------------------------------------------------
# FIXED enumerated core-table set -- identical to fk-preflight.py M0.
# (table, agent_id_column)
# ---------------------------------------------------------------------------
CORE_TABLES: Tuple[Tuple[str, str], ...] = (
    ("kanban_cards", "assignee"),
    ("memories", "agent_id"),
    ("agent_messages", "from_agent"),
    ("agent_tokens", "agent_id"),
)

# Orchestrator lives at the project root, not under agents/, so it is never a
# config-dir but IS a valid roster member. Mirrors fk-preflight.py.
ROOT_ONLY_AGENTS: Tuple[str, ...] = ("marveen",)

# --- class (a): case / remap ------------------------------------------------
# A remap is NOT a casefold: the source id resolves to a DIFFERENT canonical id.
# ``genesis`` is the fleet brand, not an actor -> the live-infra actor is
# ``marveen``. A plain .lower() would leave a phantom 'genesis' row.
REMAP: Dict[str, str] = {
    "genesis": "marveen",
}

# --- class (b): config-less real agents -------------------------------------
# Real fleet members that load_roster() (keyed on the config file) misses, so
# they are added explicitly. Two sub-cases: (1) an agents/<name>/ dir but no
# agent-config.json (dampier/hibiki/gourmet/kerrigan/gelim); (2) no
# agents/<name>/ dir at all yet real actor-rows in FK-target columns
# (blackbart=248, servo-skull=56 incl agent_tokens.agent_id) -- quarantining
# those would make M3 FK-ON reject their legit rows, so they are seeded.
CONFIGLESS_REAL_AGENTS: Tuple[str, ...] = (
    "dampier",
    "hibiki",
    "gourmet",
    "kerrigan",
    "gelim",
    "blackbart",
    "servo-skull",
)

# --- class (c): service / non-agent ids + test fixtures ---------------------
# Infra/service identifiers (not routing agents) + the owner + known test
# fixtures. Quarantined: listed, NOT seeded, and excluded from FK coverage.
QUARANTINE_IDS: Tuple[str, ...] = (
    # service / non-agent
    "server",
    "gate",
    "fleet-supervisor",
    "appletype",
    "dominik",
    # test fixtures (expired / synthetic)
    "fake-admin",
    "dave-expired",
)

_HERE = Path(__file__).resolve().parent
_PROJECT_ROOT = _HERE.parent.parent  # scripts/migration/ -> scripts/ -> root


# ---------------------------------------------------------------------------
# agents dim-table DDL (AC2). PK=agent_id, the FK target for section 4.2.
# ---------------------------------------------------------------------------
CREATE_AGENTS_SQL = """\
CREATE TABLE IF NOT EXISTS agents (
  agent_id   TEXT PRIMARY KEY,
  display    TEXT NOT NULL,
  team       TEXT,
  leader     TEXT,
  model      TEXT,
  domain_db  INTEGER NOT NULL DEFAULT 0,
  status     TEXT,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
)"""

# Idempotent upsert (AC6): ON CONFLICT(agent_id) DO UPDATE -> 0 new rows on rerun.
UPSERT_SQL = """\
INSERT INTO agents (agent_id, display, team, leader, model, domain_db, status, created_at, retired_at)
VALUES (:agent_id, :display, :team, :leader, :model, :domain_db, :status, :created_at, :retired_at)
ON CONFLICT(agent_id) DO UPDATE SET
  display   = excluded.display,
  team      = excluded.team,
  leader    = excluded.leader,
  model     = excluded.model,
  domain_db = excluded.domain_db,
  status    = excluded.status"""


def default_db_path() -> Path:
    return _PROJECT_ROOT / "store" / "noa.db"


def default_agents_dir() -> Path:
    return _PROJECT_ROOT / "agents"


# ---------------------------------------------------------------------------
# roster source (mirrors fk-preflight.load_roster) + three-class normalize
# ---------------------------------------------------------------------------
def load_roster(agents_dir: Path) -> Set[str]:
    """Canonical config-derived roster = every dir under agents_dir that holds an
    agent-config.json, plus the root-only orchestrator(s). Machine-derived
    (spec AC3). Identical semantics to fk-preflight.py."""
    if not agents_dir.is_dir():
        raise FileNotFoundError(f"agents dir not found: {agents_dir}")
    roster: Set[str] = set(ROOT_ONLY_AGENTS)
    for child in sorted(agents_dir.iterdir()):
        if child.is_dir() and (child / "agent-config.json").is_file():
            roster.add(child.name)
    return roster


def is_quarantined(ident: str) -> bool:
    """Class (c): service/non-agent id or test fixture -> quarantined, never
    seeded. Case-insensitive on the bare id so 'Fake-Admin' is caught too."""
    return ident in QUARANTINE_IDS or ident.casefold() in {
        q.casefold() for q in QUARANTINE_IDS
    }


def normalize_id(ident: str) -> str | None:
    """Three-class normalize of a single bare core-table id to its canonical
    seeded agent_id, or None if it is quarantined (class c).

    class (a) remap  -> REMAP[casefold]           (e.g. Genesis -> marveen)
    class (a) casefold -> ident.casefold()        (e.g. Dave -> dave)
    class (c) quarantine -> None
    """
    if is_quarantined(ident):
        return None
    folded = ident.casefold()
    if folded in REMAP:
        return REMAP[folded]
    return folded


def seed_source_ids(agents_dir: Path) -> Set[str]:
    """The canonical set of agent_ids that WILL be seeded into the dim-table:
    config-derived roster + class-(b) config-less real agents + the remap targets.
    Quarantined ids are never here."""
    ids: Set[str] = set(load_roster(agents_dir))
    ids.update(CONFIGLESS_REAL_AGENTS)
    ids.update(REMAP.values())
    # a remap target must itself be non-quarantined
    ids = {i for i in ids if not is_quarantined(i)}
    return ids


# ---------------------------------------------------------------------------
# read-only census of the live core-table ids (mirrors fk-preflight)
# ---------------------------------------------------------------------------
def _table_exists(con: sqlite3.Connection, table: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def live_core_ids(db_path: Path) -> Set[str]:
    """Distinct non-NULL agent-id values across the 4 core tables, read-only."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        out: Set[str] = set()
        for table, col in CORE_TABLES:
            if not _table_exists(con, table):
                continue
            rows = con.execute(
                f"SELECT DISTINCT {col} FROM {table} WHERE {col} IS NOT NULL"
            ).fetchall()
            out.update(str(r[0]) for r in rows)
        return out
    finally:
        con.close()


# ---------------------------------------------------------------------------
# seed-row construction + FK-coverage check
# ---------------------------------------------------------------------------
def _display_for(agent_id: str) -> str:
    return agent_id


def build_seed_rows(agents_dir: Path, db_path: Path) -> List[Dict]:
    """Build the idempotent seed rows: one row per canonical seeded agent_id.

    The source set is EXACTLY the deterministic ``seed_source_ids``: config-derived
    roster + class-(b) config-less real agents + class-(a) remap targets. It does
    NOT auto-absorb arbitrary live core ids -- doing so would make
    ``fk_uncovered_core_ids`` vacuously green (every live id would be seeded by
    construction). A live id that is neither config, nor class-(b), nor a known
    remap MUST surface as uncovered so a human assigns it a class before M3,
    rather than silently seeding an unknown identity.

    The ``db_path`` argument is accepted (and validated by the caller) for
    signature symmetry with ``fk_uncovered_core_ids`` and future per-db display
    enrichment; the seed set itself is db-independent and fully deterministic."""
    ids: Set[str] = set(seed_source_ids(agents_dir))
    now = int(time.time())
    rows: List[Dict] = []
    for agent_id in sorted(ids):
        rows.append(
            {
                "agent_id": agent_id,
                "display": _display_for(agent_id),
                "team": None,
                "leader": None,
                "model": None,
                "domain_db": 0,
                "status": None,
                "created_at": now,
                "retired_at": None,
            }
        )
    return rows


def fk_uncovered_core_ids(agents_dir: Path, db_path: Path) -> Set[str]:
    """Return the NON-quarantined live core-table ids whose normalized form is
    NOT in the seed. For M3 FK-ON to be safe this MUST be empty: any member is a
    legit row a foreign-key constraint would reject."""
    seeded = {r["agent_id"] for r in build_seed_rows(agents_dir, db_path)}
    uncovered: Set[str] = set()
    for raw in live_core_ids(db_path):
        if is_quarantined(raw):
            continue
        norm = normalize_id(raw)
        if norm is None:
            continue  # quarantined
        if norm not in seeded:
            uncovered.add(raw)
    return uncovered


# ---------------------------------------------------------------------------
# apply (snapshot-gated, idempotent)
# ---------------------------------------------------------------------------
def _snapshot(db_path: Path) -> Path:
    """Copy the DB to a timestamped .bak next to it, preserving perms, BEFORE
    any mutation (spec section 5 safety bound a)."""
    stamp = time.strftime("%Y%m%dT%H%M%S")
    dest = db_path.with_name(f"{db_path.name}.{stamp}.bak")
    shutil.copy2(db_path, dest)
    os.chmod(dest, 0o600)  # noa.db holds tokens -- restrict snapshot perms
    return dest


def run_seed(db_path: Path, agents_dir: Path, *, apply: bool) -> Dict:
    """Build the seed plan; with apply=True, snapshot then CREATE+upsert.

    Returns a dict with the plan + (on apply) the number of rows actually
    inserted-new (0 on a repeat run => idempotent)."""
    if not db_path.is_file():
        raise FileNotFoundError(f"database not found: {db_path}")

    rows = build_seed_rows(agents_dir, db_path)
    uncovered = fk_uncovered_core_ids(agents_dir, db_path)
    result: Dict = {
        "apply": apply,
        "seed_rows": rows,
        "quarantined": sorted(QUARANTINE_IDS),
        "fk_uncovered": sorted(uncovered),
        "snapshot": None,
        "inserted": 0,
    }

    if not apply:
        return result  # dry-run: no write path reached

    snap = _snapshot(db_path)
    result["snapshot"] = str(snap)

    con = sqlite3.connect(db_path)
    try:
        con.execute(CREATE_AGENTS_SQL)
        before = con.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
        con.executemany(UPSERT_SQL, rows)
        con.commit()
        after = con.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
    finally:
        con.close()
    result["inserted"] = after - before
    return result


# ---------------------------------------------------------------------------
# text / json rendering
# ---------------------------------------------------------------------------
def format_text(result: Dict) -> str:
    lines: List[str] = []
    mode = "APPLY (mutating)" if result["apply"] else "DRY-RUN (no write)"
    lines.append(f"M1 agents dim-seed (card 5fd6853b) -- {mode}")
    lines.append("")
    lines.append("-- DDL --")
    lines.append(CREATE_AGENTS_SQL)
    lines.append("")
    lines.append(f"seed rows: {len(result['seed_rows'])}")
    lines.append(f"   {', '.join(r['agent_id'] for r in result['seed_rows'])}")
    lines.append("")
    lines.append(f"quarantined (NOT seeded, class c): {len(result['quarantined'])}")
    lines.append(f"   {', '.join(result['quarantined'])}")
    lines.append("")
    if result["fk_uncovered"]:
        lines.append(
            "FK-COVERAGE: BLOCKED -- these non-quarantined live core ids are NOT "
            "in the seed, M3 FK-ON would reject them:"
        )
        lines.append(f"   {', '.join(result['fk_uncovered'])}")
    else:
        lines.append(
            "FK-COVERAGE: GREEN -- every non-quarantined live core id maps to a "
            "seeded agent_id; M3 FK-ON would not reject a legit row."
        )
    lines.append("")
    if result["apply"]:
        lines.append(f"snapshot: {result['snapshot']}")
        lines.append(f"rows inserted-new: {result['inserted']} (0 on a repeat run)")
    else:
        lines.append("dry-run: nothing written. Re-run with --apply (Boss-GO) to seed.")
    return "\n".join(lines)


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="M1 agents dim-table + idempotent three-class normalize seed (card 5fd6853b)."
    )
    parser.add_argument("--db", type=Path, default=None, help="path to noa.db (default: live store/noa.db)")
    parser.add_argument(
        "--agents-dir", type=Path, default=None, help="path to agents/ roster dir (default: live agents/)"
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable plan")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="WRITE the DB: snapshot, CREATE TABLE IF NOT EXISTS agents, idempotent upsert seed. "
        "Default is DRY-RUN (no write). Needs Boss-GO per spec section 5.",
    )
    args = parser.parse_args(argv)

    db_path = (args.db or default_db_path()).resolve()
    agents_dir = (args.agents_dir or default_agents_dir()).resolve()

    try:
        result = run_seed(db_path, agents_dir, apply=args.apply)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(format_text(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
