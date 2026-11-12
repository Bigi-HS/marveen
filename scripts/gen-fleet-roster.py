#!/usr/bin/env python3
"""Generate store/fleet-roster-registry.md from the LIVE fleet source-of-truth
(card aeea36ee).

The roster used to be hand-written and drifted out of date (the Boss complained
that sessions "forget" agents). This generator enumerates the fleet from the
authoritative sources so the roster can never go stale:

  - agent-config.json files (agents/<id>/agent-config.json + the root
    agent-config.json for the main orchestrator) -> the agent set, display name,
    model, channel, team role/reportsTo.
  - the live tmux session list (`tmux ls`, sessions named `agent-<id>`) ->
    which agents are currently running (live) vs offline.

Two numbers that historically disagreed ("35 vs 29") are reconciled explicitly
instead of being papered over:
  - CONFIG agents: the count of agent-config.json files (the "29").
  - LIVE agents: the count of running `agent-*` tmux sessions.
A config dir can exist for an agent that is NOT running, and a live session can
exist for a persona-only / local agent that has NO agent-config. The latter are
surfaced in a dedicated reconcile section rather than dropped.

Design for testability (card requirement 4):
  - load_agents(agents_dir)            -- pure-ish: reads configs from an
                                          injectable directory (fixtures, no live FS).
  - parse_tmux_sessions(text)          -- pure: extracts `agent-<id>` ids.
  - group_agents(agents)               -- pure: buckets agents deterministically.
  - render_roster(agents, live)        -- pure: byte-identical for identical inputs.
  - main()                             -- thin wiring of real `tmux ls` + real dir,
                                          then writes store/fleet-roster-registry.md.

Stdlib only (json, subprocess, pathlib, argparse).
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# constants
# ---------------------------------------------------------------------------

MAIN_AGENT_ID = "marveen"  # the root agent-config.json is the main orchestrator

# Group labels (also used by the test to assert bucketing).
G_ORCHESTRATOR = "ORCHESTRATOR"
G_CORE_ENG = "CORE ENGINEERING TEAM"
G_QA = "QA TEAM"
G_SECURITY = "SECURITY & AUDIT"
G_CHANNEL = "CHANNEL / PERSONAL ASSISTANTS"
G_SUPPORT = "OPERATIONS & SUPPORT"
G_LOCAL = "LOCAL / EXPERIMENTAL"

# Deterministic render order of groups.
GROUP_ORDER = [
    G_ORCHESTRATOR,
    G_CORE_ENG,
    G_QA,
    G_SECURITY,
    G_CHANNEL,
    G_SUPPORT,
    G_LOCAL,
]

LIVE_MARK = "🟢 live"
OFFLINE_MARK = "⚪ offline"

RECONCILE_HEADING = "Reconcile: config set vs live sessions"

# Leaders pinned at the top of their group (before name-sorted members).
# A leader's team.reportsTo is null and it heads a named sub-team.
_LEADER_PINS = {"marveen", "dave", "thor"}


# ---------------------------------------------------------------------------
# data loading (injectable dir)
# ---------------------------------------------------------------------------

def _read_config(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return None


def load_agents(agents_root: str) -> list[dict]:
    """Enumerate agents from agent-config.json under `agents_root`.

    Reads the root `<root>/agent-config.json` (the main orchestrator, id
    MAIN_AGENT_ID) plus every `<root>/agents/<id>/agent-config.json`.

    Returns a list of normalized dicts:
      {id, display, model, channel, role, reports_to, security}
    sorted by id for stability. Any unreadable/malformed config is skipped,
    never raised. A missing root returns [].
    """
    root = Path(agents_root)
    if not root.exists():
        return []

    agents: list[dict] = []

    def _norm(agent_id: str, cfg: dict) -> dict:
        team = cfg.get("team") or {}
        return {
            "id": agent_id,
            "display": cfg.get("displayName") or agent_id,
            "model": cfg.get("model") or "?",
            "channel": cfg.get("channelProvider") or "",
            "role": (team.get("role") or ""),
            "reports_to": team.get("reportsTo"),
            "security": cfg.get("securityProfile") or "",
        }

    root_cfg = _read_config(root / "agent-config.json")
    if isinstance(root_cfg, dict):
        agents.append(_norm(MAIN_AGENT_ID, root_cfg))

    agents_dir = root / "agents"
    if agents_dir.is_dir():
        for child in sorted(agents_dir.iterdir()):
            if not child.is_dir():
                continue
            cfg = _read_config(child / "agent-config.json")
            if isinstance(cfg, dict):
                agents.append(_norm(child.name, cfg))

    agents.sort(key=lambda a: a["id"])
    return agents


# The main orchestrator does not run as `agent-marveen`; its live session is the
# channel listener `marveen-channels`. Map that one special session to its id so
# marveen is not falsely marked offline.
_MAIN_SESSION_NAME = "marveen-channels"


def parse_tmux_sessions(text: str) -> set[str]:
    """Extract agent ids from `tmux ls` output. Session names look like
    `agent-<id>: 1 windows (...)`; non-agent sessions (boss, noa-sandbox, ...)
    are ignored. The main orchestrator's `marveen-channels` session maps to the
    MAIN_AGENT_ID. Returns a set of ids."""
    ids: set[str] = set()
    for line in (text or "").splitlines():
        name = line.split(":", 1)[0].strip()
        if name.startswith("agent-"):
            ids.add(name[len("agent-"):])
        elif name == _MAIN_SESSION_NAME:
            ids.add(MAIN_AGENT_ID)
    return ids


def _live_tmux_sessions() -> set[str]:
    """Real tmux session list -> agent ids. Never raises; empty on any error."""
    try:
        out = subprocess.run(
            ["tmux", "ls"], capture_output=True, text=True, timeout=10
        )
        return parse_tmux_sessions(out.stdout)
    except Exception:
        return set()


# ---------------------------------------------------------------------------
# grouping (pure)
# ---------------------------------------------------------------------------

def _is_local(a: dict) -> bool:
    return str(a["model"]).startswith("qwen") or a["id"].endswith("-local")


def _classify(a: dict, by_id: dict) -> str:
    """Assign one group to an agent. Deterministic: depends only on the agent's
    own fields + the id->agent map (for reportsTo chasing)."""
    aid = a["id"]
    if aid == MAIN_AGENT_ID:
        return G_ORCHESTRATOR
    if _is_local(a):
        return G_LOCAL

    # Walk reportsTo up to a known leader (bounded to avoid cycles).
    leader = None
    cur, seen = a, set()
    while cur is not None and cur["id"] not in seen:
        seen.add(cur["id"])
        rt = cur["reports_to"]
        if rt in ("dave", "thor"):
            leader = rt
            break
        if rt is None:
            # cur itself is a top leader; use its own id if recognised
            if cur["id"] in ("dave", "thor"):
                leader = cur["id"]
            break
        cur = by_id.get(rt)

    if leader == "dave" or aid == "dave":
        return G_CORE_ENG
    if leader == "thor" or aid == "thor":
        return G_QA

    # Security profile / role heuristics.
    if a["security"] == "developer-senior" and a["role"] == "" and aid == "chad":
        return G_SECURITY
    if aid in ("chad", "devil-advocate"):
        return G_SECURITY

    # forge (DevOps) and buster (CI canary) sit with core engineering.
    if aid in ("forge", "buster"):
        return G_CORE_ENG

    # Channel / personal assistants: has a user-facing channel.
    if a["channel"]:
        return G_CHANNEL

    # Everything else (research, ops, memory curators, etc.) -> support.
    return G_SUPPORT


def group_agents(agents: list[dict]) -> list[tuple[str, list[dict]]]:
    """Bucket agents into (group_name, members) pairs in GROUP_ORDER. Members are
    sorted: pinned leaders first, then name-sorted by display/id."""
    by_id = {a["id"]: a for a in agents}
    buckets: dict[str, list[dict]] = {g: [] for g in GROUP_ORDER}
    for a in agents:
        g = _classify(a, by_id)
        buckets.setdefault(g, []).append(a)

    def _sort_key(a: dict):
        pin = 0 if a["id"] in _LEADER_PINS else 1
        return (pin, a["id"])

    result: list[tuple[str, list[dict]]] = []
    for g in GROUP_ORDER:
        members = sorted(buckets.get(g, []), key=_sort_key)
        result.append((g, members))
    return result


# ---------------------------------------------------------------------------
# rendering (pure, deterministic)
# ---------------------------------------------------------------------------

HEADER_LINES = [
    "# Genesis Fleet -- Kanonikus Roster (auto-generated)",
    "",
    "_GENERATED by scripts/gen-fleet-roster.py (card aeea36ee). DO NOT edit by hand --_",
    "_regenerate instead, otherwise your changes are lost on the next run._",
    "_Forrás: agents/*/agent-config.json (+ root agent-config.json) kereszthivatkozva_",
    "_a `tmux ls` élő session-listával. A roster sosem avul el: minden major_",
    "_fleet-change (új ágens, model-váltás, retire) után futtasd újra._",
]


def _mark(agent_id: str, live: set[str]) -> str:
    return LIVE_MARK if agent_id in live else OFFLINE_MARK


def _esc(text: str) -> str:
    """Escape pipes so a display value can't break the markdown table."""
    return str(text).replace("|", "\\|")


