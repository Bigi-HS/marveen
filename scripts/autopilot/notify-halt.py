#!/usr/bin/env python3
"""Autopilot halt-marker CONSUMER -- turns a throttle halt into an actual Boss-ping.

Spec: store/spec-autopilot-fleet-20261027.md section 2.1 ("halt -> STOP + Boss-ping",
lines 90/287) + INV9. This is the out-of-band consumer half of the restart-throttle:

  throttle.py trips a sticky `halted` on a crash-loop and writes a durable marker
  (store/autopilot-halt-<agent>.json, notified=false). The STOP half is already
  enforced -- a halted agent fails the throttle `check`, so wd_relaunch skips its
  relaunch. But nothing was consuming the halt, so the Boss was never told: a
  crash-looped agent would simply stay dead and SILENT. This module closes that
  gap (lesson-auto-mode-safety-net-must-be-concrete-1026: a safety net that only
  logs is nominal, not concrete).

WHERE IT RUNS (M1 / channelless mirror): the per-agent watchdogs that trip the
halt have NO Telegram channel. So this consumer runs from MARVEEN's heartbeat
(marveen owns the Boss TG channel) and scans the markers of the WHOLE fleet --
exactly like the channelless implicit-TG-kapu runs marveen-side. The heartbeat
flow is: `pending` (read-only) -> if any, relay `message` to the Boss on TG ->
`ack --all` (mark notified) ONLY AFTER the send succeeded. ack-after-send is the
safe order: a crash between send and ack re-pings (acceptable) rather than
dropping the alert (not acceptable).

Idempotency: `pending`/`message` never mutate; a halt is pinged ONCE per episode
(ack sets notified=true). throttle.py `reset` deletes the marker, so a fresh halt
after a Boss-GO recovery is a new episode and pings again.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import tempfile

STORE_DIR = os.environ.get("AUTOPILOT_STORE_DIR", "/home/domin/marveen/store")
MARKER_GLOB = "autopilot-halt-*.json"


def _marker_paths() -> list:
    return sorted(glob.glob(os.path.join(STORE_DIR, MARKER_GLOB)))


def _load(path: str) -> dict:
    try:
        with open(path) as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _atomic_save(path: str, state: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(state, fh, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _pending() -> list:
    """All halt markers not yet acknowledged, oldest first."""
    out = []
    for p in _marker_paths():
        m = _load(p)
        if not m:
            continue
        if not m.get("notified"):
            out.append({
                "agent": m.get("agent") or os.path.basename(p)[len("autopilot-halt-"):-len(".json")],
                "halted_at": m.get("halted_at"),
                "halt_reason": m.get("halt_reason"),
                "restart_count_in_window": m.get("restart_count_in_window"),
                "_path": p,
            })
    return out


def _compose_message(pending: list) -> str:
    """A plain-text Boss-ping the heartbeat relays VERBATIM to Telegram.

    Deliberately NOT MarkdownV2 (the heartbeat owns formatting/escaping if it wants);
    plain text cannot break on an unescaped reason string.
    """
    if not pending:
        return ""
    n = len(pending)
    head = ("Autopilot STOP: egy ágens crash-loop miatt leállt és NEM indul újra automatikusan "
            "(manuális reset kell)." if n == 1 else
            f"Autopilot STOP: {n} ágens crash-loop miatt leállt és NEM indul újra automatikusan "
            "(manuális reset kell).")
    lines = [head, ""]
    for p in pending:
        lines.append(f"- {p['agent']}: {p.get('halt_reason') or 'halt'} "
                     f"(újraindítások az ablakban: {p.get('restart_count_in_window', '?')})")
    lines.append("")
    lines.append("Recovery, ha rendben: python3 scripts/autopilot/throttle.py reset --agent <agent>")
    return "\n".join(lines)


def _ack(agent: str) -> bool:
    path = os.path.join(STORE_DIR, f"autopilot-halt-{agent}.json")
    m = _load(path)
    if not m:
        return False
    if m.get("notified"):
        return True  # already acked -- idempotent
    m["notified"] = True
    _atomic_save(path, m)
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("pending", help="list unacked halt markers as JSON (read-only)")
    sub.add_parser("message", help="compose the Boss-ping text for pending halts (read-only)")
    sub.add_parser("count", help="print the number of unacked halts (exit 1 if any pending)")

    pa = sub.add_parser("ack", help="mark halt(s) notified AFTER the Boss-ping was sent")
    pa.add_argument("--agent", help="ack one agent")
    pa.add_argument("--all", action="store_true", help="ack every pending halt")

    args = ap.parse_args()

    if args.cmd == "pending":
        pend = [{k: v for k, v in p.items() if k != "_path"} for p in _pending()]
        print(json.dumps(pend, ensure_ascii=False))
        return 0

    if args.cmd == "message":
        print(_compose_message(_pending()))
        return 0

    if args.cmd == "count":
        pend = _pending()
        print(len(pend))
        # exit 1 signals "there is something to ping the Boss about" so a shell
        # caller can branch without parsing JSON.
        return 1 if pend else 0

    if args.cmd == "ack":
        if args.all:
            acked = [p["agent"] for p in _pending() if _ack(p["agent"])]
            print(json.dumps({"acked": acked}, ensure_ascii=False))
            return 0
        if not args.agent:
            print(json.dumps({"error": "ack needs --agent or --all"}))
            return 2
        ok = _ack(args.agent)
        print(json.dumps({"acked": [args.agent] if ok else [], "found": ok}))
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
