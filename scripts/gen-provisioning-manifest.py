#!/usr/bin/env python3
"""Generate a declarative provisioning manifest for the WHOLE fleet so a
migration recreate step drops NOBODY (migration-readiness GAP G3, card for
feat/migration-g3-provisioning-manifest).

Background
----------
`gen-fleet-roster.py` enumerates agents from `agent-config.json` + live tmux
sessions. That is config-driven, and a migration that recreates agents purely
from `agent-config.json` would SILENTLY DROP the persona-only agents whose
identity lives only in `agents/<id>/CLAUDE.md` (+ a running tmux session) --
blackbart, gelim, gourmet, hibiki, kerrigan, servo-skull on the live box.

This script emits ONE authoritative manifest that is the union of every
provenance source, so the recreate step can iterate it mechanically:

  sources enumerated
    - root `agent-config.json`                 (the main orchestrator, marveen)
    - every `agents/<id>/agent-config.json`     (config agents)
    - live `tmux ls` sessions (agent-* + marveen-channels)
    - `agents/<id>/CLAUDE.md` persona files      (persona identity, no config)

  per-agent record (manifest + human table)
    - agent_id       canonical id
    - display        displayName (config) or CLAUDE.md H1 title, else id
    - model          config model, else "" (persona-only -> unknown until seeded)
    - channel        channelProvider (config) or inferred-from-CLAUDE.md
    - role           team.role (config) or "" for persona-only
    - has_config     bool -- False means recreate from CLAUDE.md, not config
    - store_size     human size of agents/<id>/store (du -sh style), "" if none
    - persona_source one of: "config", "config+claude", "claude-only",
                     "live-session-only"  (where the identity is recoverable from)

The migration contract: `has_config == False` agents MUST appear in the manifest
with persona_source != "config", so the recreate step copies CLAUDE.md +
launches a session instead of looking for a non-existent config.

Design for testability (mirrors gen-fleet-roster.py):
  - load_config_agents(root)      -- reuses the roster loader (injectable dir).
  - discover_persona_sources(root)-- pure-ish: lists which agents have CLAUDE.md.
  - parse_claude_display(text)    -- pure: H1 title -> display name.
  - build_manifest(config_agents, persona_ids, live_ids, store_sizer)
                                  -- PURE: no FS/tmux; store_sizer is injected.
  - render_table(records)         -- pure: byte-identical for identical input.
  - main()                        -- thin wiring of real dir + tmux + du.

Stdlib only (json, subprocess, pathlib, argparse, re, os).
"""
import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_roster_module():
    """Import gen-fleet-roster.py as a module to reuse its loaders (the file name
    has a dash so it can't be a normal import)."""
    gen = HERE / "gen-fleet-roster.py"
    spec = importlib.util.spec_from_file_location("gen_fleet_roster", str(gen))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_ROSTER = _load_roster_module()

MAIN_AGENT_ID = _ROSTER.MAIN_AGENT_ID

# persona_source enum
SRC_CONFIG = "config"
SRC_CONFIG_CLAUDE = "config+claude"
SRC_CLAUDE_ONLY = "claude-only"
SRC_LIVE_ONLY = "live-session-only"


# ---------------------------------------------------------------------------
# source discovery
# ---------------------------------------------------------------------------

def load_config_agents(root: str) -> list[dict]:
    """Config-agent set via the roster loader (root config + agents/*/config)."""
    return _ROSTER.load_agents(root)


def discover_persona_sources(root: str) -> dict[str, dict]:
    """Return {agent_id: {"has_claude": bool, "display": str|None}} for every
    `agents/<id>` dir that carries a CLAUDE.md persona file. The root/main agent
    persona lives in the repo-root CLAUDE.md (project file), handled separately.

    Never raises; a missing agents/ dir returns {}.
    """
    out: dict[str, dict] = {}
    agents_dir = Path(root) / "agents"
    if not agents_dir.is_dir():
        return out
    for child in sorted(agents_dir.iterdir()):
        if not child.is_dir():
            continue
        claude = child / "CLAUDE.md"
        if claude.is_file():
            try:
                text = claude.read_text("utf-8", errors="replace")
            except Exception:
                text = ""
            out[child.name] = {
                "has_claude": True,
                "display": parse_claude_display(text),
                "channel": infer_channel_from_claude(text),
            }
    return out


_H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


