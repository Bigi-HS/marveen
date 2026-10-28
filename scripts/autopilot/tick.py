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

ACTIVATION GATE (freeze-carve-out, step5 item1, spec section 2.2): the wrapper can
be wired into every heartbeat while staying INERT until a Boss-gated per-agent
canary flips it on. AUTOPILOT_TICK_ENABLED default 0 (OFF), mirroring the
WD_THROTTLE_ENABLED default-0 rollout in scripts/lib/watchdog-common.sh. When OFF
(unset or != "1") the gate is the FIRST thing in main(): it prints one DISABLED line
and exits 0 with NO classify/stuck/rotation subprocess call (truly inert + cheap --
legacy heartbeat behaviour). Only the exact string "1" enables; any other value
(unset / garbage) = OFF. This is the SAFE direction (do not enable on ambiguity):
accidentally staying inert costs nothing, accidentally driving a live agent does.
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


def _canary_enabled(capability: str, agent: str) -> bool:
    """Durable per-agent canary check, fail-closed to False on ANY problem.

    Imported lazily so tick.py keeps working even if canary.py is somehow absent
    (an import failure must never enable a live driver -- it reads as OFF).
    """
    try:
        import canary  # same dir (HERE is on sys.path via the shebang invocation)
        return canary.is_enabled(capability, agent)
    except Exception:  # noqa: BLE001 -- fail-closed: unreadable canary = OFF
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("agent")
    ap.add_argument("session", nargs="?", default=os.environ.get("AUTOPILOT_SESSION", "nosession"))
    ap.add_argument("--classify-args", default="", help="extra args for classify (testing)")
    args = ap.parse_args()
    agent, session = args.agent, args.session

    # --- ACTIVATION GATE (freeze-carve-out, step5 item1, spec section 2.2). ---
    # FIRST thing after arg parsing, BEFORE any subprocess call, so OFF is truly
    # inert/cheap (no classify/stuck/rotation). Mirrors the WD_THROTTLE_ENABLED
    # default-0 rollout in scripts/lib/watchdog-common.sh.
    #
    # TWO enable sources, OR'd (canary.py / spec section 2.2): the process env var
    # AUTOPILOT_TICK_ENABLED (explicit per-process override -- buster sim + tests)
    # OR the DURABLE per-agent registry (store/autopilot-canary.json). The registry
    # is what survives a watchdog respawn / host reboot, so it -- not a transient
    # env flip -- is the real operator-facing canary. FAIL DIRECTION: only the exact
    # string "1" enables via env; unset/garbage = OFF. The registry fails closed to
    # OFF on any parse problem (canary.is_enabled). Either way, ambiguity = OFF
    # (SAFE -- never drive a live agent on ambiguity).
    env_on = os.environ.get("AUTOPILOT_TICK_ENABLED", "0") == "1"
    canary_on = _canary_enabled("tick", agent)
    if not (env_on or canary_on):
        print(f"=== AUTOPILOT TICK [{agent}] :: DISABLED (AUTOPILOT_TICK_ENABLED!=1, "
              f"not in canary registry) -- legacy heartbeat ===")
        return 0

    # --- STUCK-GATE (section 4). Persistent flag survives restart (INV6). ---
    # Thor PR#882 FLAG-1 (live-proven bypass): a genuine subprocess failure must
    # NOT read as "not stuck". An ABSENT state file is legitimate (stuck.py status
    # exits 0 printing "{}"); only a true failure (non-zero/timeout/bad-JSON) yields
    # the sentinel, and THAT fails CLOSED -- the safety gate halts rather than let a
    # possibly-stuck agent keep burning tokens (INV5, enforcement-not-convention).
    stuck = _run_json([PY, os.path.join(HERE, "stuck.py"), "status", "--agent", agent],
                      {"_unreadable": True})
    if stuck.get("stuck") or stuck.get("_unreadable"):
        print(f"=== AUTOPILOT TICK [{agent}] :: STUCK-GATE TRIPPED (EXIT 1) ===")
        if stuck.get("_unreadable"):
            print("WARN: stuck-state unreadable (subprocess failure) -> fail-CLOSED halt. "
                  "This is deliberate: the safety state could not be verified.")
        else:
            print(f"stuck=true reason={stuck.get('stuck_reason')} "
                  f"ping_boss={bool(stuck.get('ping_boss'))}")
        print("DO NOT act. This agent is flagged stuck (fast loop / N-tick no-card-movement / "
              "unverifiable state).")
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
