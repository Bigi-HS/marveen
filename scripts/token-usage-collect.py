#!/usr/bin/env python3
"""Token usage collect -- POST /api/token-usage/collect every 15 min.

Replacement for wf-noa-001 (n8n scheduleTrigger mode-switch silent fail).
Exits 0 on HTTP 2xx, 1 on any error (triggers heartbeat alert in caller).
Run from repo root: python3 scripts/token-usage-collect.py
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

DASH = "http://localhost:3420"
TOKEN_FILE = Path(__file__).resolve().parent.parent / "store" / ".dashboard-token"


def main() -> int:
    try:
        token = TOKEN_FILE.read_text().strip()
    except OSError as e:
        print(f"token read error: {e}", file=sys.stderr)
        return 1

    req = urllib.request.Request(
        f"{DASH}/api/token-usage/collect",
        data=b"{}",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read().decode())
            ins = body.get("inserted", body.get("rows", "?"))
            upd = body.get("updated", "?")
            print(f"OK HTTP {r.status}: inserted={ins} updated={upd}")
            return 0
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
