#!/usr/bin/env python3
"""Count the times the supervisor killed the orchestrator's session by prefix.

Card OPS-106. The `=` anchor fixes the call sites; this is the SIGNAL that says
whether it worked, and it reads the same log an operator would read.

The fault left a two-line fingerprint in store/fleet-supervisor.log, because
launch_dashboard() runs `kill-session` and then, on the same tick, the channels
check finds the session gone and relaunches it:

    HH:MM:SS dashboard: launched (tmux marveen -> node dist/index.js)
    HH:MM:SS channels: session marveen-channels absent -- launching

So a channels-absent event landing on the SAME SECOND as a dashboard launch is
the supervisor reporting the result of its own kill. Note what that means for
reading the log by eye: the "absent" line is not independent evidence that
channels had already died. It is the echo.

Measured on the log at the time of the fix: 401 dashboard launches, 57
channels-absent events, 47 of them on a launch second. Split by branch:

    "down -- launching"                       28 launches, 27 coincident (96%)
    "session up but :3420 not responding"    373 launches, 18 coincident  (5%)

The 5% is the tell. In that branch `marveen` usually EXISTS, so the exact match
wins and the sibling is spared; the 18 are the runs where has-session had
answered about the sibling in the first place.

Each event cost more than downtime: channels.sh deliberately starts without
--continue, so every one dropped Genesis's whole conversation. That is the
recurring "NoA forgot the conversation" symptom.

Usage:
    python3 scripts/supervisor-sibling-kill-audit.py [--log PATH] [--since YYYY-MM-DD]

With --since, exits 1 if any coincidence occurred at or after that date, so it
can run as a check after the fix ships. Without it, prints the history and exits 0.
"""
import argparse
import os
import re
import sys

DEFAULT_LOG = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "store", "fleet-supervisor.log"
)

TS = re.compile(r"^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)")
LAUNCHED = "dashboard: launched"
ABSENT = "channels: session marveen-channels absent"
NOTRESP = "session up but :3420 not responding"
DOWN_LAUNCHING = "dashboard: down -- launching"


def analyse(lines):
    launches, absents, notresp, down = set(), set(), set(), set()
    for line in lines:
        m = TS.match(line)
        if not m:
            continue
        stamp = f"{m.group(1)} {m.group(2)}"
        if LAUNCHED in line:
            launches.add(stamp)
        if ABSENT in line:
            absents.add(stamp)
        if NOTRESP in line:
            notresp.add(stamp)
        if DOWN_LAUNCHING in line:
            down.add(stamp)
    coincident = absents & launches
    return {
        "launches": launches,
        "absents": absents,
        "coincident": coincident,
        "notresp_coincident": notresp & coincident,
        "down_coincident": down & coincident,
        "notresp": notresp,
        "down": down,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--since", help="fail if a coincidence happened on or after this YYYY-MM-DD")
    args = ap.parse_args()

    try:
        with open(args.log, errors="replace") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        print(f"log not found: {args.log}", file=sys.stderr)
        return 2

    r = analyse(lines)
    print(f"dashboard launches            : {len(r['launches'])}")
    print(f"channels-absent events        : {len(r['absents'])}")
    print(f"  on a launch second (= kills): {len(r['coincident'])}")
    print(f"    via 'down -- launching'   : {len(r['down_coincident'])} of {len(r['down'])} launches")
    print(f"    via 'not responding'      : {len(r['notresp_coincident'])} of {len(r['notresp'])} launches")

    if not args.since:
        return 0

    recent = sorted(s for s in r["coincident"] if s[:10] >= args.since)
    if recent:
        print(f"\nREGRESSION: {len(recent)} sibling kill(s) on or after {args.since}:")
        for s in recent[:20]:
            print(f"  {s}")
        return 1
    print(f"\nclean since {args.since}: no channels-absent event landed on a launch second")
    return 0


if __name__ == "__main__":
    sys.exit(main())
