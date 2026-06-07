#!/usr/bin/env python3
"""Genesis fleet status line for Claude Code (python3 port of kalmarr/claude-code-statusline).

WHY a python port: the upstream is shell+jq, and this host has no jq. python3 is
always present, so the whole thing is one dependency-free script.

Claude Code pipes one JSON object on stdin (schema: context_window, model, cost,
workspace, ...). We render a single status line to stdout. Only the first line is
shown in the TUI footer. The headline segment is the CONTEXT-WINDOW %-bar: it is
the per-pane early warning for a session ballooning toward the account/context
limit (the failure mode that froze a 634K-token opus-1M run).

Segments (per fleet spec): model | context %-bar + token count | cost | git branch.

Faithful-port notes: bar/token math is integer division to match the upstream
output exactly. used_percentage is pre-computed by Claude Code (input tokens incl.
cache), so we trust it rather than recomputing from raw token fields.
"""
import json
import os
import subprocess
import sys

# ANSI: kept raw so the TUI renders color. Tests strip these before asserting.
RESET = "\033[0m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
GREY = "\033[90m"
CYAN = "\033[36m"

SEP = f" {GREY}│{RESET} "  # " | "
BAR_WIDTH = 20


def _to_int(value, default=0):
    """Coerce a possibly-null / float / string JSON number to int, else default."""
    if value is None:
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def context_segment(ctx):
    """Render the context-window bar: [####....] NN% (used_k/size_k)."""
    pct = _to_int(ctx.get("used_percentage"), 0)
    if pct < 0:
        pct = 0
    if pct > 100:
        pct = 100
    size = _to_int(ctx.get("context_window_size"), 200000) or 200000

    filled = pct * BAR_WIDTH // 100
    empty = BAR_WIDTH - filled
    bar = "█" * filled + "░" * empty

    # Token counts derived from the percentage so the numbers match the bar.
    used_k = (pct * size // 100) // 1000
    size_k = size // 1000

    # Color escalates with fill so a ballooning pane is visible at a glance.
    if pct >= 75:
        color = RED
    elif pct >= 50:
        color = YELLOW
    else:
        color = GREEN

    return f"{color}[{bar}]{RESET} {color}{pct}%{RESET} ({used_k}k/{size_k}k)"


def git_segment(cwd):
    """Return '🌿 branch[*]' for a git repo at cwd, or '' if not a repo / on error."""
    if not cwd or not os.path.isdir(cwd):
        return ""
    try:
        inside = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"],
            capture_output=True, text=True, timeout=2,
        )
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            return ""
        branch = subprocess.run(
            ["git", "-C", cwd, "branch", "--show-current"],
            capture_output=True, text=True, timeout=2,
        ).stdout.strip()
        if not branch:
            branch = "(detached)"
        dirty = subprocess.run(
            ["git", "-C", cwd, "status", "--porcelain"],
            capture_output=True, text=True, timeout=2,
        ).stdout.strip()
        mark = "*" if dirty else ""
        return f"\U0001f33f {branch}{mark}"
    except (OSError, subprocess.SubprocessError):
        return ""


def render_statusline(data):
    """Build the status line string from the stdin JSON dict."""
    model = (data.get("model") or {}).get("display_name") or "?"
    ctx = data.get("context_window") or {}
    cost = (data.get("cost") or {}).get("total_cost_usd")
    workspace = data.get("workspace") or {}
    cwd = workspace.get("current_dir") or data.get("cwd") or ""

    segments = [
        f"\U0001f916 {CYAN}{model}{RESET}",
        context_segment(ctx),
        f"${_fmt_cost(cost):.2f}",
    ]
    git = git_segment(cwd)
    if git:
        segments.append(git)
    return SEP.join(segments)


def _fmt_cost(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    sys.stdout.write(render_statusline(data))


if __name__ == "__main__":
    main()
