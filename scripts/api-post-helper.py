#!/usr/bin/env python3
"""Generic API helper. Usage: python3 api-post-helper.py /api/endpoint '{"key":"value"}' [METHOD]
METHOD defaults to POST; pass PUT/PATCH/DELETE for other verbs (e.g. kanban card update)."""
import json, sys, urllib.request, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, "store/.dashboard-token")) as f:
    tok = f.read().strip()

endpoint = sys.argv[1]
payload = sys.argv[2]
method = sys.argv[3].upper() if len(sys.argv) > 3 else "POST"

req = urllib.request.Request(
    f"http://localhost:3420{endpoint}",
    data=payload.encode(),
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok},
    method=method
)
with urllib.request.urlopen(req, timeout=15) as r:
    print(r.read().decode())
