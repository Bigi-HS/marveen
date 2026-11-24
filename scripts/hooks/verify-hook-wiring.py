#!/usr/bin/env python3
"""Pre-wiring verification guard: enforce land-script-first for settings.json hooks.

Card:   828fd3ad (SEC-119 rollout-order hardening)
Lesson: shared-pretooluse-hook-missing-script-with-broad-matcher-bricks-all-tools-1122

PROBLEM (2026-11-22 incident):
  egress-pii-scan.py + a .guard hook were wired with a `mcp__.*|Bash` matcher into
  dave+forge settings.json BEFORE the script file landed on disk. A PreToolUse
  command hook whose script is missing does NOT fail-open -- it fails CLOSED and
  rejects the tool call. Because the matcher covered both Bash AND every MCP tool,
  the agent lost its entire tool surface AND its escalation channel: a silent
  fleet-brick. dave self-healed; forge needed a restart.

FIX (this guard):
  Statically resolve EVERY hook `command` script path across all event sections of
  a settings.json hook block and REFUSE (raise / non-zero) if any referenced script
  does not exist on disk -- enforcing land-script-first. The missing-script case
  behind a Bash/MCP-covering matcher is flagged as the high-severity brick class.

  Patchers (e.g. apply-telemetry-hook.py) import `assert_scripts_present` and call it
  as a guard BEFORE writing any settings.json. For callers that prefer graceful
  degradation over a hard brick, `degrade_to_noop` rewrites any missing-script hook
  command to a benign no-op reference instead of leaving a fail-closed landmine.

Usage (standalone, read-only audit over the fleet):
    python3 scripts/hooks/verify-hook-wiring.py            # audit all agents
    python3 scripts/hooks/verify-hook-wiring.py --json     # machine-readable
    python3 scripts/hooks/verify-hook-wiring.py --file <settings.json>

Exit code: 0 if every wired hook script exists; 2 if any is missing (land-first
violation). Never mutates any settings.json -- audit is strictly read-only.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Hook-command tokens that reference a script we must verify on disk.
_SCRIPT_SUFFIXES = (".py", ".sh", ".js", ".ts", ".mjs")

# Interpreter words we skip when hunting for the script token in a command.
_INTERPRETERS = frozenset(
    {"python3", "python", "python2", "bash", "sh", "node", "ts-node", "deno", "/usr/bin/env"}
)

# $CLAUDE_PROJECT_DIR / ${CLAUDE_PROJECT_DIR} token used in fleet hook commands.
_PROJECT_DIR_TOKENS = ("$CLAUDE_PROJECT_DIR", "${CLAUDE_PROJECT_DIR}")

# A benign no-op the degrade path substitutes for a missing-script command.
# `true` is a POSIX builtin that always exits 0 -> a PreToolUse hook that never
# blocks (fail-open by construction), the exact opposite of a missing-script brick.
NOOP_COMMAND = "true"

# Event sections of a settings.json hooks block that can carry command hooks.
_HOOK_EVENTS = (
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "SessionEnd",
    "PreCompact",
    "Stop",
    "SubagentStop",
    "Notification",
)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

class MissingHook:
    """A wired hook whose referenced script does not exist on disk."""

    def __init__(self, event, matcher, command, script):
        self.event = event
        self.matcher = matcher
        self.command = command
        self.script = script  # resolved absolute path that does not exist

    def __repr__(self):
        return f"MissingHook(event={self.event!r}, script={self.script!r})"


class VerifyResult:
    def __init__(self, ok, missing=None, brick_risk=None, checked=0):
        self.ok = ok
        self.missing = missing if missing is not None else []      # list[MissingHook]
        self.brick_risk = brick_risk if brick_risk is not None else []  # Bash/MCP subset
        self.checked = checked  # number of script-bearing hooks seen


class HookWiringError(RuntimeError):
    """Raised by assert_scripts_present when a referenced hook script is missing."""


# ---------------------------------------------------------------------------
# Static command -> script-path resolution (no shell execution)
# ---------------------------------------------------------------------------

def resolve_script_path(command: str, project_root: str) -> Optional[str]:
    """Statically resolve the script path a hook `command` would execute.

    Handles the fleet conventions:
      python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/x.py"
      python3 scripts/hooks/x.py          (relative to project_root)
      python3 "/abs/scripts/hooks/x.py"   (absolute)

    Returns an absolute path string, or None if no script token is present
    (e.g. a pure-shell command with no .py/.sh file).
    """
    if not command:
        return None

    # Expand the project-dir token textually BEFORE tokenizing so shlex keeps the
    # path intact. We expand to project_root (the value the runtime would supply).
    expanded = command
    for tok in _PROJECT_DIR_TOKENS:
        expanded = expanded.replace(tok, project_root.rstrip("/"))

    try:
        tokens = shlex.split(expanded)
    except ValueError:
        # Unbalanced quotes etc. -- fall back to a permissive regex scan so we do
        # not silently skip a hook (fail toward verification, not past it).
        tokens = re.findall(r"\S+", expanded)

    for tok in tokens:
        base = os.path.basename(tok)
        if base in _INTERPRETERS or tok.startswith("-"):
            continue
        if tok.endswith(_SCRIPT_SUFFIXES):
            if os.path.isabs(tok):
                return os.path.normpath(tok)
            return os.path.normpath(os.path.join(project_root, tok))
    return None


def matcher_can_block_tools(matcher: str) -> bool:
    """True if a PreToolUse matcher covers Bash and/or MCP tools.

    A missing-script hook under such a matcher is the 2026-11-22 fleet-brick class:
    fail-closed on Bash + MCP removes the agent's tool surface AND escalation path.
    """
    if not matcher:
        # An empty/absent matcher matches everything -> covers Bash+MCP.
        return True
    m = matcher.strip()
    if m in (".*", "*"):
        return True
    try:
        pat = re.compile(m)
    except re.error:
        # Unparseable matcher -> be conservative and treat as broad.
        return True

    # Brick class = the matcher blocks Bash AND/OR a BROAD swath of MCP tools
    # (a wildcard like `mcp__.*`), removing both the tool surface and the
    # escalation channel. A matcher pinned to ONE specific MCP tool (e.g.
    # mcp__plugin.telegram.telegram__reply) is narrow: losing just that tool
    # does not brick the agent.
    if pat.search("Bash"):
        return True

    # Detect a broad MCP wildcard: the pattern must match TWO structurally
    # unrelated MCP tool names. A matcher for one named tool only matches names
    # that resemble it, so it fails on the second, unrelated probe.
    mcp_probes = ("mcp__aaa_bbb__ccc", "mcp__zzz_server__other_tool")
    if all(pat.search(p) for p in mcp_probes):
        return True

    return False


# ---------------------------------------------------------------------------
# Core verification
# ---------------------------------------------------------------------------

def _iter_hooks(settings: dict):
    """Yield (event, matcher, hook_entry_dict) for every command hook in settings."""
    hooks = settings.get("hooks", {})
    if not isinstance(hooks, dict):
        return
    for event, entries in hooks.items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            matcher = entry.get("matcher", "")
            for h in entry.get("hooks", []) or []:
                if isinstance(h, dict) and h.get("type") == "command":
                    yield event, matcher, h


def verify_hook_wiring(settings: dict, project_root: str) -> VerifyResult:
    """Verify that every wired hook script exists on disk under project_root.

    Returns a VerifyResult. ok is False if any script is missing (land-first
    violation). brick_risk holds the subset whose matcher covers Bash/MCP in a
    tool-blocking event (PreToolUse) -- the exact 1122 silent-fleet-brick class.
    """
    missing: list = []
    brick_risk: list = []
    checked = 0

    for event, matcher, h in _iter_hooks(settings):
        script = resolve_script_path(h.get("command", ""), project_root)
        if script is None:
            continue
        checked += 1
        if not os.path.isfile(script):
            mh = MissingHook(
                event=event,
                matcher=matcher,
                command=h.get("command", ""),
                script=script,
            )
            missing.append(mh)
            # Fleet-brick class: PreToolUse (can reject a tool) + Bash/MCP matcher.
            if event == "PreToolUse" and matcher_can_block_tools(matcher):
                brick_risk.append(mh)

    return VerifyResult(
        ok=not missing,
        missing=missing,
        brick_risk=brick_risk,
        checked=checked,
    )


def assert_scripts_present(settings: dict, project_root: str) -> None:
    """Guard for patchers: raise HookWiringError if any wired hook script is missing.

    Call this BEFORE writing a settings.json so a hook is never wired ahead of its
    script landing on disk (land-script-first). Enforces the SEC-119 rollout order.
    """
    res = verify_hook_wiring(settings, project_root)
    if not res.ok:
        lines = [
            f"  - [{m.event}] matcher={m.matcher!r} -> MISSING {m.script}"
            for m in res.missing
        ]
        brick = ""
        if res.brick_risk:
            brick = (
                "\nBRICK-RISK (Bash/MCP PreToolUse matcher + missing script = the "
                "2026-11-22 silent-fleet-brick class):\n"
                + "\n".join(f"  !! {m.script}" for m in res.brick_risk)
            )
        raise HookWiringError(
            "Refusing to wire hooks: referenced script(s) do not exist on disk "
            "(land-script-first):\n" + "\n".join(lines) + brick
        )


# ---------------------------------------------------------------------------
# Graceful degradation (fallback-no-op instead of a hard brick)
# ---------------------------------------------------------------------------

def degrade_to_noop(settings: dict, project_root: str) -> dict:
    """Return a copy of settings where every missing-script hook command is a no-op.

    Rather than leave a fail-closed landmine (missing script -> PreToolUse reject),
    rewrite the command of any hook whose script is absent to NOOP_COMMAND (`true`),
    which always exits 0 and never blocks. Present-script hooks are left untouched.
    Non-destructive: operates on a deep copy.
    """
    import copy

    out = copy.deepcopy(settings)
    for event, _matcher, h in _iter_hooks(out):
        script = resolve_script_path(h.get("command", ""), project_root)
        if script is not None and not os.path.isfile(script):
            h["command"] = NOOP_COMMAND
    return out


# ---------------------------------------------------------------------------
# Read-only fleet audit (deliverable 3)
# ---------------------------------------------------------------------------

def _project_root_from_here() -> Path:
    # scripts/hooks/verify-hook-wiring.py -> repo root
    return Path(os.path.dirname(os.path.abspath(__file__))).parent.parent


def audit_fleet(project_root: Path) -> list:
    """Read-only census: for each agent settings.json, report wired hook scripts and
    whether each exists. Returns a list of dict rows. Mutates nothing.
    """
    rows = []
    agents_dir = project_root / "agents"
    settings_paths = []
    root_settings = project_root / ".claude" / "settings.json"
    if root_settings.is_file():
        settings_paths.append(("marveen(root)", root_settings))
    if agents_dir.is_dir():
        for name in sorted(os.listdir(agents_dir)):
            sp = agents_dir / name / ".claude" / "settings.json"
            if sp.is_file():
                settings_paths.append((name, sp))

    for agent_id, sp in settings_paths:
        try:
            with open(sp, encoding="utf-8") as f:
                settings = json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            rows.append({"agent": agent_id, "settings": str(sp), "error": str(exc)})
            continue
        # Audit resolves relative to the agent's OWN project root. Fleet convention
        # is a shared repo root, so we use project_root for $CLAUDE_PROJECT_DIR.
        res = verify_hook_wiring(settings, str(project_root))
        rows.append(
            {
                "agent": agent_id,
                "settings": str(sp),
                "hooks_with_scripts": res.checked,
                "missing": [m.script for m in res.missing],
                "brick_risk": [m.script for m in res.brick_risk],
                "ok": res.ok,
            }
        )
    return rows


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _main(argv: list) -> int:
    as_json = "--json" in argv
    project_root = _project_root_from_here()

    if "--file" in argv:
        idx = argv.index("--file")
        if idx + 1 >= len(argv):
            print("ERROR: --file requires a path", file=sys.stderr)
            return 1
        path = argv[idx + 1]
        with open(path, encoding="utf-8") as f:
            settings = json.load(f)
        res = verify_hook_wiring(settings, str(project_root))
        if as_json:
            print(json.dumps(
                {
                    "ok": res.ok,
                    "checked": res.checked,
                    "missing": [m.script for m in res.missing],
                    "brick_risk": [m.script for m in res.brick_risk],
                },
                indent=2,
            ))
        else:
            if res.ok:
                print(f"OK: {res.checked} hook script(s) present in {path}")
            else:
                print(f"REFUSE: {len(res.missing)} missing hook script(s) in {path}:")
                for m in res.missing:
                    tag = " [BRICK-RISK]" if m in res.brick_risk else ""
                    print(f"  - [{m.event}] {m.matcher!r} -> {m.script}{tag}")
        return 0 if res.ok else 2

    # Default: read-only fleet audit.
    rows = audit_fleet(project_root)
    if as_json:
        print(json.dumps(rows, indent=2))
    else:
        print(f"Hook-wiring audit (read-only) -- root={project_root}\n")
        any_missing = False
        for r in rows:
            if "error" in r:
                print(f"  {r['agent']:>16}: ERROR {r['error']}")
                continue
            status = "OK" if r["ok"] else "MISSING"
            print(
                f"  {r['agent']:>16}: {status:>7}  "
                f"scripts={r['hooks_with_scripts']}  "
                f"missing={len(r['missing'])}  brick_risk={len(r['brick_risk'])}"
            )
            if r["missing"]:
                any_missing = True
                for s in r["missing"]:
                    brick = " [BRICK-RISK]" if s in r["brick_risk"] else ""
                    print(f"      -> {s}{brick}")
        print()
        print("Land-script-first: every wired hook above must exist BEFORE the "
              "matcher is live.")
        if any_missing:
            return 2
    return 0 if all(r.get("ok", True) for r in rows) else 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
