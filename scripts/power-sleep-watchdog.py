#!/usr/bin/env python3
"""
Windows AC STANDBYIDLE drift guard.
Checks that the host sleep timeout (S3) is disabled (0x00000000).
If it drifts non-zero, the entire WSL fleet could freeze on host sleep.
Runs every 6h via scheduled task power-sleep-watchdog (noa.db).
"""
import subprocess
import sys
import os
from datetime import datetime

POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
LOG_FILE = os.path.join(os.path.dirname(__file__), "../store/.power-sleep-watchdog.log")

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass

def get_ac_standbyidle():
    try:
        result = subprocess.run(
            [POWERSHELL, "-NoProfile", "-Command",
             "powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE"],
            capture_output=True, text=True, encoding="cp1250", errors="replace", timeout=15
        )
    except subprocess.TimeoutExpired:
        log("ERROR: powercfg timed out (>15s) -- skipping check")
        return None
    for line in result.stdout.splitlines():
        if "Current AC Power Setting Index" in line:
            parts = line.strip().split(":", 1)
            if len(parts) == 2:
                return parts[1].strip()
    return None

def main():
    if not os.path.exists(POWERSHELL):
        log("ERROR: powershell.exe not found -- skipping check")
        sys.exit(1)

    value = get_ac_standbyidle()
    if value is None:
        log("ERROR: could not read AC STANDBYIDLE from powercfg")
        sys.exit(1)

    if value == "0x00000000":
        log(f"OK: AC STANDBYIDLE={value} (no drift)")
        sys.exit(0)
    else:
        log(f"DRIFT DETECTED: AC STANDBYIDLE={value} (expected 0x00000000) -- host S3 sleep risk!")
        # Alert marveen via API
        try:
            import urllib.request, json
            token_path = os.path.join(os.path.dirname(__file__), "../store/.dashboard-token")
            with open(token_path) as f:
                token = f.read().strip()
            payload = json.dumps({
                "from": "forge",
                "to": "marveen",
                "content": f"ALERT: AC STANDBYIDLE drift detected! Value={value} (expected 0x00000000). Host S3 sleep risk -- WSL fleet could freeze. Manual fix: powercfg /change standby-timeout-ac 0"
            }).encode()
            req = urllib.request.Request(
                "http://localhost:3420/api/messages",
                data=payload,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
                method="POST"
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            log(f"WARNING: could not send alert: {e}")
        sys.exit(2)  # exit 2 = drift (distinguishable from exit 1 = error)

if __name__ == "__main__":
    main()
