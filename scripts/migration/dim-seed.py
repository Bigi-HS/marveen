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

# --- class (c): owner + service ids ARE seeded (reclassified, card cfeb868b) -
# The owner (``dominik``) and the service/non-agent identifiers (``gate``,
# ``server``, ``fleet-supervisor``, ``appletype``) carry live FK-target rows in
# the core tables (74 rows total), so quarantining them was a FALSE-GREEN: M3
# FK-ON would reject those legit rows while dry-run reported fk_uncovered=[].
# They are now SEEDED with an explicit ``kind`` (owner / service) instead of
# ``agent``; the ``kind`` column keeps them out of the routable-agent set
# (see ``routable_agent_ids``) so a service/owner id is never messaged or issued
# a token even though it is a valid FK target.
OWNER_IDS: Tuple[str, ...] = ("dominik",)
SERVICE_IDS: Tuple[str, ...] = ("gate", "server", "fleet-supervisor", "appletype")

# --- quarantine: ONLY the synthetic test fixtures ---------------------------
# Expired / synthetic fixtures with no legitimate identity. These are NOT
# seeded; their stray rows across the core tables are PURGED in the --apply
# remediation (see ``run_seed``) so that post-apply ``quarantine_violations`` is
# empty and M3 FK-ON has nothing to reject.
QUARANTINE_IDS: Tuple[str, ...] = (
    "fake-admin",
    "dave-expired",
)

# --- purge-safe allowlist (card 5dd2d982) -----------------------------------
# The ONLY quarantined ids whose core-table rows may be PURGED on --apply: the
# synthetic test fixtures with no legitimate identity. Today this equals
# QUARANTINE_IDS, but keeping it an explicit, SEPARATE allowlist makes the
# purge-safety invariant load-bearing and forward-safe: if a REAL actor were ever
# (mis)classified into QUARANTINE_IDS (the blackbart/servo-skull class bug), the
# blanket purge would SILENTLY DELETE its legit historical rows. The seed instead
# treats a quarantined id that owns live FK-target rows but is NOT in this
# allowlist as MISCLASSIFIED and fails closed BEFORE any write (see
# ``misclassified_quarantine_ids`` and ``run_seed``). The purge is scoped to
# this allowlist, never to the whole QUARANTINE_IDS set.
SYNTHETIC_FIXTURES: Tuple[str, ...] = (
    "fake-admin",
    "dave-expired",
)


def kind_for(agent_id: str) -> str:
    """Classify a seeded agent_id: 'owner' for the Boss, 'service' for infra/
    non-routing identifiers, else 'agent'. Drives the dim-table ``kind`` column
    and, through it, ``routable_agent_ids``."""
    if agent_id in OWNER_IDS:
        return "owner"
    if agent_id in SERVICE_IDS:
        return "service"
    return "agent"

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
  kind       TEXT    NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','owner','service')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER
)"""

# Idempotent upsert (AC6): ON CONFLICT(agent_id) DO UPDATE -> 0 new rows on rerun.
UPSERT_SQL = """\
INSERT INTO agents (agent_id, display, team, leader, model, domain_db, status, kind, created_at, retired_at)
VALUES (:agent_id, :display, :team, :leader, :model, :domain_db, :status, :kind, :created_at, :retired_at)
ON CONFLICT(agent_id) DO UPDATE SET
  display   = excluded.display,
  team      = excluded.team,
  leader    = excluded.leader,
  model     = excluded.model,
  domain_db = excluded.domain_db,
  status    = excluded.status,
  kind      = excluded.kind"""


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
    config-derived roster + class-(b) config-less real agents + the remap targets
    + the reclassified owner/service ids (they carry live FK-target rows, so they
    MUST be seeded, with a non-'agent' ``kind``). Only the synthetic quarantine
    fixtures are excluded."""
    ids: Set[str] = set(load_roster(agents_dir))
    ids.update(CONFIGLESS_REAL_AGENTS)
    ids.update(REMAP.values())
    ids.update(OWNER_IDS)
    ids.update(SERVICE_IDS)
    # the synthetic fixtures are never seeded
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


