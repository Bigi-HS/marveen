#!/usr/bin/env python3
"""Record a gate approval via POST /api/gate/approve using the caller's own agent token.

Usage: gate-approve-helper.py <pr> <head_sha40> <reviewer> <verdict> [note]

Token source (in order): GENESIS_TOKEN_FILE env (a PATH to the agent's own token
file, e.g. agents/<id>/.genesis-token) -> GENESIS_AGENT_TOKEN env -> shared
dashboard token file. The GENESIS_TOKEN_FILE path takes precedence so a genuine
per-agent seat still works when the in-process env token has gone stale after a
mid-session reprovision/rotation (the running process keeps the OLD token and
401s, but the on-disk file is fresh). Mirrors open-pr-fleet.py --token-file.
"""
import json
import os
import sys
import urllib.error
import urllib.request

DASHBOARD_TOKEN_FILE = "/home/domin/marveen/store/.dashboard-token"


def token():
    tok_file = os.environ.get("GENESIS_TOKEN_FILE")
    if tok_file:
        with open(tok_file) as f:
            # .genesis-token is "<token>\n<expiry_epoch>" -- take the first line only.
            return f.readline().strip()
    env = os.environ.get("GENESIS_AGENT_TOKEN")
    if env:
        return env.strip()
    with open(DASHBOARD_TOKEN_FILE) as f:
        return f.read().strip()


def main(argv):
    pr = int(argv[1])
    head = argv[2]
    reviewer = argv[3]
    verdict = argv[4]
    note = argv[5] if len(argv) > 5 else None

    body = {"pr_number": pr, "head_sha": head, "reviewer": reviewer, "verdict": verdict}
    if note:
        body["note"] = note

    req = urllib.request.Request(
        "http://localhost:3420/api/gate/approve",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token()}"},
        method="POST",
    )
    try:
        r = urllib.request.urlopen(req, timeout=30)
        print(f"#{pr} {reviewer}={verdict}:", r.read().decode()[:200])
    except urllib.error.HTTPError as e:
        print(f"#{pr} HTTP {e.code}:", e.read().decode()[:300])
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv)
