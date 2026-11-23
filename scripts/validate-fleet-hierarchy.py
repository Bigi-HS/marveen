#!/usr/bin/env python3
"""Fleet hierarchy validator -- card c3ba6b1e, spec §1.5 Slice 1.

Checks AC-H1 / AC-H3 / AC-H4 against agents/*/agent-config.json + root
agent-config.json.  Exits 0 when all checks pass, 1 when any error is found.

Usage:
  python3 scripts/validate-fleet-hierarchy.py [--root <repo-root>]

Outputs one line per error on stderr; on stdout prints a summary table.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any

# Valid team.role values (spec §1.2 / §1.3)
VALID_ROLES = {"orchestrator", "leader", "member", "specialist"}

# Valid decisionScope values (spec §1.3)
VALID_SCOPES = {"none", "team", "gate", "orchestrate"}

# Maximum escalation / reporting chain depth (spec §1.5 AC-H4)
MAX_CHAIN_DEPTH = 4


# ---------------------------------------------------------------------------
# Fleet loading
# ---------------------------------------------------------------------------

def load_fleet(repo_root: pathlib.Path) -> dict[str, dict[str, Any]]:
    """Load all config-agent JSON files and return {agent_id -> config_dict}.

    Root agent-config.json is loaded as agent_id="marveen".
    agents/<id>/agent-config.json are loaded as agent_id=<id>.
    Files that are not valid JSON are skipped with a warning.
    """
    fleet: dict[str, dict[str, Any]] = {}

    # Root config (marveen)
    root_cfg = repo_root / "agent-config.json"
    if root_cfg.exists():
        try:
            fleet["marveen"] = json.loads(root_cfg.read_text())
        except json.JSONDecodeError as exc:
            print(f"[WARN] could not parse {root_cfg}: {exc}", file=sys.stderr)

    # Per-agent configs
    agents_dir = repo_root / "agents"
    if agents_dir.is_dir():
        for cfg in sorted(agents_dir.glob("*/agent-config.json")):
            agent_id = cfg.parent.name
            try:
                fleet[agent_id] = json.loads(cfg.read_text())
            except json.JSONDecodeError as exc:
                print(f"[WARN] could not parse {cfg}: {exc}", file=sys.stderr)

    return fleet


# ---------------------------------------------------------------------------
# AC-H1: every config-agent has team.role in the valid enum
# ---------------------------------------------------------------------------

def check_ac_h1(fleet: dict[str, dict[str, Any]]) -> list[str]:
    """AC-H1: team.role present and in VALID_ROLES for every config-agent."""
    errors: list[str] = []
    for agent_id, cfg in fleet.items():
        team = cfg.get("team")
        if team is None:
            errors.append(f"[AC-H1] {agent_id}: missing 'team' block")
            continue
        role = team.get("role")
        if role is None:
            errors.append(f"[AC-H1] {agent_id}: team.role is missing")
        elif role not in VALID_ROLES:
            errors.append(
                f"[AC-H1] {agent_id}: team.role={role!r} not in valid enum "
                f"{sorted(VALID_ROLES)}"
            )
    return errors


# ---------------------------------------------------------------------------
# AC-H3: reportsTo / escalatesTo point to known agent_ids or null
# ---------------------------------------------------------------------------

def check_ac_h3(fleet: dict[str, dict[str, Any]]) -> list[str]:
    """AC-H3: every reportsTo / escalatesTo is a known agent_id or null."""
    known = set(fleet.keys())
    errors: list[str] = []
    for agent_id, cfg in fleet.items():
        team = cfg.get("team", {})
        for field in ("reportsTo", "escalatesTo"):
            value = team.get(field)
            if value is None:
                continue
            if not isinstance(value, str):
                errors.append(
                    f"[AC-H3] {agent_id}: team.{field}={value!r} must be a string or null"
                )
                continue
            if value not in known:
                errors.append(
                    f"[AC-H3] {agent_id}: team.{field}={value!r} references unknown agent"
                )
    return errors


# ---------------------------------------------------------------------------
# AC-H4: escalatesTo / reportsTo chain <= MAX_CHAIN_DEPTH; no cycles
# ---------------------------------------------------------------------------

def _walk_chain(
    agent_id: str,
    fleet: dict[str, dict[str, Any]],
    field: str,
) -> tuple[int, bool]:
    """Walk the `field` (reportsTo/escalatesTo) chain from `agent_id`.

    Returns (depth, has_cycle).
    - depth: number of hops to reach null or an unknown agent
    - has_cycle: True if the walk visited the same agent twice
    """
    visited: set[str] = set()
    current = agent_id
    depth = 0
    while True:
        if current in visited:
            return depth, True  # cycle
        visited.add(current)
        cfg = fleet.get(current, {})
        team = cfg.get("team", {})
        nxt = team.get(field)
        if nxt is None or nxt not in fleet:
            return depth, False
        depth += 1
        current = nxt


def check_ac_h4(fleet: dict[str, dict[str, Any]]) -> list[str]:
    """AC-H4: chain is acyclic and reaches marveen/null in <= MAX_CHAIN_DEPTH hops."""
    errors: list[str] = []
    for agent_id in fleet:
        for field in ("escalatesTo", "reportsTo"):
            depth, has_cycle = _walk_chain(agent_id, fleet, field)
            if has_cycle:
                errors.append(
                    f"[AC-H4] {agent_id}: cycle detected following team.{field}"
                )
            elif depth > MAX_CHAIN_DEPTH:
                errors.append(
                    f"[AC-H4] {agent_id}: team.{field} chain is {depth} hops "
                    f"(max {MAX_CHAIN_DEPTH})"
                )
    return errors


# ---------------------------------------------------------------------------
# Slice 1 combined run
# ---------------------------------------------------------------------------

def run_slice1_checks(fleet: dict[str, dict[str, Any]]) -> list[str]:
    """Run all Slice-1 ACs (H1 / H3 / H4) and return a combined error list."""
    return check_ac_h1(fleet) + check_ac_h3(fleet) + check_ac_h4(fleet)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _repo_root_default() -> pathlib.Path:
    return pathlib.Path(__file__).parent.parent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate fleet hierarchy (Slice 1)")
    parser.add_argument(
        "--root",
        type=pathlib.Path,
        default=_repo_root_default(),
        help="Repo root (default: parent of scripts/)",
    )
    args = parser.parse_args(argv)

    fleet = load_fleet(args.root)
    if not fleet:
        print("[ERROR] no agent configs found", file=sys.stderr)
        return 1

    errors = run_slice1_checks(fleet)

    # Summary table: agent | role | reportsTo | escalatesTo | decisionScope
    header = f"{'agent':20s} {'role':14s} {'reportsTo':20s} {'escalatesTo':20s} {'decisionScope':14s}"
    print(header)
    print("-" * len(header))
    for agent_id in sorted(fleet):
        team = fleet[agent_id].get("team", {})
        print(
            f"{agent_id:20s} "
            f"{str(team.get('role', '?')):14s} "
            f"{str(team.get('reportsTo', 'null')):20s} "
            f"{str(team.get('escalatesTo', 'null')):20s} "
            f"{str(team.get('decisionScope', '?')):14s}"
        )

    print()
    if errors:
        print(f"FAIL: {len(errors)} error(s):", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1

    print(f"OK: {len(fleet)} config-agents, all Slice-1 AC checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