def quarantine_ids_with_live_rows(db_path: Path) -> Dict[str, Dict[str, int]]:
    """HONEST quarantine check: for each QUARANTINE_ID, the per-(table,col) count
    of live CORE_TABLES rows it still owns (only entries with count>0 included).

    A quarantine bucket is only safe if every member owns ZERO core rows. The old
    code trusted the quarantine classification and SKIPPED these ids before the
    coverage test (the false-green): fk_uncovered=[] while 74 live FK-target rows
    sat on the quarantined ids. This function measures the rows directly, so a
    non-empty result is a hard signal that the --apply purge has not run (or that
    a new stray fixture row appeared). Read-only."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        out: Dict[str, Dict[str, int]] = {}
        for ident in sorted(QUARANTINE_IDS):
            per_col: Dict[str, int] = {}
            for table, col in CORE_TABLES:
                if not _table_exists(con, table):
                    continue
                n = con.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE {col}=?", (ident,)
                ).fetchone()[0]
                if n > 0:
                    per_col[f"{table}.{col}"] = n
            if per_col:
                out[ident] = per_col
        return out
    finally:
        con.close()


def misclassified_quarantine_ids(db_path: Path) -> Dict[str, Dict[str, int]]:
    """MISCLASSIFICATION guard (card 5dd2d982): quarantined ids that OWN live
    FK-target rows but are NOT in the purge-safe ``SYNTHETIC_FIXTURES`` allowlist.

    Such an id is a REAL actor wrongly quarantined (the blackbart/servo-skull
    class bug): blindly purging QUARANTINE_IDS would SILENTLY DELETE its legit
    historical rows (data loss). This is the honest filter over
    ``quarantine_ids_with_live_rows`` -- it keeps only the entries whose id is NOT
    a sanctioned synthetic fixture. A non-empty result means the seed MUST fail
    closed before any write/purge. Read-only."""
    allow = set(SYNTHETIC_FIXTURES)
    return {
        ident: per_col
        for ident, per_col in quarantine_ids_with_live_rows(db_path).items()
        if ident not in allow
    }


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
                "kind": kind_for(agent_id),
                "created_at": now,
                "retired_at": None,
            }
        )
    return rows


def fk_uncovered_core_ids(agents_dir: Path, db_path: Path) -> Set[str]:
    """Return the NON-quarantined live core-table ids whose normalized form is
    NOT in the seed. For M3 FK-ON to be safe this MUST be empty: any member is a
    legit row a foreign-key constraint would reject.

    Two distinct FK-safety signals, do not conflate them:
      * ``fk_uncovered`` (this function) = REAL actors missing from the seed
        (must be empty). Quarantined ids are skipped here, but quarantine now
        holds ONLY the 2 synthetic fixtures, so the skip is honest: dominik /
        gate / server / fleet-supervisor / appletype are genuinely SEEDED (with a
        non-'agent' kind) and therefore truly covered, not quarantine-hidden.
      * ``quarantine_ids_with_live_rows`` = quarantined fixture ids that still
        carry rows (must be empty AFTER the --apply purge). This is the honest
        counter-check that the quarantine bucket owns zero core rows."""
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


def routable_agent_ids(db_path: Path) -> Set[str]:
    """Canonical ROUTABLE-agent filter: the seeded dim-table ids whose
    ``kind = 'agent'`` (read-only).

    SECURITY INVARIANT (spec AC g). This is the single filter every future
    consumer -- inter-agent routing, token issuance, roster generation -- MUST
    use when it starts reading the ``agents`` dim-table, so that seeded
    ``service`` / ``owner`` rows are NEVER treated as routable/messageable
    agents. Concretely: nobody can message ``gate`` / ``fleet-supervisor`` /
    ``server`` / ``appletype`` and no token is ever issued to the owner
    ``dominik``, even though all of them are valid FK targets for historical
    core-table rows.

    NOTE: no live consumer reads the ``agents`` dim-table yet -- routing, token
    issuance and roster generation currently derive from the filesystem agent
    config. This establishes the FORWARD contract so that when a consumer does
    migrate to the dim-table it has the correct, already-tested filter to use
    instead of ``SELECT agent_id FROM agents`` unfiltered."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if not _table_exists(con, "agents"):
            return set()
        rows = con.execute(
            "SELECT agent_id FROM agents WHERE kind = 'agent'"
        ).fetchall()
        return {str(r[0]) for r in rows}
    finally:
        con.close()


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


def _purge_fixtures(con: sqlite3.Connection) -> int:
    """Remediation purge, SCOPED to the ``SYNTHETIC_FIXTURES`` allowlist only
    (card 5dd2d982): delete the synthetic fixture rows across the 4 core tables so
    post-apply ``quarantine_violations`` is empty and M3 FK-ON has nothing to
    reject. NEVER a blanket ``QUARANTINE_IDS`` delete -- a non-fixture quarantined
    id's rows must never be silently deleted (that path fails closed earlier via
    ``misclassified_quarantine_ids``). Idempotent: re-running deletes 0. Returns
    the number of rows deleted."""
    purged = 0
    for ident in SYNTHETIC_FIXTURES:
        for table, col in CORE_TABLES:
            if not _table_exists(con, table):
                continue
            cur = con.execute(f"DELETE FROM {table} WHERE {col}=?", (ident,))
            purged += cur.rowcount
    return purged


