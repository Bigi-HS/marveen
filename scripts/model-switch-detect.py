#!/usr/bin/env python3
"""Model-switch cache-bust detection (card 985a6264, N1 token-discipline).

Reads the agent's current model from agent-config.json and compares it against
the last known model stored in warm memory (key: config.last_model).  On a
mismatch (Boss upgraded / downgraded the model), the entire context will be
rewritten at the new model's pricing on the next turn -- this surfaces that
fact so the heartbeat can decide to run compact-first or log a note to Boss.

Exit codes:
  0  model unchanged (or first run -- no prior record)
  1  MODEL_SWITCH detected; stdout contains "MODEL_SWITCH old=X new=Y"
  2  internal error (treat as unknown, do not block heartbeat)

Stdout (last line): machine-readable token for heartbeat-preflight.
  OK model=<current>
  MODEL_SWITCH old=<prev> new=<current>
  ERROR <reason>

Usage:
  python3 scripts/model-switch-detect.py [--agent AGENT_ID] [--dry-run]
  AGENT_ID defaults to "marveen".

Design mirrors scripts/zepp-freshness-check.py (pure decide core + injected IO).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DASH = "http://localhost:3420"
TOKEN_FILE = ROOT / "store" / ".dashboard-token"
MEMORY_KEY = "config.last_model"


# ---------------------------------------------------------------------------
# Pure decision core (testable without IO)
# ---------------------------------------------------------------------------

def decide(current: str | None, stored: str | None) -> dict:
    """Compare current and stored model; return a verdict dict.

    Returns:
      {"action": "ok" | "switch" | "first_run", "old": str|None, "new": str|None,
       "message": str}

    "first_run" means no prior record exists -- not a switch, just initialise.
    If current is None (config unreadable), caller should raise before calling decide.
    """
    if stored is None:
        return {
            "action": "first_run",
            "old": None,
            "new": current,
            "message": f"first_run model={current} (storing baseline)",
        }
    if current == stored:
        return {
            "action": "ok",
            "old": stored,
            "new": current,
            "message": f"OK model={current}",
        }
    return {
        "action": "switch",
        "old": stored,
        "new": current,
        "message": f"MODEL_SWITCH old={stored} new={current}",
    }


# ---------------------------------------------------------------------------
# IO helpers
# ---------------------------------------------------------------------------

def _read_token(token_file: Path) -> str:
    return token_file.read_text().strip()


def _read_config_model(agent_id: str) -> str | None:
    """Read model from agents/<agent_id>/agent-config.json, or root agent-config.json."""
    candidates = [
        ROOT / "agents" / agent_id / "agent-config.json",
        ROOT / "agent-config.json",
    ]
    for path in candidates:
        if path.exists():
            try:
                data = json.loads(path.read_text())
                return data.get("model")
            except (OSError, ValueError):
                continue
    return None


def _fetch_stored_model(token: str, agent_id: str) -> str | None:
    """GET warm memory for config.last_model; returns stored value or None."""
    url = f"{DASH}/api/memories?agent={agent_id}&q={MEMORY_KEY}&category=warm&limit=5"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            records = json.loads(r.read().decode())
    except Exception:  # noqa: BLE001
        return None
    # Records returned by keyword search; find the exact config.last_model entry.
    for rec in records:
        kw = rec.get("keywords", "")
        content = rec.get("content", "")
        if MEMORY_KEY in kw or MEMORY_KEY in content:
            # Content format: "config.last_model=<model>"
            if "=" in content:
                return content.split("=", 1)[1].strip()
    return None


def _store_model(token: str, agent_id: str, model: str, dry_run: bool) -> None:
    """POST to warm memory to persist the new last_known_model."""
    if dry_run:
        print(f"[dry-run] would store: {MEMORY_KEY}={model}", file=sys.stderr)
        return
    payload = {
        "agent_id": agent_id,
        "content": f"{MEMORY_KEY}={model}",
        "category": "warm",
        "keywords": f"{MEMORY_KEY}, model, cache",
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{DASH}/api/memories",
        data=data,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()
    except Exception as e:  # noqa: BLE001
        print(f"[model-switch] store failed: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="Model-switch cache-bust detection")
    p.add_argument("--agent", default="marveen", help="Agent ID (default: marveen)")
    p.add_argument("--dry-run", action="store_true", help="Detect only; do not update memory")
    args = p.parse_args(argv)

    # 1. Read current model from agent-config.json
    current_model = _read_config_model(args.agent)
    if current_model is None:
        print("ERROR agent-config.json not found or missing model field")
        return 2

    # 2. Read token and fetch stored model
    try:
        token = _read_token(TOKEN_FILE)
    except OSError as e:
        print(f"ERROR token read: {e}")
        return 2

    stored_model = _fetch_stored_model(token, args.agent)

    # 3. Decide
    verdict = decide(current_model, stored_model)

    # 4. Persist if changed or first run
    if verdict["action"] in ("switch", "first_run"):
        _store_model(token, args.agent, current_model, args.dry_run)

    # 5. Emit machine-readable verdict line and exit
    print(verdict["message"])
    return 1 if verdict["action"] == "switch" else 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as e:  # noqa: BLE001
        print(f"ERROR internal: {e}")
        sys.exit(2)
