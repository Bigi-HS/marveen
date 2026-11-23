#!/usr/bin/env python3
"""Migration GAP G5 validator: open-kanban-card assignee integrity + canonical-DB guard.

Context (store/specs/migration-readiness-plan-1123.md, G5 / section 2.3 + 2.5):
  - 137 open kanban cards carry live `assignee` state. Carrying them through a
    migration is a correctness hazard: every open-card assignee MUST still resolve
    to a real roster agent on the new box, or the kanban-drive silently breaks
    (a card assigned to a ghost agent is never picked up).
  - `agents/rackham/store/noa.db` is a SECOND copy of the fleet DB. It must NOT be
    mistaken for canonical; the canonical path is `store/noa.db`. The migration
    (T-A3 / core-engineering wave) must not treat rackham's copy as source-of-truth.

This script performs two assertions (both pure+testable, live wiring in main):

  (a) assignee-resolution: load the OPEN kanban cards and assert every open-card
      assignee resolves to an agent in the fleet roster (scripts/gen-fleet-roster.py
      -- config ids + live tmux sessions + display names + a small alias map).
      An empty / "none" / "unassigned" assignee is a LEGITIMATE unassigned sentinel
      (the board carries ~8 such cards), reported separately, NOT an error.
      Any assignee that does not resolve is an UNRESOLVED assignee -> failure.

  (b) canonical-db guard: assert the DB being validated is the canonical
      `store/noa.db` and flag `agents/rackham/store/noa.db` (and any other
      non-canonical copy) as NON-CANONICAL.

Open-card statuses: planned / in_progress / waiting (NOT done / icebox).

Design for testability:
  - resolvable_roster_ids(agents, live, aliases)   -- pure: the resolvable name set.
  - normalize_assignee(raw)                         -- pure: ('', 'unassigned', ...).
  - resolve_assignees(cards, resolvable)            -- pure: buckets cards.
  - is_canonical_db(path, root)                     -- pure: canonical-path guard.
  - classify_db_copy(path, root)                    -- pure: 'canonical'|'non-canonical-copy'.
  - load_open_cards_from_db / _from_api             -- thin IO wrappers.
  - main()                                          -- wires real roster + real DB/API.

Stdlib only (sqlite3, json, subprocess, pathlib, argparse). Reuses
gen-fleet-roster.py for the authoritative roster so the resolvable set can never
drift from the canonical roster generator.

Exit codes: 0 = all open-card assignees resolve AND canonical-db guard holds;
            1 = one or more unresolved assignees, or a canonical-db violation.
"""
import argparse
import importlib.util
import json
import os
import sqlite3
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# constants
# ---------------------------------------------------------------------------

OPEN_STATUSES = ("planned", "in_progress", "waiting")

CANONICAL_DB_RELPATH = "store/noa.db"
# Known non-canonical copies that must never be treated as source-of-truth.
KNOWN_NON_CANONICAL_RELPATHS = ("agents/rackham/store/noa.db",)

# Sentinels that mean "no agent assigned" -- legitimate, not an error.
UNASSIGNED_SENTINELS = {"", "none", "unassigned", "null", "-"}

# Display-name / historical aliases that map to a real roster id. The orchestrator
# marveen is routinely addressed as "Genesis" / "NoA"; the board carries such a
# card. Keys are lowercased.
DEFAULT_ALIASES = {
    "genesis": "marveen",
    "noa": "marveen",
}


# ---------------------------------------------------------------------------
# roster loading (reuse gen-fleet-roster.py so the resolvable set never drifts)
# ---------------------------------------------------------------------------

def _repo_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))  # <root>/scripts
    return os.path.dirname(here)


