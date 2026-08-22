#!/usr/bin/env python3
"""Hibiki non-blocking interval countdown / timer.

Problem this solves: when Hibiki (the personal-trainer agent) ran a workout
countdown by calling a single foreground `sleep` from inside its Claude session,
the agent was BLOCKED on that tool call for the whole duration and could not send
the per-interval "switch now" Telegram messages until the sleep returned. From
Dominik's side it looked like Hibiki had gone silent mid-workout.

This script moves the timing OUT of the LLM loop. Hibiki launches it detached
(run_in_background / `setsid ... &`); the script does its own sleeping and posts
each phase boundary straight to Hibiki's own Telegram channel via the Bot API.
No Claude token is consumed while it counts, and the agent stays free to chat.

It reuses the verified, NON-LLM IO layer (token loading, signature loading,
Telegram sender) from hibiki-daily-push.py so the auth/privacy behaviour is
identical and lives in one place.

Privacy: like the daily push, no message body or health data is written to
stdout/stderr. Logs report phase counts and opaque kinds only.

Examples
--------
  # 4 rounds of 60s, a message at every switch (Dominik's HIIT case):
  python3 scripts/hibiki-countdown.py --rounds 4 --work 60

  # 8 rounds, 40s work / 20s rest, custom labels:
  python3 scripts/hibiki-countdown.py --rounds 8 --work 40 --rest 20 \
      --work-label "Hajra" --rest-label "Pihi" --title "Tabata kor"

  # Fully explicit phases:
  python3 scripts/hibiki-countdown.py \
      --phases "Bemelegites:120,Munka:60,Pihheno:30,Munka:60,Levezetes:90"

  # Validate without sending or sleeping:
  python3 scripts/hibiki-countdown.py --rounds 4 --work 60 --dry-run
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import os
import sys
import time

log = logging.getLogger("hibiki-countdown")

# --------------------------------------------------------------------------- #
# Reuse the daily-push IO layer (token / signature / sender) -- one auth path.
# The filename has hyphens, so it can't be a normal import; load it by path.
# --------------------------------------------------------------------------- #
_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "hibiki_daily_push", os.path.join(_HERE, "hibiki-daily-push.py")
)
_dp = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_dp)

load_token = _dp.load_token
load_signature = _dp.load_signature
telegram_sender = _dp.telegram_sender
channel_env_path = _dp.channel_env_path
default_store_root = _dp.default_store_root
store_paths = _dp.store_paths
load_json = _dp.load_json
append_signature = _dp.append_signature

WORK_EMOJI = "\U0001F7E2"   # green circle
REST_EMOJI = "\U0001F7E1"   # yellow circle
CUSTOM_EMOJI = "\U0001F535"  # blue circle
MAX_PHASES = 60             # guardrail: refuse absurd specs (would spam Telegram)
MAX_SECONDS_PER_PHASE = 3600


# --------------------------------------------------------------------------- #
# Pure logic (no IO, no sleeping -- unit tested directly)
# --------------------------------------------------------------------------- #
def build_round_phases(rounds: int, work: int, rest: int,
                       work_label: str, rest_label: str) -> list[dict]:
    """Expand --rounds/--work/--rest into an ordered phase list.

    A rest phase is inserted BETWEEN rounds only (never a trailing rest), so
    `--rounds 4 --work 60` yields exactly 4 work phases -- one switch message per
    round, which is what a HIIT interval needs.
    """
    if rounds < 1:
        raise ValueError("rounds must be >= 1")
    phases: list[dict] = []
    for i in range(1, rounds + 1):
        phases.append({"label": f"{work_label} {i}/{rounds}",
                       "seconds": work, "kind": "work"})
        if rest > 0 and i < rounds:
            phases.append({"label": rest_label, "seconds": rest, "kind": "rest"})
    return phases


def parse_explicit_phases(spec: str) -> list[dict]:
    """Parse 'label:sec,label:sec,...' into a phase list. Labels may be blank."""
    phases: list[dict] = []
    for raw in spec.split(","):
        part = raw.strip()
        if not part:
            continue
        label, sep, sec = part.rpartition(":")
        if not sep:
            raise ValueError(f"phase needs 'label:seconds', got {part!r}")
        seconds = int(sec.strip())
        phases.append({"label": label.strip() or "Fazis",
                       "seconds": seconds, "kind": "custom"})
    if not phases:
        raise ValueError("no phases parsed from --phases")
    return phases


def validate_phases(phases: list[dict]) -> None:
    """Reject empty / oversized specs so a typo can't flood Telegram."""
    if not phases:
        raise ValueError("no phases to run")
    if len(phases) > MAX_PHASES:
        raise ValueError(f"too many phases ({len(phases)} > {MAX_PHASES})")
    for p in phases:
        s = p["seconds"]
        if not (0 < s <= MAX_SECONDS_PER_PHASE):
            raise ValueError(f"phase seconds out of range: {s}")