def run_seed(db_path: Path, agents_dir: Path, *, apply: bool) -> Dict:
    """Build the seed plan; with apply=True, snapshot then CREATE+upsert.

    FAIL-CLOSED (card 5dd2d982): if any quarantined id owns live FK-target rows
    but is NOT a sanctioned synthetic fixture, it is MISCLASSIFIED (a real actor
    wrongly quarantined). The result surfaces it under ``misclassified``, no write
    or purge happens, and ``main`` turns the non-empty set into a non-zero exit.
    This check runs for BOTH dry-run and --apply, BEFORE any mutation, so a
    misclassified actor's legit rows are never silently deleted.

    Returns a dict with the plan + (on apply) the number of rows actually
    inserted-new (0 on a repeat run => idempotent)."""
    if not db_path.is_file():
        raise FileNotFoundError(f"database not found: {db_path}")

    rows = build_seed_rows(agents_dir, db_path)
    uncovered = fk_uncovered_core_ids(agents_dir, db_path)
    violations = quarantine_ids_with_live_rows(db_path)
    misclassified = misclassified_quarantine_ids(db_path)
    result: Dict = {
        "apply": apply,
        "seed_rows": rows,
        "quarantined": sorted(QUARANTINE_IDS),
        "synthetic_fixtures": sorted(SYNTHETIC_FIXTURES),
        "fk_uncovered": sorted(uncovered),
        # honest counter-signal: quarantined fixture ids that still carry rows.
        # Must be empty AFTER the --apply purge below.
        "quarantine_violations": violations,
        # fail-closed signal: quarantined REAL actors (not synthetic fixtures)
        # that own live rows. Non-empty => main() returns non-zero, no purge.
        "misclassified": misclassified,
        "snapshot": None,
        "inserted": 0,
        "purged": 0,
    }

    # Fail-closed BEFORE any write/purge (both dry-run AND --apply). A
    # misclassified real actor's rows are NEVER deleted.
    if misclassified:
        return result

    if not apply:
        # Dry-run: delete nothing, but surface WHAT the --apply purge would remove
        # (same shape as quarantine_violations, restricted to the fixture ids).
        result["purge_plan"] = violations
        return result  # dry-run: no write path reached

    snap = _snapshot(db_path)
    result["snapshot"] = str(snap)

    con = sqlite3.connect(db_path)
    try:
        con.execute(CREATE_AGENTS_SQL)
        before = con.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
        con.executemany(UPSERT_SQL, rows)
        purged = _purge_fixtures(con)
        con.commit()
        after = con.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
    finally:
        con.close()
    result["inserted"] = after - before
    result["purged"] = purged
    # Re-measure AFTER the purge so the reported signal reflects the mutated DB.
    result["quarantine_violations"] = quarantine_ids_with_live_rows(db_path)
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
    lines.append(f"quarantined (synthetic fixtures, NOT seeded): {len(result['quarantined'])}")
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
    viol = result.get("quarantine_violations") or {}
    if viol:
        label = (
            "post-apply (must be empty)" if result["apply"] else "PURGE-PLAN (what --apply removes)"
        )
        lines.append(f"QUARANTINE-VIOLATIONS {label}: fixture ids still carrying live rows:")
        for ident in sorted(viol):
            per = ", ".join(f"{k}={v}" for k, v in sorted(viol[ident].items()))
            lines.append(f"   {ident}: {per}")
    else:
        lines.append("QUARANTINE-VIOLATIONS: none -- no fixture id carries a live core row.")
    lines.append("")
    misc = result.get("misclassified") or {}
    if misc:
        lines.append(
            "MISCLASSIFICATION: FAIL-CLOSED -- these quarantined ids own live "
            "FK-target rows but are NOT synthetic fixtures (real actors wrongly "
            "quarantined). NOTHING was purged; resolve the classification first:"
        )
        for ident in sorted(misc):
            per = ", ".join(f"{k}={v}" for k, v in sorted(misc[ident].items()))
            lines.append(f"   {ident}: {per}")
        lines.append("")
    if result["apply"]:
        lines.append(f"snapshot: {result['snapshot']}")
        lines.append(f"rows inserted-new: {result['inserted']} (0 on a repeat run)")
        lines.append(f"fixture rows purged: {result['purged']} (0 on a repeat run)")
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

    # Fail-closed exit gating (card 5dd2d982), gate-style non-zero=3:
    #  * a misclassified real actor was quarantined (pre-write guard), OR
    #  * after an --apply purge a fixture still carries live rows (post-apply
    #    assert: the purge failed to clear).
    if result.get("misclassified"):
        return 3
    if result["apply"] and result.get("quarantine_violations"):
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