def parse_claude_display(text: str) -> str | None:
    """Extract a display name from a CLAUDE.md H1 heading.

    `# Black Bart (blackbart)` -> "Black Bart"
    `# Hibiki`                  -> "Hibiki"
    Returns None if no H1 is present.
    """
    m = _H1_RE.search(text or "")
    if not m:
        return None
    title = m.group(1).strip()
    # Strip a trailing "(id)" parenthetical if present.
    title = re.sub(r"\s*\([^)]*\)\s*$", "", title).strip()
    return title or None


def infer_channel_from_claude(text: str) -> str:
    """Best-effort channel inference for a persona-only agent from its CLAUDE.md.

    Persona-only agents have no channelProvider key, but their persona often
    names the channel (most are Telegram personal assistants). We only claim a
    channel when the persona clearly references one, else "".
    """
    low = (text or "").lower()
    if "telegram" in low:
        return "telegram"
    return ""


# ---------------------------------------------------------------------------
# store sizing
# ---------------------------------------------------------------------------

def du_store_size(root: str, agent_id: str) -> str:
    """Human-readable size of agents/<id>/store via `du -sh`, "" if absent/empty
    or on any error. Separated so build_manifest can inject a fake in tests."""
    store = Path(root) / "agents" / agent_id / "store"
    if not store.exists():
        return ""
    try:
        out = subprocess.run(
            ["du", "-sh", str(store)], capture_output=True, text=True, timeout=30
        )
        if out.returncode != 0:
            return ""
        return out.stdout.split("\t", 1)[0].strip()
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# manifest building (PURE -- no FS, no tmux, no du)
# ---------------------------------------------------------------------------

def build_manifest(config_agents, persona_sources, live_ids, store_sizer):
    """Fold every provenance source into one list of manifest records.

    Args:
      config_agents:   list from load_config_agents (normalized dicts).
      persona_sources: {id: {"has_claude", "display", "channel"}} from
                       discover_persona_sources.
      live_ids:        set/iterable of agent ids with a live tmux session.
      store_sizer:     callable(agent_id) -> str (human size or ""). Injected so
                       this function stays pure and testable.

    Returns a list of records sorted by agent_id, each:
      {agent_id, display, model, channel, role, has_config, store_size,
       persona_source, live}

    GAP G3 invariant: a persona-only agent (no config but has CLAUDE.md OR a live
    session) is ALWAYS present with has_config=False and persona_source in
    {claude-only, live-session-only}. It is never dropped.
    """
    live = set(live_ids or [])
    by_id = {a["id"]: a for a in config_agents}
    config_ids = set(by_id)
    persona_ids = set(persona_sources or {})

    # Union of every known agent across all sources.
    all_ids = config_ids | persona_ids | live

    records: list[dict] = []
    for aid in sorted(all_ids):
        cfg = by_id.get(aid)
        persona = (persona_sources or {}).get(aid) or {}
        has_config = cfg is not None
        has_claude = bool(persona.get("has_claude"))

        if has_config and has_claude:
            source = SRC_CONFIG_CLAUDE
        elif has_config:
            source = SRC_CONFIG
        elif has_claude:
            source = SRC_CLAUDE_ONLY
        else:
            # No config, no CLAUDE.md under agents/<id>, yet a live session
            # exists (or the id came only from tmux) -> recoverable only by
            # cloning the live session. Loudest "do not drop" case.
            source = SRC_LIVE_ONLY

        display = (
            (cfg or {}).get("display")
            or persona.get("display")
            or aid
        )
        model = (cfg or {}).get("model") or "" if cfg else ""
        # roster's _norm fills model="?" when absent; normalize that back to "".
        if model == "?":
            model = ""
        channel = ((cfg or {}).get("channel") or "") if cfg else ""
        if not channel:
            channel = persona.get("channel") or ""
        role = ((cfg or {}).get("role") or "") if cfg else ""

        records.append({
            "agent_id": aid,
            "display": display,
            "model": model,
            "channel": channel,
            "role": role,
            "has_config": has_config,
            "store_size": store_sizer(aid) or "",
            "persona_source": source,
            "live": aid in live,
        })

    return records


# ---------------------------------------------------------------------------
# rendering (pure, deterministic)
# ---------------------------------------------------------------------------

def _esc(text: str) -> str:
    return str(text).replace("|", "\\|")


