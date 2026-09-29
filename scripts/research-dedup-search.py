#!/usr/bin/env python3
"""CLI wrapper for GET /api/research-search -- FTS5 search over store/ research docs.

Used by Dr. Stone and other agents for dedup checks before adding new research entries.
Replaces the old grep-based search with an indexed, ranked API query.

Usage:
    python3 scripts/research-dedup-search.py QUERY [--limit N] [--rebuild]

Options:
    --limit N     Max results (default 10, max 50)
    --rebuild     Trigger a full index rebuild before searching

Output: one line per match: "FILENAME | SNIPPET"
Exit 0 = matches found, exit 1 = no matches, exit 2 = error.

Examples:
    python3 scripts/research-dedup-search.py "claude code skills"
    python3 scripts/research-dedup-search.py zepp --limit 5
    python3 scripts/research-dedup-search.py --rebuild n8n
"""
import sys
import json
import urllib.request
import urllib.error

BASE = "http://localhost:3420"
TOKEN_PATH = "/home/domin/marveen/store/.dashboard-token"


def _token() -> str:
    with open(TOKEN_PATH) as f:
        return f.read().strip()


def _get(path: str) -> dict:
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {_token()}"},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def _post(path: str) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=b"",
        headers={"Authorization": f"Bearer {_token()}", "Content-Length": "0"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    limit = 10
    rebuild = False
    query_parts: list[str] = []

    i = 0
    while i < len(args):
        a = args[i]
        if a == "--rebuild":
            rebuild = True
        elif a == "--limit" and i + 1 < len(args):
            i += 1
            try:
                limit = max(1, min(50, int(args[i])))
            except ValueError:
                print(f"error: --limit must be an integer, got {args[i]!r}", file=sys.stderr)
                return 2
        else:
            query_parts.append(a)
        i += 1

    query = " ".join(query_parts).strip()

    if rebuild:
        try:
            result = _post("/api/research-search/rebuild")
            print(f"Index rebuilt: {result.get('indexed', '?')} documents indexed.", file=sys.stderr)
        except urllib.error.HTTPError as e:
            print(f"Rebuild failed: HTTP {e.code}", file=sys.stderr)
            return 2

    if not query:
        if rebuild:
            return 0
        print("error: query required", file=sys.stderr)
        return 2

    import urllib.parse
    params = urllib.parse.urlencode({"q": query, "limit": limit})
    try:
        data = _get(f"/api/research-search?{params}")
    except urllib.error.HTTPError as e:
        print(f"Search failed: HTTP {e.code}", file=sys.stderr)
        return 2

    results = data.get("results", [])
    if not results:
        return 1

    for r in results:
        snippet = r.get("snippet", "").replace("\n", " ")
        print(f"{r.get('filename', '')} | {snippet}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
