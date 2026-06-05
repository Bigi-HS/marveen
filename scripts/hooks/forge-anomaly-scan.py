#!/usr/bin/env python3
"""PostToolUse hook (Bash): scans stdout for fleet anomaly keywords and appends
to store/forge-obs.log. Passive -- never blocks.

Anomaly keywords: rapid-exit, absent, relaunching, killed, DEAD, OOM,
                  not responding, death-loop
"""
import sys
import os
import json
import re
from datetime import datetime

ANOMALY_RX = re.compile(
    r'(rapid.exit|absent|relaunching|killed|DEAD|OOM|not responding|death.loop)',
    re.IGNORECASE,
)

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OBS_LOG = os.path.join(INSTALL_DIR, "store", "forge-obs.log")


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if payload.get("tool_name") != "Bash":
        sys.exit(0)

    output = payload.get("tool_response", {})
    if isinstance(output, dict):
        text = output.get("output", "") or output.get("stdout", "") or ""
    else:
        text = str(output)

    matches = ANOMALY_RX.findall(text)
    if not matches:
        sys.exit(0)

    cmd = (payload.get("tool_input") or {}).get("command", "")[:120]
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    tags = list(dict.fromkeys(m.lower() for m in matches))

    try:
        with open(OBS_LOG, "a") as f:
            f.write(f"{ts} [anomaly] {tags} | cmd: {cmd}\n")
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
