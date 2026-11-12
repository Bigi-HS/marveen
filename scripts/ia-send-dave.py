#!/usr/bin/env python3
"""Inter-agent send from dave: ia-send-dave.py <to> <content-file>

Token source (in order): GENESIS_TOKEN_FILE env (a PATH to dave's own token
file, e.g. agents/dave/.genesis-token) -> GENESIS_AGENT_TOKEN env -> shared
dashboard token file. The file path takes precedence so a genuine dave send
still works when the in-process env token has gone stale after a mid-session
rotation (the running process keeps the OLD token and 401s, but the on-disk
file is fresh). Mirrors gate-approve-helper.py / open-pr-fleet.py --token-file.
"""
import json
import os
import sys
import urllib.request

DASHBOARD_TOKEN_FILE = "/home/domin/marveen/store/.dashboard-token"


def token():
    tok_file = os.environ.get("GENESIS_TOKEN_FILE")
    if tok_file:
        with open(tok_file) as f:
            # .genesis-token is "<token>\n<expiry_epoch>" -- first line only.
            return f.readline().strip()
    env = os.environ.get("GENESIS_AGENT_TOKEN")
    if env:
        return env.strip()
    with open(DASHBOARD_TOKEN_FILE) as f:
        return f.read().strip()


def main(argv):
    to_agent = argv[1]
    content = open(argv[2]).read()
    payload = {"from": "dave", "to": to_agent, "content": content}
    req = urllib.request.Request(
        "http://localhost:3420/api/messages",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token()}"},
        method="POST",
    )
    resp = urllib.request.urlopen(req)
    print(resp.status, resp.read().decode()[:200])


if __name__ == "__main__":
    main(sys.argv)
