#!/usr/bin/env python3
"""open-pr-fleet.py -- Open a GitHub PR via the fleet /api/github/pr endpoint.

Using the fleet endpoint records the calling agent as the PR author in the gate
system, so MG-SEC7 author-recusal fires automatically (no manual recusal or
Genesis override needed).

Usage:
  python3 scripts/open-pr-fleet.py \\
    --token-file agents/dave/.genesis-token \\
    --head feat/my-branch \\
    --title "feat: my change" \\
    --body "Description of the PR"

Optional:
  --base develop      (default: develop)
  --dashboard http://127.0.0.1:3420

Exit 0 and prints PR URL on success. Exit 1 with message on failure.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

DASHBOARD_URL = 'http://127.0.0.1:3420'


def read_agent_token(token_file: str) -> str:
    """Read the raw agent token from the genesis-token file (first line only)."""
    try:
        first_line = open(token_file).readline().strip()
    except OSError as exc:
        sys.exit(f'open-pr-fleet: cannot read token file {token_file}: {exc}')
    if not first_line:
        sys.exit(f'open-pr-fleet: token file {token_file} is empty or first line blank')
    return first_line


def open_pr(token: str, head: str, base: str | None, title: str, body: str,
            dashboard: str = DASHBOARD_URL) -> dict:
    """POST /api/github/pr and return the parsed response dict."""
    payload = {
        'head': head,
        'base': base if base else 'develop',
        'title': title,
        'body': body,
    }
    req = urllib.request.Request(
        f'{dashboard}/api/github/pr',
        data=json.dumps(payload).encode(),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        },
        method='POST',
    )
    try:
        r = urllib.request.urlopen(req, timeout=15)
        return json.loads(r.read())
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode()[:300]
        sys.exit(f'open-pr-fleet: HTTP {exc.code} from fleet API: {body_text}')
    except Exception as exc:
        sys.exit(f'open-pr-fleet: request failed: {exc}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--token-file', required=True, help='Path to .genesis-token file')
    parser.add_argument('--head', required=True, help='Source branch name')
    parser.add_argument('--base', default='develop', help='Target branch (default: develop)')
    parser.add_argument('--title', required=True, help='PR title')
    parser.add_argument('--body', default='', help='PR body/description')
    parser.add_argument('--dashboard', default=DASHBOARD_URL, help='Dashboard base URL')
    args = parser.parse_args()

    token = read_agent_token(args.token_file)
    pr = open_pr(token, head=args.head, base=args.base, title=args.title,
                 body=args.body, dashboard=args.dashboard)

    print(f"PR #{pr['number']}: {pr['html_url']}")
    print(f"head: {pr.get('head')}  base: {pr.get('base')}")
    author = pr.get('recorded_author', 'unknown')
    if pr.get('author_warning'):
        print(f"WARNING: {pr['author_warning']}")
    else:
        print(f"recorded_author: {author}")


if __name__ == '__main__':
    main()