def _load_roster_module(root: str):
    path = os.path.join(root, "scripts", "gen-fleet-roster.py")
    spec = importlib.util.spec_from_file_location("gen_fleet_roster", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def resolvable_roster_ids(agents, live_sessions, aliases=None) -> set[str]:
    """Pure: the set of assignee strings that resolve to a real roster agent.

    Comprises (all lowercased):
      - every config agent id (`agents[*]['id']`),
      - every agent display name (`agents[*]['display']`),
      - every live tmux session id (`live_sessions`) -- covers persona-only agents
        that ship no agent-config.json (blackbart, gelim, gourmet, hibiki, ...),
      - the alias keys (`aliases`, default DEFAULT_ALIASES) AND their targets.
    """
    aliases = DEFAULT_ALIASES if aliases is None else aliases
    out: set[str] = set()
    for a in agents or []:
        if a.get("id"):
            out.add(str(a["id"]).lower())
        if a.get("display"):
            out.add(str(a["display"]).lower())
    for s in live_sessions or []:
        out.add(str(s).lower())
    for k, v in (aliases or {}).items():
        out.add(str(k).lower())
        out.add(str(v).lower())
    return out


# ---------------------------------------------------------------------------
# assignee resolution (pure)
# ---------------------------------------------------------------------------

def normalize_assignee(raw) -> str:
    """Pure: normalize a raw assignee cell to a comparable token.

    None / whitespace / known sentinels collapse to '' (the unassigned marker).
    Otherwise returns the lowercased, stripped assignee.
    """
    if raw is None:
        return ""
    s = str(raw).strip()
    if s.lower() in UNASSIGNED_SENTINELS:
        return ""
    return s.lower()


def resolve_assignees(cards, resolvable) -> dict:
    """Pure: bucket open cards by assignee resolution.

    `cards` is an iterable of dicts with at least 'assignee' and (optionally)
    'id'/'code'/'title' for reporting. `resolvable` is the set from
    resolvable_roster_ids().

    Returns:
      {
        'resolved':   [ {card, assignee} ... ],     # assignee in roster
        'unassigned': [ {card, ...} ... ],           # empty/none sentinel
        'unresolved': [ {card, assignee} ... ],      # ghost assignee -> FAILURE
        'unresolved_assignees': sorted list of distinct unresolved tokens,
      }
    """
    resolved, unassigned, unresolved = [], [], []
    bad_tokens: set[str] = set()
    for c in cards:
        raw = c.get("assignee") if isinstance(c, dict) else None
        token = normalize_assignee(raw)
        entry = {
            "id": c.get("id") if isinstance(c, dict) else None,
            "code": c.get("code") if isinstance(c, dict) else None,
            "title": c.get("title") if isinstance(c, dict) else None,
            "assignee_raw": raw,
            "assignee": token,
        }
        if token == "":
            unassigned.append(entry)
        elif token in resolvable:
            resolved.append(entry)
        else:
            unresolved.append(entry)
            bad_tokens.add(token)
    return {
        "resolved": resolved,
        "unassigned": unassigned,
        "unresolved": unresolved,
        "unresolved_assignees": sorted(bad_tokens),
    }


# ---------------------------------------------------------------------------
# canonical-DB guard (pure)
# ---------------------------------------------------------------------------

def is_canonical_db(db_path, root=None) -> bool:
    """Pure: True iff `db_path` resolves to the canonical `<root>/store/noa.db`.

    Compares realpaths so a symlink/relative form still matches. If the canonical
    file does not exist on disk, falls back to a normalized path-suffix compare so
    the guard still works in fixtures/pre-migration environments.
    """
    root = root or _repo_root()
    canonical = Path(root) / CANONICAL_DB_RELPATH
    p = Path(db_path)
    try:
        if canonical.exists() and p.exists():
            return os.path.realpath(p) == os.path.realpath(canonical)
    except OSError:
        pass
    # Fallback: normalized suffix compare (no FS dependency).
    return os.path.normpath(str(p)) == os.path.normpath(str(canonical))


def classify_db_copy(db_path, root=None) -> str:
    """Pure: classify a noa.db path for the migration.

    Returns one of:
      'canonical'           -- the authoritative <root>/store/noa.db
      'non-canonical-copy'  -- a known/other noa.db copy (e.g. rackham's) that
                               MUST NOT be treated as source-of-truth.
    """
    if is_canonical_db(db_path, root):
        return "canonical"
    return "non-canonical-copy"


def known_non_canonical_paths(root=None) -> list[str]:
    """The absolute paths of known non-canonical noa.db copies under `root`."""
    root = root or _repo_root()
    return [str(Path(root) / rel) for rel in KNOWN_NON_CANONICAL_RELPATHS]


# ---------------------------------------------------------------------------
# open-card loading (thin IO)
# ---------------------------------------------------------------------------

def load_open_cards_from_db(db_path) -> list[dict]:
    """Read OPEN kanban cards from a noa.db SQLite file. Thin IO wrapper."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        con.row_factory = sqlite3.Row
        placeholders = ",".join("?" for _ in OPEN_STATUSES)
        rows = con.execute(
            f"SELECT id, code, title, status, assignee FROM kanban_cards "
            f"WHERE status IN ({placeholders})",
            OPEN_STATUSES,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


def load_open_cards_from_api(root) -> list[dict]:
    """Read OPEN kanban cards via scripts/api-get-helper.py (/api/kanban).

    The dashboard REST surface is authoritative when the live server is up; the
    DB path is the offline/fixture fallback. Returns the same card-dict shape.
    """
    import subprocess

    helper = os.path.join(root, "scripts", "api-get-helper.py")
    out = subprocess.run(
        [sys.executable, helper, "/api/kanban"],
        capture_output=True, text=True, timeout=20,
    )
    if out.returncode != 0:
        raise RuntimeError(f"api-get-helper failed: {out.stderr.strip()}")
    data = json.loads(out.stdout)
    # /api/kanban may return a list or {cards:[...]}; normalize.
    cards = data.get("cards", data) if isinstance(data, dict) else data
    open_cards = []
    for c in cards:
        if c.get("status") in OPEN_STATUSES:
            open_cards.append({
                "id": c.get("id"),
                "code": c.get("code"),
                "title": c.get("title"),
                "status": c.get("status"),
                "assignee": c.get("assignee"),
            })
    return open_cards


# ---------------------------------------------------------------------------
# main (thin wiring)
# ---------------------------------------------------------------------------

def _build_resolvable(root) -> set[str]:
    roster = _load_roster_module(root)
    agents = roster.load_agents(root)
    live = roster._live_tmux_sessions()
    return resolvable_roster_ids(agents, live)


def main(argv=None) -> int:
    root = _repo_root()
    parser = argparse.ArgumentParser(description="Migration G5 assignee + canonical-DB validator.")
    parser.add_argument(
        "--source", choices=("db", "api"), default="db",
        help="Where to load open cards from (default: db -> store/noa.db).",
    )
    parser.add_argument(
        "--db", default=os.path.join(root, CANONICAL_DB_RELPATH),
        help="Path to the kanban SQLite DB (default: canonical store/noa.db).",
    )
    parser.add_argument("--root", default=root, help="Repo root (default: auto).")
    parser.add_argument(
        "--allow-non-canonical-db", action="store_true",
        help="Skip the canonical-DB guard failure (for inspecting a copy on purpose).",
    )
    args = parser.parse_args(argv)
    root = args.root

    rc = 0

    # --- (b) canonical-DB guard ------------------------------------------
    db_class = classify_db_copy(args.db, root)
    print(f"[db-guard] validating DB: {args.db}")
    print(f"[db-guard] canonical path: {os.path.join(root, CANONICAL_DB_RELPATH)}")
    print(f"[db-guard] classification: {db_class}")
    for ncp in known_non_canonical_paths(root):
        exists = os.path.exists(ncp)
        print(f"[db-guard] NON-CANONICAL copy {'(present) ' if exists else '(absent)  '}: {ncp}")
    if args.source == "db" and db_class != "canonical":
        if args.allow_non_canonical_db:
            print("[db-guard] WARN: validating a NON-CANONICAL db copy (allowed by flag).")
        else:
            print("[db-guard] FAIL: refusing to validate a NON-CANONICAL db copy as "
                  "source-of-truth. The canonical DB is store/noa.db. "
                  "Pass --allow-non-canonical-db to inspect a copy deliberately.")
            print("\nRESULT: FAIL")
            return 1

    # --- (a) assignee resolution -----------------------------------------
    resolvable = _build_resolvable(root)
    if args.source == "api":
        cards = load_open_cards_from_api(root)
    else:
        cards = load_open_cards_from_db(args.db)

    result = resolve_assignees(cards, resolvable)
    total = len(cards)
    print(f"\n[assignee] open cards: {total}")
    print(f"[assignee] resolved:   {len(result['resolved'])}")
    print(f"[assignee] unassigned: {len(result['unassigned'])} (legitimate none/empty)")
    print(f"[assignee] unresolved: {len(result['unresolved'])}")

    if result["unresolved"]:
        rc = 1
        print(f"\n[assignee] UNRESOLVED assignees: {result['unresolved_assignees']}")
        for e in result["unresolved"]:
            ref = e["code"] or e["id"]
            print(f"  - card {ref}: assignee={e['assignee_raw']!r} ({e['title']})")
        print("\n[assignee] FAIL: the above open cards reference an assignee that "
              "does not resolve to any roster agent. The kanban-drive would drop "
              "these cards. Reassign to a live roster agent or fix the roster.")
    else:
        print("[assignee] OK: every open-card assignee resolves to a roster agent.")

    print(f"\nRESULT: {'PASS' if rc == 0 else 'FAIL'}")
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
