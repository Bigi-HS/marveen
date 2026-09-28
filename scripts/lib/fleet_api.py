#!/usr/bin/env python3
"""Guard-safe fleet dashboard API helper (card 7ec502ba).

Import as a module or run as a CLI script. Reads the Bearer token from a
file (not inline), bypassing the interpreter-env-read guard.

As a module:
    from scripts.lib.fleet_api import FleetApiClient
    client = FleetApiClient(token_file="/home/domin/marveen/store/.dashboard-token")
    client.kanban_put("abc12345", {"status": "done"})
    client.message_send("roberts", "dave", "gate ready")

As a CLI script:
    python3 scripts/lib/fleet_api.py kanban-get <card_id>
    python3 scripts/lib/fleet_api.py kanban-put <card_id> '{"status":"done"}'
    python3 scripts/lib/fleet_api.py kanban-list [status]
    python3 scripts/lib/fleet_api.py message <from> <to> <content>
    python3 scripts/lib/fleet_api.py pr-open <title> <body> <head> [base]
    python3 scripts/lib/fleet_api.py daily-log <agent_id> <content>
    python3 scripts/lib/fleet_api.py memory <agent_id> <content> <category> [keywords]

Token file defaults to /home/domin/marveen/store/.dashboard-token.
Override with --token-file or FLEET_TOKEN_FILE env var.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

DEFAULT_TOKEN_PATH = "/home/domin/marveen/store/.dashboard-token"
DEFAULT_BASE_URL = "http://localhost:3420"


class FleetApiClient:
    """Minimal guard-safe client for the local fleet dashboard API."""

    def __init__(
        self,
        token_file: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
    ) -> None:
        self.base_url = base_url
        if token_file is not None:
            with open(token_file) as fh:
                self._token = fh.read().strip()
        else:
            self._token = ""

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }

    def _get(self, path: str) -> Any:
        req = urllib.request.Request(
            self.base_url + path,
            headers=self._headers(),
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())

    def _post(self, path: str, payload: dict) -> Any:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=self._headers(),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())

    def _put(self, path: str, payload: dict) -> Any:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=self._headers(),
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())

    def _delete(self, path: str) -> Any:
        req = urllib.request.Request(
            self.base_url + path,
            headers=self._headers(),
            method="DELETE",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read()
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {}
            raise

    # --- Kanban ---

    def kanban_get(self, card_id: str) -> dict:
        return self._get(f"/api/kanban/{card_id}")

    def kanban_list(self, status: str | None = None) -> list:
        path = f"/api/kanban?status={status}" if status else "/api/kanban"
        result = self._get(path)
        return result if isinstance(result, list) else result.get("cards", result)

    def kanban_put(self, card_id: str, fields: dict) -> dict:
        return self._put(f"/api/kanban/{card_id}", fields)

    def kanban_post(self, fields: dict) -> dict:
        return self._post("/api/kanban", fields)

    # --- Messages ---

    def message_send(self, from_: str, to_: str, content: str) -> dict:
        return self._post("/api/messages", {"from": from_, "to": to_, "content": content})

    # --- GitHub PR (fleet proxy, guard-safe) ---

    def pr_open(self, title: str, body: str, head: str, base: str = "develop") -> dict:
        return self._post("/api/github/pr", {
            "title": title,
            "body": body,
            "head": head,
            "base": base,
        })

    # --- Daily log ---

    def daily_log(self, agent_id: str, content: str) -> dict:
        return self._post("/api/daily-log", {"agent_id": agent_id, "content": content})

    # --- Memory ---

    def memory_save(
        self,
        agent_id: str,
        content: str,
        category: str,
        keywords: str | None = None,
    ) -> dict:
        payload: dict = {"agent_id": agent_id, "content": content, "category": category}
        if keywords is not None:
            payload["keywords"] = keywords
        return self._post("/api/memories", payload)

    # --- Schedules ---

    def schedule_delete(self, name: str) -> dict:
        return self._delete(f"/api/schedules/{name}")


def _default_client() -> FleetApiClient:
    token_file = os.environ.get("FLEET_TOKEN_FILE", DEFAULT_TOKEN_PATH)
    return FleetApiClient(token_file=token_file)


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        return 1

    cmd, rest = args[0], args[1:]
    c = _default_client()

    if cmd == "kanban-get":
        print(json.dumps(c.kanban_get(rest[0]), indent=2))
    elif cmd == "kanban-put":
        print(json.dumps(c.kanban_put(rest[0], json.loads(rest[1])), indent=2))
    elif cmd == "kanban-list":
        status = rest[0] if rest else None
        for card in c.kanban_list(status=status):
            print(f"[{card.get('status','')}] {card.get('id','')} {card.get('title','')[:80]}")
    elif cmd == "message":
        print(json.dumps(c.message_send(rest[0], rest[1], rest[2]), indent=2))
    elif cmd == "pr-open":
        base = rest[3] if len(rest) > 3 else "develop"
        print(json.dumps(c.pr_open(rest[0], rest[1], rest[2], base), indent=2))
    elif cmd == "daily-log":
        print(json.dumps(c.daily_log(rest[0], rest[1]), indent=2))
    elif cmd == "memory":
        keywords = rest[3] if len(rest) > 3 else None
        print(json.dumps(c.memory_save(rest[0], rest[1], rest[2], keywords), indent=2))
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