def render_roster(agents, live_sessions) -> str:
    """Pure renderer: identical (agents, live_sessions) -> byte-identical output.

    `live_sessions` may be any iterable of agent ids (set/list); it is
    normalized to a set so ordering is irrelevant.
    """
    live = set(live_sessions or [])
    by_id = {a["id"]: a for a in agents}
    config_ids = set(by_id)

    lines: list[str] = list(HEADER_LINES)
    lines.append("")
    lines.append("---")
    lines.append("")

    groups = group_agents(agents)
    section_no = 0
    for gname, members in groups:
        if not members:
            continue
        section_no += 1
        lines.append(f"## {section_no}. {gname}")
        lines.append("")
        lines.append("| agent_id | Display | Model | Channel | Role | Status |")
        lines.append("|----------|---------|-------|---------|------|--------|")
        for a in members:
            channel = a["channel"] or "-"
            role = a["role"] or "-"
            reports = f" -> {a['reports_to']}" if a["reports_to"] else ""
            role_cell = f"{role}{reports}"
            lines.append(
                f"| {a['id']} | {_esc(a['display'])} | {a['model']} | "
                f"{channel} | {_esc(role_cell)} | {_mark(a['id'], live)} |"
            )
        lines.append("")

    # --- Reconcile section -------------------------------------------------
    live_agent_ids = sorted(live)
    live_with_config = sorted(live & config_ids)
    live_without_config = sorted(live - config_ids)
    offline_configs = sorted(config_ids - live)

    section_no += 1
    lines.append(f"## {section_no}. {RECONCILE_HEADING}")
    lines.append("")
    lines.append(
        "_The historical \"35 vs 29\" gap is just two different denominators._"
    )
    lines.append("")
    lines.append(f"- **agent-config.json files (CONFIG set): {len(config_ids)}**")
    lines.append(
        f"- **live tmux sessions (agent-* + marveen-channels): {len(live_agent_ids)}** "
        f"({len(live_with_config)} with a config, {len(live_without_config)} without)"
    )
    lines.append(
        f"- **union of named agents: {len(config_ids | live)}** "
        "(configs + persona-only live sessions)"
    )
    lines.append("")

    if live_without_config:
        lines.append(
            "### Persona-only / local agents (live session, NO agent-config.json)"
        )
        lines.append("")
        lines.append(
            "_These run from a tmux session + CLAUDE.md persona but ship no "
            "agent-config.json, so they do not appear in the tables above._"
        )
        lines.append("")
        lines.append("| agent_id | Status |")
        lines.append("|----------|--------|")
        for aid in live_without_config:
            lines.append(f"| {aid} | {LIVE_MARK} |")
        lines.append("")

    if offline_configs:
        lines.append("### Config agents currently OFFLINE (no live tmux session)")
        lines.append("")
        lines.append("_A config dir exists but no `agent-<id>` session is running now._")
        lines.append("")
        lines.append("| agent_id | Display |")
        lines.append("|----------|---------|")
        for aid in offline_configs:
            lines.append(f"| {aid} | {_esc(by_id[aid]['display'])} |")
        lines.append("")

    out = "\n".join(lines).rstrip() + "\n"
    return out


# ---------------------------------------------------------------------------
# main (thin wiring)
# ---------------------------------------------------------------------------

def _repo_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))  # <root>/scripts
    return os.path.dirname(here)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Generate the canonical fleet roster.")
    parser.add_argument(
        "--root", default=_repo_root(),
        help="Repo root containing agent-config.json + agents/ (default: repo root).",
    )
    parser.add_argument(
        "--out", default=None,
        help="Output path (default: <root>/store/fleet-roster-registry.md).",
    )
    parser.add_argument(
        "--stdout", action="store_true",
        help="Print the roster to stdout instead of writing the file.",
    )
    args = parser.parse_args(argv)

    agents = load_agents(args.root)
    live = _live_tmux_sessions()
    content = render_roster(agents, live)

    if args.stdout:
        sys.stdout.write(content)
        return 0

    out_path = Path(args.out) if args.out else Path(args.root) / "store" / "fleet-roster-registry.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(content, encoding="utf-8")
    print(f"wrote {out_path} ({len(agents)} configs, {len(live)} live sessions)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
