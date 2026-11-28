#!/usr/bin/env python3
"""Nightly research_fts rebuild trigger (card a02dcdef / MEM-012).

The FTS5 index + rebuild logic live in the dashboard server
(src/web/routes/research-search.ts -> POST /api/research-search/rebuild,
which scans store/ for research/obsidian .md docs and repopulates
research_fts). This script is the thin scheduled-task client that fires
that endpoint nightly and reports the indexed count, so the
scout-research-fts-nightly task has a real file to call.

Exit 0 on success (prints "indexed: N"); non-zero on transport/HTTP error.
The scheduled task alerts marveen when indexed == 0 and stays silent otherwise.
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

DASH = "http://localhost:3420"
REPO_ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = REPO_ROOT / "store" / ".dashboard-token"


def main() -> int:
    try:
        token = TOKEN_FILE.read_text().strip()
    except OSError as e:
        print(f"ERROR: cannot read dashboard token ({e})", file=sys.stderr)
        return 2
    if not token:
        print("ERROR: dashboard token is empty", file=sys.stderr)
        return 2

    req = urllib.request.Request(
        DASH + "/api/research-search/rebuild",
        data=b"",  # POST with empty body
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        print(f"ERROR: rebuild endpoint returned HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"ERROR: cannot reach dashboard server ({e.reason})", file=sys.stderr)
        return 1

    indexed = body.get("indexed")
    if not body.get("ok") or indexed is None:
        print(f"ERROR: unexpected response {body}", file=sys.stderr)
        return 1
    print(f"indexed: {indexed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
