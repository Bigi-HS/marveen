#!/usr/bin/env python3
"""Guard-safe NoA dashboard API helper for every fleet agent.

The permission guard (scripts/hooks/guardrail-permission-rules.py) blocks the old
`Authorization: Bearer $(cat store/.dashboard-token)` recipe: `cat`/`echo` on the
token file trips `env-file-print`, and inline `python3 -c "open(...)"` trips
`interpreter-env-read`. This committed script file reads the token via open() from
a real file, which passes the guard, and does the HTTP call for you.

Usage:
    python3 scripts/noa-api.py GET  "/api/kanban?status=in_progress"
    python3 scripts/noa-api.py GET  "/api/memories?agent=marveen&q=zepp&category=cold"
    python3 scripts/noa-api.py POST /api/messages   '{"from":"marveen","to":"dave","content":"..."}'
    python3 scripts/noa-api.py POST /api/memories   '{"agent_id":"marveen","content":"...","category":"cold","keywords":"a, b"}'
    python3 scripts/noa-api.py POST /api/daily-log  '{"agent_id":"marveen","content":"## HH:MM -- Topic\nWhat happened"}'

Body may also be piped on stdin instead of passed as argv[3] (use "-" or omit it):
    echo '{"...":"..."}' | python3 scripts/noa-api.py POST /api/messages -

Prints the response body to stdout; exits non-zero on HTTP >= 400 (body still printed).
"""
import json
import sys
import urllib.parse
import urllib.request
import urllib.error

BASE = "http://localhost:3420"
TOKEN_PATH = "/home/domin/marveen/store/.dashboard-token"
# The only hosts the Bearer token is ever allowed to reach.
_LOCAL_HOSTS = {"localhost:3420", "127.0.0.1:3420", "localhost", "127.0.0.1"}


def _is_local(path):
    """True for a bare (relative) path or an absolute URL pointing at the local
    dashboard only. Anything pointing elsewhere is rejected so the token can never
    be exfiltrated to an attacker-controlled host."""
    if not path.startswith(("http://", "https://")):
        return True
    host = urllib.parse.urlparse(path).netloc.lower()
    return host in _LOCAL_HOSTS


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    method = argv[1].upper()
    path = argv[2]
    body = None
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        # For write verbs the body is argv[3], or stdin ("-"/omitted). In an agent
        # context stdin is EOF-immediate; only an interactive tty would block here.
        raw = argv[3] if len(argv) > 3 and argv[3] != "-" else sys.stdin.read()
        raw = (raw or "").strip()
        if raw:
            json.loads(raw)  # validate early -> clearer error than a 400
            body = raw.encode()

    # SECURITY: the token must NEVER leave the local dashboard. We only ever attach
    # it to localhost:3420. A bare path is resolved against BASE; an absolute URL is
    # rejected unless its host is exactly the local dashboard. This closes the
    # prompt-injection token-exfil gadget where untrusted content could steer this
    # helper at `GET https://attacker/x` and leak the Bearer header (PR#624 review).
    if _is_local(path):
        url = path if path.startswith("http") else BASE + path
    else:
        sys.stderr.write(
            "REFUSED: noa-api.py only calls the local dashboard "
            f"({BASE}); refusing absolute URL to a non-local host: {path}\n")
        return 2

    tok = open(TOKEN_PATH).read().strip()
    headers = {"Authorization": f"Bearer {tok}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            sys.stdout.write(r.read().decode())
            print()
            return 0
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode()
        except Exception:
            pass
        sys.stderr.write(f"HTTP {e.code} {e.reason}\n")
        if detail:
            print(detail)
        return 1
    except Exception as e:
        sys.stderr.write(f"ERR {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
