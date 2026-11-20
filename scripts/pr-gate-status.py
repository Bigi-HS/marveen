#!/usr/bin/env python3
"""Show gate status for a PR. Guard-safe: token read from file, not inline -c.

Usage: pr-gate-status.py <pr_number>
Prints: GitHub author, mergeable_state, CI check-runs, reviews, and the fleet
gate seats from /api/gate/check?pr=NNN (the canonical gate endpoint, card cff7f17b).

The 'fleet recorded_author' line shows which agent the fleet's MG-SEC7 recusal
logic sees -- this may differ from the GitHub account shown in 'gh_author'.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

pr = sys.argv[1]
cred = open("/home/domin/.git-credentials").read().strip()
tok = re.search(r"https://[^:]+:([^@]+)@", cred).group(1)
H = {"Authorization": f"token {tok}", "Accept": "application/vnd.github+json"}
API = "https://api.github.com/repos/Bigi-HS/marveen"


def gh_get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=30))


def fleet_token() -> str:
    """Read fleet dashboard token (env > agent token file > shared token file)."""
    env = os.environ.get("GENESIS_AGENT_TOKEN")
    if env:
        return env.strip()
    tok_file = os.environ.get("GENESIS_TOKEN_FILE")
    if tok_file:
        with open(tok_file) as f:
            return f.readline().strip()
    with open("/home/domin/marveen/store/.dashboard-token") as f:
        return f.read().strip()


d = gh_get(f"{API}/pulls/{pr}")
head = d["head"]["sha"]
print(f"#{pr} {d['title']}")
print(f"  gh_author: {d['user']['login']}  state: {d['state']}  draft: {d.get('draft')}")
print(f"  head: {head}")
print(f"  base: {d['base']['ref']}  mergeable: {d.get('mergeable')}  mergeable_state: {d.get('mergeable_state')}")

# CI check-runs on head
try:
    cr = gh_get(f"{API}/commits/{head}/check-runs")
    runs = cr.get("check_runs", [])
    print(f"  check-runs ({len(runs)}):")
    for r in runs:
        print(f"    - {r['name']}: {r['status']}/{r.get('conclusion')}")
except Exception as e:
    print("  check-runs: err", e)

# reviews
try:
    rv = gh_get(f"{API}/pulls/{pr}/reviews")
    print(f"  reviews ({len(rv)}):")
    for r in rv:
        print(f"    - {r['user']['login']}: {r['state']}")
except Exception as e:
    print("  reviews: err", e)

# fleet gate seats via /api/gate/check?pr=NNN (card cff7f17b: replaced /api/github/gate-status)
try:
    dtok = fleet_token()
    req = urllib.request.Request(
        f"http://localhost:3420/api/gate/check?pr={pr}",
        headers={"Authorization": f"Bearer {dtok}"},
    )
    gs = json.load(urllib.request.urlopen(req, timeout=30))
    print(f"  fleet recorded_author: {gs.get('author', 'unknown')}")
    print(f"  fleet gate seats: pass={gs.get('pass')} required={gs.get('required')} "
          f"approved={gs.get('approved')} missing={gs.get('missing')} blocked={gs.get('blocked')}")
    print(f"    recused={gs.get('recused')} risk={gs.get('risk_level')} "
          f"ci={gs.get('ci_status')}/req={gs.get('ci_required')} "
          f"override={gs.get('override_active')} head={gs.get('head_sha','')[:8]}")
except urllib.error.HTTPError as e:
    print(f"  fleet gate seats: HTTP {e.code} {e.read().decode()[:200]}")
except Exception as e:
    print("  fleet gate seats: err", e)
