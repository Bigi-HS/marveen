#!/usr/bin/env python3
"""autopilot-tick -- the deterministic wrapper run at the START of every heartbeat.

Spec: store/spec-autopilot-fleet-20261027.md section 2 (gate-PASS r4).

The point (Thor B-1..B-4): the guarantees are NOT prose for the LLM to honor.
This wrapper runs BEFORE any LLM reasoning and emits a preamble + an exit code the
LLM cannot skip:

  STUCK-GATE  (section 4)  -> EXIT 1 : abort the tick, inject nothing actionable.
  IDLE-GATE   (section 2.2) -> EXIT 0 : idle preamble only (FLAG-1: no actionable
                                         list, no action branch) when idle_ok.
  otherwise                 -> EXIT 0 : actionable preamble (mine/nudgeable +
                                         forbidden/safe lists + rotation directive).

RISKY-GATE is enforced out-of-band by the guardrail-ask-first.py hook on every
tool call (section 2.3); this wrapper only names the forbidden set in the preamble.

idle_ok is computed by classify.py (fail-safe busy on any error, INV2). Stuck/
rotation state is persistent via stuck.py (INV6). Nothing here trusts the LLM.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

ROOT = os.environ.get("MARVEEN_ROOT", "/home/domin/marveen")
HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable or "python3"

FORBIDDEN = (
    "email send, publish (YouTube/Twitch/web), file/card DELETE, deploy, git merge, "
    "external API write, kanban -> done, shared-tier memory OVERWRITE, "
    "inter-agent message carrying a deploy/delete/publish/merge INSTRUCTION"
)
SAFE = (
    "file read/search, kanban read + status ADVANCE (planned->in_progress->waiting), "
    "card CREATE, non-risky inter-agent nudge, spec/test authoring, hot/warm memo + daily log"
)


def _run_json(argv: list, fallback: dict) -> dict:
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        if out.returncode not in (0, 1):  # stuck.py uses exit 1 as a valid signal
            return fallback
        return json.loads(out.stdout.strip() or "{}")
    except Exception:  # noqa: BLE001 -- fail-safe: caller decides the safe default
        return fallback


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("agent")
    ap.add_argument("session", nargs="?", default=os.environ.get("AUTOPILOT_SESSION", "nosession"))
    ap.add_argument("--classify-args", default="", help="extra args for classify (testing)")
    args = ap.parse_args()
    agent, session = args.agent, args.session

    # --- STUCK-GATE (section 4). Persistent flag survives restart (INV6). ---
    stuck = _run_json([PY, os.path.join(HERE, "stuck.py"), "status", "--agent", agent], {})
    if stuck.get("stuck"):
        print(f"=== AUTOPILOT TICK [{agent}] :: STUCK-GATE TRIPPED (EXIT 1) ===")
        print(f"stuck=true reason={stuck.get('stuck_reason')} "
              f"ping_boss={bool(stuck.get('ping_boss'))}")
        print("DO NOT act. This agent is flagged stuck (fast loop or N-tick no-card-movement).")
        print("Token-burn is forbidden here (INV5). Diagnose, then clear explicitly:")
        print(f"  {PY} scripts/autopilot/stuck.py reset --agent {agent}")
        if stuck.get("ping_boss"):
            print("NOTE: stuck has now recurred across 2 sessions -> a Boss ping is warranted (F-6).")
        return 1

    # --- IDLE-GATE (section 2.2 / 3). Fail-safe busy on any error (INV2). ---
    classify_argv = [PY, os.path.join(HERE, "classify.py"), "--agent", agent, "--json"]
    if args.classify_args:
        classify_argv += args.classify_args.split()
    cls = _run_json(classify_argv, {"idle_ok": False, "error": "wrapper-subprocess-failed",
                                     "mine": [], "nudgeable": [], "counts": {}})

    if cls.get("idle_ok") is True:
        print(f"=== AUTOPILOT TICK [{agent}] :: idle=true (EXIT 0) ===")
        print("No actionable (MINE) and no nudgeable cards. Rest is legitimate (INV1).")
        if agent == "marveen":
            print("Before resting: confirm the last-24h Boss Telegram has no implicit task "
                  "not yet on a card (BP-01). If uncertain -> create the card first (fail-safe NUDGEABLE).")
        return 0

    # --- BUSY: actionable preamble ---
    err = cls.get("error")
    counts = cls.get("counts", {})
    print(f"=== AUTOPILOT TICK [{agent}] :: idle=false -- drive ONE card forward now ===")
    if err:
        print(f"(fail-safe BUSY: classify error -> {err}; treat as work pending, INV2)")
    print(f"counts: mine={counts.get('mine', '?')} "
          f"nudgeable={counts.get('nudgeable', '?')} parked={counts.get('parked', '?')}")

    mine = cls.get("mine", [])
    nudge = cls.get("nudgeable", [])
    if mine:
        print("\nMINE (your lane -- advance the top non-blocked card one concrete step):")
        for r in mine[:8]:
            print(f'  {r["age_d"]:5.1f}d {str(r["priority"]):7} {r["id"]} {r["title"]}')
    if nudge:
        print("\nNUDGEABLE (stale/delegated -- poke responsible, max 1x/24h then escalate):")
        for r in nudge[:8]:
            print(f'  {r["age_d"]:5.1f}d {str(r["priority"]):7} {r["id"]} '
                  f'{r["assignee"]:10} {r["title"]}')

    # --- Rotation directive (section 5 SL-01), persistent counter (FLAG-5) ---
    if mine:
        top = mine[0]["id"]
        rot = _run_json([PY, os.path.join(HERE, "stuck.py"), "rotation",
                         "--agent", agent, "--session", session, "--card", top], {})
        if rot.get("must_rotate") and len(mine) > 1:
            nxt = mine[1]
            print(f"\nROTATE: you have spent {rot.get('same_card_ticks')} ticks on {top}; "
                  f"switch to {nxt['id']} ({nxt['title']}) so urgent/high don't starve others (INV10).")

    print(f"\nFORBIDDEN (ask-first, hook-enforced): {FORBIDDEN}")
    print(f"SAFE (autonomous): {SAFE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
