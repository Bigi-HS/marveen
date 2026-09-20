#!/usr/bin/env python3
"""Zepp health freshness surfacing poller (WELL-022, card 7e1f6628).

The GET /api/health/zepp/freshness endpoint DETECTS staleness correctly (alert:true),
but before this poller nothing SURFACED that alert: on 2026-08-26 the phone HC-push
stopped and the endpoint read alert:true for 5 days with no Telegram ping and no card
-- the classic "detection without surfacing" anti-pattern (a guard is only as good as
its wiring). This poller closes the loop: it reads the endpoint on a schedule and
relays a real alert to marveen (fleet-visible), de-duped so an ongoing gap does not
re-alert every tick.

It is also its own dead-man switch. Each successful poll stamps `last_ok_run` in the
state file; on every run it first checks that heartbeat, so if the poller (or its
runner) had fallen silent longer than the dead-man threshold, the resumed run reports
the silence -- the surfacing chain can no longer die quietly. The always-on
fleet-supervisor invokes this every 30 min (check_zepp_freshness), so a real gap
surfaces within one 30-min block (WELL-022 measurement criterion).

Behaviour mirrors scripts/todo-freshness-check.py + scripts/token-expiry-monitor.py:
pure decision cores (decide, deadman_verdict) with no IO, injected sender/persist in
main, a small JSON state file for de-duplication, and --dry-run.

    python3 scripts/zepp-freshness-check.py            # one poll + surface + heartbeat
    python3 scripts/zepp-freshness-check.py --dry-run  # report only, no send/persist
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

INSTALL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_STATE = str(INSTALL_DIR / "store" / ".zepp-freshness-state.json")
DEFAULT_TOKEN = str(INSTALL_DIR / "store" / ".dashboard-token")
FRESHNESS_URL = "http://localhost:3420/api/health/zepp/freshness"
MESSAGES_URL = "http://localhost:3420/api/messages"
# Automated ops heartbeat, not a message from Dave the engineer -- attribute to the
# ops/release agent so the fleet reads it as a monitor (overridable via --from).
DEFAULT_FROM = "forge"
DEFAULT_TO = "marveen"
# Re-alert suppression for an ongoing gap: surface once, then stay quiet for 6h.
REALERT_SUPPRESS_SECONDS = 6 * 3600
# Dead-man threshold: 2.5 missed 30-min ticks. Beyond this the poller/runner was silent.
DEADMAN_SECONDS = 75 * 60


def decide(freshness: dict, state: dict, now: float, suppress_seconds: int) -> dict:
    """Pure: turn a freshness response + prior alert state into a verdict.

    Returns {"action": "ok"|"alert"|"suppressed", "content": str|None,
             "clear_alert": bool}. A response that does not carry a boolean `alert`
    is treated as a fail-safe alert (an unparseable monitor must not read as fresh).
    `state` is not mutated; the caller persists last_alert on a sent alert.
    """
    if not isinstance(freshness, dict) or not isinstance(freshness.get("alert"), bool):
        return {
            "action": "alert",
            "clear_alert": False,
            "content": (
                "ZEPP FRESHNESS: the freshness endpoint returned an unparseable response "
                "(no boolean 'alert'). Treating as a monitor fault -- investigate "
                "/api/health/zepp/freshness."
            ),
        }

    if not freshness["alert"]:
        return {"action": "ok", "clear_alert": True, "content": None}

    reason = freshness.get("alertReason") or "Zepp data stale (no reason provided)."
    content = f"ZEPP FRESHNESS ALERT: {reason} Phone HC-push may have stopped -- check the sync."
    last_alert = float(state.get("last_alert", 0) or 0)
    if (now - last_alert) < suppress_seconds:
        return {"action": "suppressed", "clear_alert": False, "content": content}
    return {"action": "alert", "clear_alert": False, "content": content}


def deadman_verdict(
    state: dict,
    now: float,
    deadman_seconds: int,
    suppress_seconds: int = REALERT_SUPPRESS_SECONDS,
) -> dict:
    """Pure: has the poller's own heartbeat gone stale?

    Returns {"silent": bool, "silent_seconds": int|None, "suppressed": bool}. Silent
    when a prior successful run exists and the gap since it exceeds the threshold (the
    poller or its runner fell out). No prior heartbeat (first run) is NOT silent -- we
    cannot judge a poller that has never run. `suppressed` guards against re-reporting
    the same silence every tick once the resumed run has flagged it.
    """
    last_ok = state.get("last_ok_run")
    if last_ok is None:
        return {"silent": False, "silent_seconds": None, "suppressed": False}
    gap = now - float(last_ok)
    if gap <= deadman_seconds:
        return {"silent": False, "silent_seconds": int(gap), "suppressed": False}
    last_dm = float(state.get("last_deadman_alert", 0) or 0)
    suppressed = (now - last_dm) < suppress_seconds
    return {"silent": True, "silent_seconds": int(gap), "suppressed": suppressed}


def _load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _fetch_freshness(url: str, token: str, timeout: int = 20) -> dict:
    # The freshness endpoint is auth-gated (401 without a bearer), like the rest of
    # the dashboard API -- send the dashboard token.
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _send(content: str, token: str, sender: str, to: str) -> int:
    data = json.dumps({"from": sender, "to": to, "content": content}).encode()
    req = urllib.request.Request(
        MESSAGES_URL,
        data=data,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="Zepp freshness surfacing poller (WELL-022)")
    p.add_argument("--state", default=DEFAULT_STATE)
    p.add_argument("--token-file", default=DEFAULT_TOKEN)
    p.add_argument("--url", default=FRESHNESS_URL)
    p.add_argument("--from", dest="sender", default=DEFAULT_FROM)
    p.add_argument("--to", dest="to", default=DEFAULT_TO)
    p.add_argument("--suppress", type=int, default=REALERT_SUPPRESS_SECONDS)
    p.add_argument("--deadman", type=int, default=DEADMAN_SECONDS)
    p.add_argument("--dry-run", action="store_true", help="report only; never send or persist")
    p.add_argument("--now", type=float, default=None, help="override current epoch (testing)")
    args = p.parse_args(argv)

    now = args.now if args.now is not None else time.time()
    state_path = Path(args.state)
    state = {} if args.dry_run else _load_state(state_path)

    def token() -> str:
        return Path(args.token_file).read_text().strip()

    def send(content: str) -> int:
        return _send(content, token(), args.sender, args.to)

    # 1) Dead-man: did the poller/runner fall silent since the last successful run?
    dm = deadman_verdict(state, now, args.deadman, args.suppress)
    if dm["silent"] and not dm["suppressed"]:
        mins = dm["silent_seconds"] // 60
        content = (
            f"ZEPP FRESHNESS POLLER DEAD-MAN: the freshness poller was silent for ~{mins} min "
            f"(> {args.deadman // 60} min threshold). The surfacing chain may have missed a gap; "
            f"verify the fleet-supervisor tick and re-run the check."
        )
        if args.dry_run:
            print(f"[deadman] silent {dm['silent_seconds']}s -> WOULD ALERT")
        else:
            try:
                st = send(content)
                state["last_deadman_alert"] = now
                print(f"[deadman] silent {dm['silent_seconds']}s -> ALERT sent (HTTP {st})")
            except Exception as err:  # noqa: BLE001 - a monitor must never crash the cron
                print(f"[deadman] silent -> send FAILED: {err}", file=sys.stderr)
    elif dm["silent"]:
        print(f"[deadman] silent {dm['silent_seconds']}s -> suppressed")

    # 2) Poll the freshness endpoint and surface a real alert.
    try:
        freshness = _fetch_freshness(args.url, token())
    except Exception as err:  # noqa: BLE001
        # Endpoint unreachable: do NOT stamp last_ok_run (so the dead-man notices), and
        # surface the fault once (subject to suppression) via the fail-safe path.
        print(f"freshness endpoint unreachable: {err}", file=sys.stderr)
        v = decide({}, state, now, args.suppress)
        if not args.dry_run and v["action"] == "alert":
            try:
                send(v["content"])
                state["last_alert"] = now
            except Exception as err2:  # noqa: BLE001
                print(f"fault-alert send FAILED: {err2}", file=sys.stderr)
        if not args.dry_run:
            _persist(state_path, state)
        return 0

    v = decide(freshness, state, now, args.suppress)
    if v["clear_alert"]:
        state.pop("last_alert", None)

    if args.dry_run:
        print(f"[freshness] action={v['action']} alert={freshness.get('alert')}")
        if v["content"]:
            print(f"  content: {v['content']}")
    else:
        if v["action"] == "alert":
            try:
                st = send(v["content"])
                state["last_alert"] = now
                print(f"[freshness] ALERT sent (HTTP {st})")
            except Exception as err:  # noqa: BLE001
                print(f"[freshness] alert send FAILED: {err}", file=sys.stderr)
        else:
            print(f"[freshness] action={v['action']}")

    # A completed poll (endpoint reachable) is a live heartbeat.
    state["last_ok_run"] = now
    if not args.dry_run:
        _persist(state_path, state)
    return 0


def _persist(path: Path, state: dict) -> None:
    try:
        path.write_text(json.dumps(state))
    except OSError as err:
        print(f"warning: could not persist state: {err}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
