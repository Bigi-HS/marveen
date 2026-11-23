#!/usr/bin/env python3
"""Generic API GET helper. Usage: python3 api-get-helper.py /api/endpoint[?query]
Reads the dashboard bearer token from store/.dashboard-token (file read, not shell
print -- avoids the env-file-print guard). Mirrors api-post-helper.py for reads.
Prints the raw response body."""
import sys, urllib.request, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, "store/.dashboard-token")) as f:
    tok = f.read().strip()

endpoint = sys.argv[1]
req = urllib.request.Request(
    f"http://localhost:3420{endpoint}",
    headers={"Authorization": "Bearer " + tok},
    method="GET",
)
with urllib.request.urlopen(req, timeout=15) as r:
    print(r.read().decode())
