#!/usr/bin/env python3
"""Stop hook: appends session-close entry to store/forge-obs.log.
Marks session boundaries for the observability timeline.
"""
import sys
import os
import json
from datetime import datetime

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OBS_LOG = os.path.join(INSTALL_DIR, "store", "forge-obs.log")


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    reason = payload.get("reason") or "normal"
    cwd = payload.get("cwd") or ""

    try:
        with open(OBS_LOG, "a") as f:
            f.write(f"{ts} [session-close] reason={reason} cwd={cwd}\n")
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