def render_table(records) -> str:
    """Human-readable markdown table of the manifest. Byte-identical for
    identical input. Persona-only agents get a dedicated callout so a human
    reviewer can SEE that nobody was dropped."""
    lines: list[str] = []
    lines.append("# Fleet Provisioning Manifest (auto-generated)")
    lines.append("")
    lines.append(
        "_GENERATED by scripts/gen-provisioning-manifest.py "
        "(migration GAP G3). DO NOT edit by hand -- regenerate._"
    )
    lines.append(
        "_Union of: root + agents/*/agent-config.json, live tmux sessions, and_"
    )
    lines.append(
        "_agents/*/CLAUDE.md personas. A migration recreate step iterates this_"
    )
    lines.append(
        "_manifest so persona-only agents (has_config=false) are never dropped._"
    )
    lines.append("")

    n_total = len(records)
    n_config = sum(1 for r in records if r["has_config"])
    n_persona = n_total - n_config
    n_live = sum(1 for r in records if r["live"])
    lines.append(
        f"- **total agents: {n_total}** "
        f"({n_config} with agent-config.json, {n_persona} persona-only)"
    )
    lines.append(f"- **live tmux sessions: {n_live}**")
    lines.append("")
    lines.append("---")
    lines.append("")

    lines.append(
        "| agent_id | Display | Model | Channel | Role | has_config | "
        "store_size | persona_source |"
    )
    lines.append(
        "|----------|---------|-------|---------|------|------------|"
        "------------|----------------|"
    )
    for r in records:
        lines.append(
            f"| {r['agent_id']} | {_esc(r['display'])} | "
            f"{r['model'] or '-'} | {r['channel'] or '-'} | {_esc(r['role']) or '-'} | "
            f"{'yes' if r['has_config'] else 'NO'} | "
            f"{r['store_size'] or '-'} | {r['persona_source']} |"
        )
    lines.append("")

    persona_only = [r for r in records if not r["has_config"]]
    lines.append("## Persona-only agents (NO agent-config.json)")
    lines.append("")
    if persona_only:
        lines.append(
            "_Recreate these by copying `agents/<id>/CLAUDE.md` and launching a "
            "session -- there is no config to drive them. The migration MUST NOT "
            "skip them._"
        )
        lines.append("")
        lines.append("| agent_id | Display | store_size | persona_source |")
        lines.append("|----------|---------|------------|----------------|")
        for r in persona_only:
            lines.append(
                f"| {r['agent_id']} | {_esc(r['display'])} | "
                f"{r['store_size'] or '-'} | {r['persona_source']} |"
            )
        lines.append("")
    else:
        lines.append("_None: every enumerated agent has an agent-config.json._")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_json(records) -> str:
    """Declarative JSON manifest -- the machine-readable recreate source."""
    payload = {
        "schema": "fleet-provisioning-manifest/v1",
        "generator": "scripts/gen-provisioning-manifest.py",
        "total": len(records),
        "with_config": sum(1 for r in records if r["has_config"]),
        "persona_only": sum(1 for r in records if not r["has_config"]),
        "agents": records,
    }
    return json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=False) + "\n"


# ---------------------------------------------------------------------------
# main (thin wiring)
# ---------------------------------------------------------------------------

def _repo_root() -> str:
    return os.path.dirname(str(HERE))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate the fleet provisioning manifest (GAP G3)."
    )
    parser.add_argument(
        "--root", default=_repo_root(),
        help="Repo root containing agent-config.json + agents/ (default: repo root).",
    )
    parser.add_argument(
        "--out-json", default=None,
        help="JSON manifest output (default: <root>/store/fleet-provisioning-manifest.json).",
    )
    parser.add_argument(
        "--out-md", default=None,
        help="Human table output (default: <root>/store/fleet-provisioning-manifest.md).",
    )
    parser.add_argument(
        "--stdout", action="store_true",
        help="Print the human table to stdout instead of writing files.",
    )
    args = parser.parse_args(argv)

    config_agents = load_config_agents(args.root)
    persona_sources = discover_persona_sources(args.root)
    live_ids = _ROSTER._live_tmux_sessions()

    def _sizer(aid: str) -> str:
        return du_store_size(args.root, aid)

    records = build_manifest(config_agents, persona_sources, live_ids, _sizer)

    table = render_table(records)
    if args.stdout:
        sys.stdout.write(table)
        return 0

    out_json = Path(args.out_json) if args.out_json else Path(args.root) / "store" / "fleet-provisioning-manifest.json"
    out_md = Path(args.out_md) if args.out_md else Path(args.root) / "store" / "fleet-provisioning-manifest.md"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(render_json(records), encoding="utf-8")
    out_md.write_text(table, encoding="utf-8")

    n_persona = sum(1 for r in records if not r["has_config"])
    print(
        f"wrote {out_json} and {out_md} "
        f"({len(records)} agents, {n_persona} persona-only -- none dropped)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