def phase_emoji(kind: str) -> str:
    return {"work": WORK_EMOJI, "rest": REST_EMOJI}.get(kind, CUSTOM_EMOJI)


def opening_message(title: str, phases: list[dict]) -> str:
    total = sum(p["seconds"] for p in phases)
    return f"⏱️ {title}\n{len(phases)} fazis, osszesen ~{total} mp. Indul!"


def phase_message(phase: dict) -> str:
    return f"{phase_emoji(phase['kind'])} {phase['label']} - {phase['seconds']} mp"


def final_message(phases: list[dict], signature: str) -> str:
    work_rounds = sum(1 for p in phases if p["kind"] == "work")
    if work_rounds:
        body = f"✅ Vege! {work_rounds} kor kesz. Szep munka."
    else:
        body = f"✅ Vege! {len(phases)} fazis kesz. Szep munka."
    # The session-ending message carries Hibiki's exclusive signature, like the
    # daily push does. Intermediate switch messages stay short and unsigned.
    return append_signature(body, signature)


# --------------------------------------------------------------------------- #
# Orchestration (timing isolated behind injected sleep_fn / sender for tests)
# --------------------------------------------------------------------------- #
def run_countdown(phases: list[dict], sender, signature: str, title: str,
                  sleep_fn=time.sleep, dry_run: bool = False,
                  send_opening: bool = True) -> dict:
    """Run the interval timer. `sender(text)->bool` and `sleep_fn(sec)` injected.

    Sends the opening message, then for each phase a boundary message followed by
    a real sleep, then the signed closing message. Returns a log-safe summary
    (counts + kinds only). In dry-run nothing is sent and nothing sleeps; the
    built messages are returned under "messages" for inspection.
    """
    validate_phases(phases)
    sent = 0
    kinds: list[str] = []
    messages: list[str] = []

    def emit(text: str) -> None:
        nonlocal sent
        messages.append(text)
        if dry_run:
            return
        if sender(text):
            sent += 1
        else:
            log.warning("send failed (continuing the timer)")

    if send_opening:
        emit(opening_message(title, phases))

    for phase in phases:
        emit(phase_message(phase))
        kinds.append(phase["kind"])
        if not dry_run:
            sleep_fn(phase["seconds"])

    emit(final_message(phases, signature))

    summary = {"sent": sent, "phases": len(phases), "kinds": kinds,
               "dry_run": dry_run}
    if dry_run:
        summary["messages"] = messages
    log.info("countdown done: phases=%d kinds=%s", len(phases), kinds)
    return summary


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def phases_from_args(args) -> list[dict]:
    if args.phases:
        return parse_explicit_phases(args.phases)
    if args.rounds is None or args.work is None:
        raise ValueError("provide either --phases, or --rounds with --work")
    return build_round_phases(args.rounds, args.work, args.rest,
                              args.work_label, args.rest_label)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Hibiki non-blocking interval countdown (NON-LLM).")
    parser.add_argument("--rounds", type=int, default=None,
                        help="number of work rounds")
    parser.add_argument("--work", type=int, default=None,
                        help="work seconds per round")
    parser.add_argument("--rest", type=int, default=0,
                        help="rest seconds between rounds (0 = none)")
    parser.add_argument("--work-label", default="Kor", help="label for work phases")
    parser.add_argument("--rest-label", default="Pihheno", help="label for rest phases")
    parser.add_argument("--phases", default=None,
                        help="explicit 'label:sec,label:sec,...' (overrides --rounds)")
    parser.add_argument("--title", default="Visszaszamlalo", help="opening title")
    parser.add_argument("--no-opening", action="store_true",
                        help="skip the opening summary message")
    parser.add_argument("--store-root", default=None, help="override the private store path")
    parser.add_argument("--chat-id", default=None, help="override the target chat id")
    parser.add_argument("--dry-run", action="store_true",
                        help="build the plan, do not send or sleep")
    parser.add_argument("--quiet", action="store_true", help="warnings only")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    try:
        phases = phases_from_args(args)
        validate_phases(phases)
    except ValueError as exc:
        log.error("invalid countdown spec: %s", exc)
        return 2

    store_root = args.store_root or default_store_root()
    signature = load_signature(store_paths(store_root)["signature"])

    if args.dry_run:
        summary = run_countdown(phases, sender=lambda _t: True, signature=signature,
                                title=args.title, dry_run=True,
                                send_opening=not args.no_opening)
        print(json.dumps(summary, ensure_ascii=False))
        return 0

    config = load_json(store_paths(store_root)["config"], {}) or {}
    chat_id = args.chat_id or config.get("chat_id") or os.environ.get("HIBIKI_CHAT_ID")
    token = load_token(channel_env_path(store_root))
    if not token or not chat_id:
        log.error("missing telegram token or chat_id -- cannot run countdown")
        return 2

    run_countdown(phases, sender=telegram_sender(token, chat_id), signature=signature,
                  title=args.title, dry_run=False, send_opening=not args.no_opening)
    return 0


if __name__ == "__main__":
    sys.exit(main())
